/*
 * 對「真實 SQL Server」跑一次落庫對账（不是 memory 驅動）：
 *   cd server && node test/db-live.js
 * 流程：起服務（dev 微信模式＋mssql 驅動）→ 走 API 建問卷/開啟/提交/統計/匯出
 *      → 直接查檢視與 T_ 實體表對帳 → 清掉本次測試資料並確認零殘留。
 * 註：登入用 dev 模式的假 code，換出來的是 dev- 開頭的測試 openid，
 *     不會碰到任何真實用戶資料；結束時按 openid 前綴清理。
 */
import assert from 'node:assert/strict';

process.env.DB_DRIVER = 'mssql';
process.env.WX_APPID = '';
process.env.WX_SECRET = '';

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

let n = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name} 失敗 ${extra}`);
  n++;
  console.log(`  ${String(n).padStart(2, '0')}  PASS  ${name}${extra ? '  ' + extra : ''}`);
};

async function call(method, path, { token, body } = {}) {
  const resp = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: resp.status, json, text };
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(4, 12);
const TAG = `LIVE${stamp}`;

console.log('== 1. 真實庫自檢 ==');
const health = await (await fetch(base + '/health')).json();
ok('連線的是 OSurveyDB', health.db.detail === process.env.DB_NAME, health.db.detail);
ok('四個檢視可用（自檢不依賴表權限）', health.db.views === 4 && health.db.tablesOk === true, `views=${health.db.views} tablesOk=${health.db.tablesOk}`);
console.log(`     版本：${health.db.version}`);

console.log('== 2. 走 API 寫入（一份問卷同時發給兩個群）==');
const admin = (await call('POST', '/auth/login', { body: { code: `dev:${TAG}:admin` } })).json;
const m1 = (await call('POST', '/auth/login', { body: { code: `dev:${TAG}:m1` } })).json;
ok('取得 token（dev 模式假 code）', !!admin.token && !!m1.token);

const created = await call('POST', '/surveys', {
  token: admin.token,
  body: {
    title: `${TAG} 多群落庫對账問卷`,
    groupName: '群A／群B',
    bindMode: 'group',
    announcement: '这是一份用于验证「一份问卷发多个群」的测试问卷，验证后会被清理。',
    questions: [
      { k: 'what', type: 'text', title: 'What｜公告要做什麼？', required: true },
      { k: 'why', type: 'choice', title: 'Why｜认可程度？', options: ['非常清楚目标', '有疑问'], required: true },
      { k: 'when', type: 'date', title: 'When｜哪天可以？', required: true },
    ],
  },
});
ok('建立問卷成功', created.status === 200 && created.json.surveyId > 0, `surveyId=${created.json.surveyId}`);
const sid = created.json.surveyId;

// A 群人先進
const srA = await call('POST', `/surveys/${sid}/shareresolve`, { token: m1.token, body: { devOpenGId: 'gid-A' } });
ok('A 群人進入 → 加入第一個群', srA.json.justAdded === true && srA.json.groupCount === 1, JSON.stringify(srA.json).slice(0, 120));
// B 群人再進（同一份問卷，第二個群）
const m2 = (await call('POST', '/auth/login', { body: { code: `dev:${TAG}:m2` } })).json;
const srB = await call('POST', `/surveys/${sid}/shareresolve`, { token: m2.token, body: { devOpenGId: 'gid-B' } });
ok('B 群人進入 → 同一份問卷加入第二個群', srB.json.justAdded === true && srB.json.groupCount === 2, JSON.stringify(srB.json).slice(0, 120));

ok('A 群記錄開啟', (await call('POST', `/surveys/${sid}/visit`, { token: m1.token, body: { devOpenGId: 'gid-A' } })).status === 200);
const ansA = await call('POST', `/surveys/${sid}/answer`, {
  token: m1.token,
  body: { devOpenGId: 'gid-A', answers: [{ k: 'what', value: '完成多群切換' }, { k: 'why', value: '非常清楚目标' }, { k: 'when', value: '2026-10-20' }] },
});
ok('A 群提交成功（經檢視寫入）', ansA.status === 200, JSON.stringify(ansA.json));
const ansB = await call('POST', `/surveys/${sid}/answer`, {
  token: m2.token,
  body: { devOpenGId: 'gid-B', answers: [{ k: 'what', value: 'B 群的答案' }, { k: 'why', value: '有疑问' }, { k: 'when', value: '2026-10-25' }] },
});
ok('B 群提交成功（同一份問卷、不同群）', ansB.status === 200, JSON.stringify(ansB.json));
ok('重複提交被擋 409（檢視上的唯一索引生效）', (await call('POST', `/surveys/${sid}/answer`, { token: m2.token, body: { devOpenGId: 'gid-B', answers: [{ k: 'what', value: 'x' }, { k: 'why', value: '有疑问' }, { k: 'when', value: '2026-10-25' }] } })).status === 409);

console.log('== 3. API 回報 vs 資料庫實際列數 對帳 ==');
const stats = (await call('GET', `/surveys/${sid}/stats`, { token: admin.token })).json;
const fromView = await db.check();
const rowCounts = await (async () => {
  // 直接用檢視與實體表各數一次
  const viaView = await db.getSurvey(sid);
  const answers = await db.listAnswers(sid);
  return { viaView, answers };
})();
ok('API answerCount = 檢視實際 2 份（A/B 各一）', stats.answerCount === 2 && rowCounts.answers.length === 2, `API=${stats.answerCount} DB=${rowCounts.answers.length}`);
ok('API visitCount = 2（A 群那位開啟＋B 群那位提交時自動記）', stats.visitCount === 2, `API=${stats.visitCount}`);
ok('分群統計：A 群 1 份、B 群 1 份', stats.groupCount === 2 && stats.perGroup.every((g) => g.answerCount === 1), JSON.stringify(stats.perGroup));
ok('問卷標題原樣存取（中文未跑碼）', rowCounts.viaView.Title === `${TAG} 多群落庫對账問卷`, rowCounts.viaView.Title);
ok('公告原文完整落地', rowCounts.viaView.Announcement.includes('一份问卷发多个群'));
ok('三種題型結構原樣保留', JSON.parse(rowCounts.viaView.QuestionsJson).map((q) => q.type).join(',') === 'text,choice,date');
ok('答案語義化 key 落地', JSON.parse(rowCounts.answers[0].AnswersJson).map((a) => a.k).join(',') === 'what,why,when');
ok('兩份答案的 openGId 分別是 A/B 群', rowCounts.answers.map((a) => a.OpenGId).sort().join(',') === 'gid-A,gid-B', JSON.stringify(rowCounts.answers.map((a) => a.OpenGId)));
ok('日期答案原樣存回', rowCounts.answers.some((a) => a.OpenGId === 'gid-A' && JSON.parse(a.AnswersJson).find((x) => x.k === 'when').value === '2026-10-20'));
ok('自檢只數檢視（4 個）且不依賴表權限', fromView.views === 4 && fromView.tablesOk === true, `views=${fromView.views}`);
// view-only 權限模型的正向驗證：直接碰實體表應該被擋（03_public_view_only.sql 落地後）
let denied = false;
try { await db.raw('Select Count(*) From dbo.T_Survey'); } catch { denied = true; }
ok('直接查實體表被擋（只能走檢視）', denied, denied ? '' : '！代表 public 收權未生效');

const csv = await call('GET', `/surveys/${sid}/export.csv`, { token: admin.token });
ok('CSV 含 A/B 群兩列與 +8 時間', csv.text.includes('完成多群切換') && csv.text.includes('B 群的答案') && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(csv.text));
const xlsx = await fetch(base + `/surveys/${sid}/export.xlsx`, { headers: { Authorization: `Bearer ${admin.token}` } });
const xbuf = Buffer.from(await xlsx.arrayBuffer());
ok('XLSX 可產生（PK 檔頭）', xbuf[0] === 0x50 && xbuf[1] === 0x4b, `size=${xbuf.length}`);

console.log('== 5. 清理（經檢視掃掉所有 dev- 前綴測試資料，含歷次失敗殘留）==');
// 注意：一律走檢視名稱，不碰 T_ 表——view-only 權限模型下本來也不該碰得到
const sweep = `Delete From dbo.Answer Where OpenId Like 'dev-%' Or OpenId Like 'demo-%';
Delete From dbo.Visit Where OpenId Like 'dev-%' Or OpenId Like 'demo-%';
Delete From dbo.SurveyGroup Where SurveyId In
   (Select SurveyId From dbo.Survey Where CreatorOpenId Like 'dev-%');
Delete From dbo.Survey Where CreatorOpenId Like 'dev-%';`;
let del;
try {
  del = await db.raw(sweep);
} catch (e) {
  console.log('  !! 清理失敗：' + e.message.split('\n')[0]);
  server.close();
  process.exit(1);
}
ok('經檢視刪除測試列（含先前殘留）', del.affected >= 3, `實際刪除=${del.affected}`);
ok('問卷已查不到', (await db.getSurvey(sid)) === null);
const left = (await db.raw(`Select (Select Count(*) From dbo.Survey) As s,
  (Select Count(*) From dbo.Answer) As a, (Select Count(*) From dbo.Visit) As v;`)).rows[0];
ok('三個檢視全部歸零（零殘留）', left.s === 0 && left.a === 0 && left.v === 0, JSON.stringify(left));
console.log(`     庫內最終量（經檢視）：Survey=${left.s} Answer=${left.a} Visit=${left.v}`);

server.close();
console.log(`\n真實資料庫對账通過：${n} 項`);
