/*
 * 雲開發雲函式入口（單函式 + 路徑路由）
 *
 * 小程式端用 wx.cloud.callFunction({ name:'osurvey', data:{ method, path, query, data, shareCloudId } }) 呼叫，
 * 這裡把 event 原封不動交給 router.js，回傳 { statusCode, data }，
 * 小程式端再把它包裝成跟 wx.request 一樣的形狀 → 頁面程式碼完全不用改。
 *
 * 環境變數（雲開發控制台 → 雲函式 → osurvey → 設定）：
 *   OSURVEY_DEV=1   允許前端帶 devOpenGId 模擬群標識（只有開發／演練時才開，正式環境務必不要設）
 *   OSURVEY_DB=memory  純記憶體模式（不接資料庫），只在本機自測用
 *
 * 逾時：雲函式預設 3 秒，匯出 Excel／首次冷啟動會不夠用，
 *       請在控制台把這個函式的「逾時時間」改成 20 秒（詳見 deploy/CLOUDDEV.md）。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { createRouter } = require('./router');
const { cloudDriver } = require('./db');
const { memoryDriver } = require('./lib/memory-db');

const ALLOW_DEV_GID = process.env.OSURVEY_DEV === '1';

const db = process.env.OSURVEY_DB === 'memory'
  ? memoryDriver()
  : cloudDriver(cloud, { log: (m) => console.log(m) });

// 新集合（web_user / web_bind / answer_archive）在第一次冷啟動時自動建立。
const ensureCollectionsReady = typeof db.ensureCollections === 'function'
  ? db.ensureCollections().catch((e) => console.warn('[osurvey] 建立集合失敗：', (e && e.message) || e))
  : Promise.resolve();

// 群分享資料：小程式端把 wx.cloud.CloudID(...) 放在 event 最上層，
// 微信會在進入雲函式前就把 openGId 解好（event.shareCloudId = { cloudID, data:{ openGId } }）。
// 若前端只傳了 cloudID 字串，這裡再用 cloud.getOpenData 補一次。
async function resolveOpenData(value) {
  if (!value) return null;
  if (typeof value === 'object' && value.data) return value.data;
  const id = typeof value === 'string' ? value : value.cloudID;
  if (!id) return null;
  const res = await cloud.getOpenData({ list: [id] });
  const first = res && res.list && res.list[0];
  return (first && first.data) || null;
}

// 生成「掃碼進入問卷」的小程式碼：走雲調用（cloud.openapi），不需要 access_token／appsecret。
// 未認證帳號無法「被分享」，二維碼是唯一能把問卷發給別人的方式（搭配「開放作答」模式）。
async function genWxacode({ page, scene, envVersion }) {
  const res = await cloud.openapi.wxacode.getUnlimited({
    page,
    scene,
    width: 430,
    checkPath: false,
    envVersion: envVersion || 'release',
  });
  if (!res || !res.buffer) {
    throw new Error('雲調用 wxacode.getUnlimited 沒回圖片：' + JSON.stringify(res || {}));
  }
  return res.buffer;
}

// 用戶輸入內容安全檢測（問卷標題／公告／題目／答案都是 UGC）。
// 雲調用失敗（權限未開、網路問題）時先放行並記 log，避免整個小程序不可用；
// 明確判定 risky（v2 的 result.suggest 或 v1 的 errCode 87014）才攔截。
async function checkContent({ content, openid, scene = 2 }) {
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: String(content || ''),
      version: 2,
      scene,
      openid,
    });
    const result = (res && res.result) || {};
    return {
      ok: result.suggest !== 'risky',
      suggest: result.suggest || 'pass',
      label: result.label || 0,
    };
  } catch (e) {
    if (e && Number(e.errCode) === 87014) return { ok: false, suggest: 'risky', label: 87014 };
    console.warn('[osurvey] msgSecCheck 失敗，先放行：', (e && (e.errMsg || e.message)) || e);
    return { ok: true, suggest: 'unknown', error: true };
  }
}

const router = createRouter({
  db,
  resolveOpenData,
  allowDevGid: ALLOW_DEV_GID,
  genWxacode,
  checkContent,
  log: (m) => console.log(m),
});

exports.main = async (event) => {
  await ensureCollectionsReady;
  const wxCtx = (() => { try { return cloud.getWXContext() || {}; } catch (e) { return {}; } })();
  // 小程序呼叫時微信會注入真實 openid，必須優先採用；否則前端只要在 data 裡帶 openid
  // 就能冒充任何人。CloudRun 代理呼叫沒有微信用戶上下文，才退回 event.openid。
  const openid = wxCtx.OPENID || (event && event.openid) || '';
  const result = await router.handle({ ...(event || {}), openid });
  return result;
};
