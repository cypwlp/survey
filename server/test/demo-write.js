/*
 * 現場示範：真的建問卷 → 真的答一份 → 從 SQL Server 撈出實際資料
 *   cd server && node test/demo-write.js
 * 結束會問你要不要留著或清掉（預設：保留，讓你看著它存在）
 */
process.env.DB_DRIVER = 'mssql';
process.env.WX_APPID = '';
process.env.WX_SECRET = '';

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

const call = async (method, path, body, token) => {
  const resp = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: resp.status, json, text };
};

// 1) 兩個人（管理員 + 一位成員）
const admin = (await call('POST', '/auth/login', { code: 'demo-admin' })).json;
const member = (await call('POST', '/auth/login', { code: 'demo-member-1' })).json;
console.log(`管理員 openid：${admin.openid}`);
console.log(`成員1  openid：${member.openid}`);

// 2) 管理員建問卷（內容照你的實際場景）
const created = await call('POST', '/surveys', {
  title: '10 月生產流程變更公告',
  groupName: 'Topmix 生產部群',
  bindMode: 'open',
  announcement: '各位同仁：自 10 月 20 日起全面改用新流程，舊表單不再受理。請於 10/18 前完成交接。',
  questions: [
    { k: 'what', type: 'text', title: 'What｜這個公告的核心變更是什麼？', required: true },
    { k: 'when', type: 'date', title: 'When｜你打算／需要哪天完成交接？', required: true },
    { k: 'where', type: 'text', title: 'Where｜影響哪些製程或地點？', required: true },
    { k: 'why', type: 'choice', title: 'Why｜你對這次變更目標的認可程度？', options: ['非常清楚目標', '大致清楚', '有疑問'], required: true },
    { k: 'how', type: 'text', title: 'How│你預計怎麼配合？', required: false },
  ],
}, admin.token);
console.log(`\n建立問卷 → HTTP ${created.status}，surveyId = ${created.json.surveyId}`);
const sid = created.json.surveyId;

// 3) 成員從「群卡片」進來（這支用的是 dev 模擬的 shareTicket 路徑）
await call('POST', `/surveys/${sid}/visit`, { devOpenGId: 'gid-demo-group' }, member.token);
await call('POST', `/surveys/${sid}/answer`, {
  devOpenGId: 'gid-demo-group',
  answers: [
    { k: 'what', value: '全面換新流程，舊表單停用' },
    { k: 'when', value: '2026-10-18' },
    { k: 'where', value: 'CNC 線與組裝線' },
    { k: 'why', value: '非常清楚目標' },
    { k: 'how', value: '照新 SOP 作業，並協助上線' },
  ],
}, member.token);

// 4) 直接從 SQL Server 撈實際資料（走檢視，這是 view-only 模型唯一允許的路徑）
const rows = (await db.raw(`Select SurveyId, Title, GroupName, OpenGId, BindMode, Announcement, CreatorOpenId,
  QuestionsJson, IsClosed, CreateTime, UpdateTime From dbo.Survey Where SurveyId = @sid;`, { sid })).rows[0];
const ans = (await db.raw(`Select AnswerId, SurveyId, OpenId, OpenGId, AnswersJson, SubmitTime
  From dbo.Answer Where SurveyId = @sid;`, { sid })).rows;

console.log(`\n──── 以下是從 OSurveyDB 撈回來的事實 ────`);
console.log(`[dbo.Survey 檢視] 列數＝${rows ? 1 : 0}`);
if (rows) {
  console.log(`  SurveyId      : ${rows.SurveyId}`);
  console.log(`  Title         : ${rows.Title}`);
  console.log(`  GroupName     : ${rows.GroupName}（管理員手動輸入，微信不開放讀取）`);
  console.log(`  OpenGId       : ${rows.OpenGId}（進入即綁定的群標識）`);
  console.log(`  BindMode      : ${rows.BindMode}`);
  console.log(`  CreatorOpenId : ${rows.CreatorOpenId}`);
  console.log(`  CreateTime    : ${rows.CreateTime.toISOString()}（UTC）`);
  console.log(`  Announcement  : ${rows.Announcement}`);
}
console.log(`[dbo.Answer 檢視] 列數＝${ans.length}`);
for (const a of ans) {
  console.log(`  AnswerId      : ${a.AnswerId}`);
  console.log(`  OpenId        : ${a.OpenId}`);
  console.log(`  OpenGId       : ${a.OpenGId}`);
  console.log(`  SubmitTime    : ${a.SubmitTime.toISOString()}`);
  console.log(`  AnswersJson   : ${a.AnswersJson}`);
}

// 5) 統計與匯出也當場跑一遍
const stats = (await call('GET', `/surveys/${sid}/stats`, null, admin.token)).json;
console.log(`\n[API 回報的統計] 開啟數=${stats.visitCount} 提交數=${stats.answerCount} 提交率=${stats.visitCount ? Math.round(stats.answerCount / stats.visitCount * 100) : '—'}%`);
const csv = await call('GET', `/surveys/${sid}/export.csv`, null, admin.token);
console.log(`[CSV 前 3 行]`);
for (const l of csv.text.split('\r\n').slice(0, 3)) console.log('  ' + l.replace(/^\uFEFF/, ''));

server.close();
console.log(`\n完成。資料現在還在庫裡（surveyId=${sid}），要清掉跟我說一聲。`);
