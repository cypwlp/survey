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

const router = createRouter({
  db,
  resolveOpenData,
  allowDevGid: ALLOW_DEV_GID,
  log: (m) => console.log(m),
});

exports.main = async (event) => {
  const wxCtx = (() => { try { return cloud.getWXContext() || {}; } catch (e) { return {}; } })();
  const openid = (event && event.openid) || wxCtx.OPENID || '';
  const result = await router.handle({ ...(event || {}), openid });
  return result;
};
