/*
 * MySQL 驅動實測（真的要有一個 MySQL 才能跑）
 *   cd server && cmd /c "node test/db-mysql-live.js"
 * 連線參數吃 .env 或環境變數：DB_DRIVER=mysql、DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
 * （本檔會自己把 DB_DRIVER 蓋成 mysql，不必先改 .env。）
 * 安全性：只新增／查詢自己建立的 mtest- 資料，跑完自動刪掉自己的殘留，
 *        不會刪改任何既有問卷（真庫保護原則）。
 */
import assert from 'node:assert/strict';

process.env.DB_DRIVER = 'mysql';
const { db, checkDb } = await import('../src/db.js');
const { config } = await import('../src/config.js');

const TAG = 'mtest-' + Date.now().toString(36);
const CREATOR = TAG + '-creator';
const GROUP = TAG + '-gid';
const Q = [
  { k: 'q1', type: 'text', title: '第一題', required: true },
  { k: 'q2', type: 'choice', title: '第二題', options: ['甲', '乙'], required: true },
];
const Q2 = [Q[1], Q[0]];   // 重排後

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name} 失敗 ${extra}`);
  passed++;
  console.log(`  PASS  ${name}`);
};

console.log(`目標：MySQL ${config.db.host}:${config.db.port}/${config.db.database}（user=${config.db.user}）`);

const state = await checkDb();
if (!state.ok) {
  console.error(`  X 連不上 MySQL：${state.detail}`);
  console.error('    檢查 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME 是否正確。');
  process.exit(1);
}
if (!state.tablesOk) {
  console.error(`  X 資料表不就緒（只找到 ${state.tables}/5 張）。`);
  console.error('    先在這個庫執行 database/06_mysql_schema.sql，再重跑本測試。');
  process.exit(1);
}
ok('check() 連線與五張表就緒', state.ok && state.tablesOk, JSON.stringify(state));
console.log(`  目前庫內筆數：Survey=${state.rows.Survey} Answer=${state.rows.Answer} Visit=${state.rows.Visit}（測試不碰這些）`);

let surveyId = 0;
try {
  surveyId = await db.createSurvey({
    title: 'MySQL 實測問卷',
    groupName: 'mtest 群',
    bindMode: 'group',
    announcement: '測試用',
    questionsJson: JSON.stringify(Q),
    creatorOpenId: CREATOR,
  });
  ok('createSurvey 回傳自增 SurveyId', Number.isInteger(surveyId) && surveyId > 0, `id=${surveyId}`);

  const s1 = await db.getSurvey(surveyId);
  ok('getSurvey 讀回標題與題目', s1 && s1.Title === 'MySQL 實測問卷' && JSON.parse(s1.QuestionsJson).length === 2);
  ok('getSurvey 時間是 ISO（帶 Z）', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(s1.CreateTime)), String(s1.CreateTime));

  ok('updateSurveyQuestions 回 true', await db.updateSurveyQuestions(surveyId, JSON.stringify(Q2)) === true);
  const s2 = await db.getSurvey(surveyId);
  ok('重排後題序正確', JSON.parse(s2.QuestionsJson).map((q) => q.k).join(',') === 'q2,q1');
  ok('重排不動標題內容', s2.Title === s1.Title);

  const mine = (await db.listSurveys(CREATOR)).find((x) => x.SurveyId === surveyId);
  ok('listSurveys 找得到且計數為 0', !!mine && Number(mine.AnswerCount) === 0 && Number(mine.VisitCount) === 0);

  ok('bindGroup 首次成功', await db.bindGroup(surveyId, GROUP) === true);
  ok('bindGroup 第二次不覆寫', await db.bindGroup(surveyId, GROUP + '-2') === false);
  ok('clearGroup 回 true', await db.clearGroup(surveyId) === true);
  ok('clearGroup 後 OpenGId 為空', (await db.getSurvey(surveyId)).OpenGId === null);

  ok('bindSurveyGroup 首次成功', await db.bindSurveyGroup(surveyId, GROUP) === true);
  ok('bindSurveyGroup 重複回 false', await db.bindSurveyGroup(surveyId, GROUP) === false);
  const gs = await db.listSurveyGroups(surveyId);
  ok('listSurveyGroups 只有一筆', gs.length === 1 && gs[0].OpenGId === GROUP && !!gs[0].FirstSeenAt);

  await db.touchGroupNames(CREATOR, ['mtest 群']);
  await db.touchGroupNames(CREATOR, ['mtest 群']);
  const names = await db.listGroupNames(CREATOR, 10);
  ok('群名歷史累計次數（不是重複列）', names.length === 1 && Number(names[0].UseCount) === 2, JSON.stringify(names));

  ok('saveVisit 首次回 true', await db.saveVisit(surveyId, CREATOR, GROUP) === true);
  ok('saveVisit 第二次回 false', await db.saveVisit(surveyId, CREATOR, GROUP) === false);
  ok('countVisits 為 1', (await db.countVisits(surveyId)) === 1);

  const ins = await db.insertAnswer({
    surveyId,
    openid: CREATOR,
    openGId: GROUP,
    answersJson: JSON.stringify([{ k: 'q2', value: '甲' }, { k: 'q1', value: '測試' }]),
  });
  ok('insertAnswer 回 AnswerId 與時間', ins && Number(ins.AnswerId) > 0 && !!ins.SubmitTime, JSON.stringify(ins));

  let dup = null;
  try { await db.insertAnswer({ surveyId, openid: CREATOR, openGId: GROUP, answersJson: '[]' }); } catch (e) { dup = e; }
  ok('同問卷同 openid 重複提交丟 DUPLICATE', dup && dup.code === 'DUPLICATE', dup && dup.message);

  const a1 = await db.getAnswer(surveyId, CREATOR);
  ok('getAnswer 讀回答案解析正確', a1 && JSON.parse(a1.AnswersJson).find((x) => x.k === 'q2').value === '甲');

  const all = await db.listAnswers(surveyId);
  ok('listAnswers 一筆且時間是 ISO', all.length === 1 && /Z$/.test(String(all[0].SubmitTime)));

  ok('setClosed(true) 回 true', await db.setClosed(surveyId, true) === true);
  ok('setClosed 後 IsClosed 為真', !!(await db.getSurvey(surveyId)).IsClosed);
  ok('重複 setClosed(true) 仍回 true（不會誤判成找不到）', await db.setClosed(surveyId, true) === true);

  ok('clearSurveyGroup 回 true', await db.clearSurveyGroup(surveyId) === true);
  ok('清空後群綁定為 0 筆', (await db.listSurveyGroups(surveyId)).length === 0);
} finally {
  // 只清自己：Answer/Visit/SurveyGroup 先刪（有外鍵），再刪 Survey 與群名
  await db.raw('Delete From Answer Where SurveyId In (Select SurveyId From Survey Where CreatorOpenId = ?);', [CREATOR]);
  await db.raw('Delete From Visit Where SurveyId In (Select SurveyId From Survey Where CreatorOpenId = ?);', [CREATOR]);
  await db.raw('Delete From SurveyGroup Where SurveyId In (Select SurveyId From Survey Where CreatorOpenId = ?);', [CREATOR]);
  await db.raw('Delete From Survey Where CreatorOpenId = ?;', [CREATOR]);
  await db.raw('Delete From GroupName Where OpenId = ?;', [CREATOR]);
}

const left = await db.raw(
  `Select (Select Count(*) From Survey Where CreatorOpenId = ?) As s,
          (Select Count(*) From GroupName Where OpenId = ?) As n;`,
  [CREATOR, CREATOR],
);
ok('測試殘留已清乾淨', Number(left.rows[0].s) === 0 && Number(left.rows[0].n) === 0, JSON.stringify(left.rows[0]));

console.log(`\nMySQL 驅動實測：${passed} 項全過`);
process.exit(0);
