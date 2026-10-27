/*
 * 雲函式本機自測（不需要雲環境、不需要開發者工具）：
 *     cd cloudfunctions/osurvey && node test/local-smoke.js
 * 用記憶體驅動把 router.js 的每一條路徑跑一遍，確認「搬上雲」前邏輯是對的。
 * 上雲之後要驗真的雲環境，改用雲開發控制台 → 雲函式 → osurvey → 雲端測試，
 * 參數填 {"method":"GET","path":"/health"}（清單見 deploy/CLOUDDEV.md 第 7 節）。
 */
const { createRouter } = require('../router');
const { memoryDriver } = require('../lib/memory-db');
const { defaultQuestions } = require('../lib/questions');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); }
}

const db = memoryDriver();
// 假的小程序碼生成器：真的那條走雲調用（cloud.openapi.wxacode.getUnlimited），本機測試只驗參數傳遞。
const fakeWxacode = async ({ page, scene, envVersion }) => Buffer.from(`PNG:${page}|${scene}|${envVersion}`);
// 假的内容安全检测：只把 BADWORD 判成 risky，用来验证路由有没有把用户输入送检
const fakeCheckContent = async ({ content }) => ({ ok: !String(content).includes('BADWORD'), suggest: 'pass' });
const router = createRouter({
  db,
  resolveOpenData: async (v) => (v && v.data) || null,
  allowDevGid: true,
  genWxacode: fakeWxacode,
  checkContent: fakeCheckContent,
  log: () => {},
});

const call = (openid, method, path, data, extra) => router.handle({
  openid, method, path, query: {}, data: data || {}, ...(extra || {}),
});

async function main() {
  const A = 'oA';   // 管理員
  const B = 'oB';   // 回答者
  const C = 'oC';   // 路人

  console.log('\n[1] 建問卷與清單');
  let r = await call(A, 'GET', '/auth/whoami');
  check('whoami 回 openid', r.statusCode === 200 && r.data.openid === A, r.data);

  r = await call(A, 'POST', '/surveys', { title: '', questions: defaultQuestions() });
  check('缺標題 → 400', r.statusCode === 400, r);

  r = await call(A, 'POST', '/surveys', { title: '結合劑使用確認', questions: defaultQuestions() });
  const surveyId = r.data.surveyId;
  check('建問卷回 surveyId=1', r.statusCode === 200 && surveyId === 1, r.data);

  r = await call(A, 'POST', '/surveys', { title: 'x', questions: [{ k: 'a', type: 'choice', title: 't', options: ['只有一個'] }] });
  check('選擇題只有 1 個選項 → 400', r.statusCode === 400, r.data);

  r = await call(A, 'POST', '/surveys', { title: 'x', questions: [{ k: 'a', type: 'text', title: 't' }, { k: 'a', type: 'text', title: 'u' }] });
  check('題目 key 重複 → 400', r.statusCode === 400, r.data);

  r = await call(A, 'GET', '/surveys');
  check('我的問卷清單 1 筆', r.statusCode === 200 && r.data.list.length === 1 && r.data.list[0].AnswerCount === 0, r.data);

  console.log('\n[2] 群名歷史');
  r = await call(A, 'POST', '/groupnames', { names: ['研發一群', '研發一群', '品保群'] });
  check('群名去重後存 2 筆', r.statusCode === 200 && r.data.names.length === 2, r.data.names);
  r = await call(A, 'GET', '/groupnames');
  check('群名清單讀得回來', r.statusCode === 200 && r.data.list.length === 2, r.data.list);
  r = await call(B, 'GET', '/groupnames');
  check('別人的群名清單是空的', r.data.list.length === 0, r.data.list);
  r = await call(A, 'POST', '/groupnames', { names: ['臨時群'] });
  check('新增臨時群名', r.statusCode === 200 && r.data.names.includes('臨時群'), r.data);
  r = await call(A, 'POST', '/groupnames/delete', { names: ['臨時群'] });
  check('刪除常用群名', r.statusCode === 200 && !r.data.names.includes('臨時群'), r.data);

  console.log('\n[3] 從群卡片進入（CloudID 路徑）');
  r = await call(B, 'POST', `/surveys/${surveyId}/shareresolve`, {}, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  check('shareresolve 解出 openGId', r.statusCode === 200 && r.data.openGId === 'GID-A', r.data);
  check('第一個群自動加入問卷', r.data.justAdded === true && r.data.groupCount === 1, r.data);

  r = await call(B, 'POST', `/surveys/${surveyId}/shareresolve`, {}, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  check('同一群再進來不會重複加', r.data.justAdded === false && r.data.knownGroup === true && r.data.groupCount === 1, r.data);

  r = await call(B, 'POST', `/surveys/${surveyId}/shareresolve`, {}, { shareCloudId: { cloudID: 'cid2', data: { openGId: 'GID-B' } } });
  check('第二個群也能加入（多群模型）', r.data.justAdded === true && r.data.groupCount === 2, r.data);

  r = await call(B, 'POST', `/surveys/${surveyId}/shareresolve`, {});
  check('沒有分享資訊 → 422', r.statusCode === 422, r.data);

  console.log('\n[4] 開啟、作答、去重');
  r = await call(B, 'POST', `/surveys/${surveyId}/visit`, {}, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  check('記一次開啟', r.statusCode === 200, r.data);
  r = await call(B, 'POST', `/surveys/${surveyId}/visit`, {}, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  r = await call(A, 'GET', `/surveys/${surveyId}/stats`, {});
  check('同人重複開啟只算 1 次', r.data.visitCount === 1, r.data.visitCount);

  const answers = defaultQuestions().map((q) => ({ k: q.k, value: q.type === 'choice' ? q.options[0] : (q.type === 'date' ? '2026-10-20' : '測試內容 結合劑') }));
  const bad = answers.map((a) => (a.k === 'why' ? { k: 'why', value: '不存在的選項' } : a));
  r = await call(B, 'POST', `/surveys/${surveyId}/answer`, { answers: bad }, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  check('選項不在範圍 → 400', r.statusCode === 400, r.data);

  const missing = answers.filter((a) => a.k !== 'what');
  r = await call(B, 'POST', `/surveys/${surveyId}/answer`, { answers: missing }, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  check('必填未作答 → 400', r.statusCode === 400, r.data);

  r = await call(B, 'POST', `/surveys/${surveyId}/answer`, { answers: {} }, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  check('沒帶答案 → 400', r.statusCode === 400, r.data);

  r = await call(B, 'POST', `/surveys/${surveyId}/answer`, { answers }, {});
  check('群模式沒帶分享資訊 → 422', r.statusCode === 422, r.data);

  r = await call(B, 'POST', `/surveys/${surveyId}/answer`, { answers }, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  check('正常提交成功', r.statusCode === 200 && r.data.ok === true, r.data);

  r = await call(B, 'POST', `/surveys/${surveyId}/answer`, { answers }, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  check('同一人再提交 → 409 一人限一份', r.statusCode === 409, r.data);

  r = await call(A, 'GET', `/surveys/${surveyId}`, {});
  check('建立者看得到 isCreator/isClosed', r.data.isCreator === true && r.data.isClosed === false, r.data.isCreator);
  check('問卷詳情帶題目與群清單', r.data.questions.length === 5 && r.data.groups.length === 2, r.data.groups);

  console.log('\n[5] 題目排序');
  const order = ['when', 'what', 'why', 'where', 'how'];
  r = await call(A, 'POST', `/surveys/${surveyId}/reorder`, { order });
  check('重排成功且第一題換成 when', r.statusCode === 200 && r.data.questions[0].k === 'when', r.data.questions && r.data.questions[0]);

  r = await call(A, 'POST', `/surveys/${surveyId}/reorder`, { order: ['what'] });
  check('題目清單不一致 → 400', r.statusCode === 400, r.data);

  r = await call(B, 'POST', `/surveys/${surveyId}/reorder`, { order });
  check('非建立者不能重排 → 403', r.statusCode === 403, r.data);

  r = await call(A, 'GET', `/surveys/${surveyId}/stats`, {});
  check('重排後答案仍以 k 對應（what 有值）', r.data.questions.find((q) => q.k === 'what').answerCount === 1, r.data.questions.map((q) => [q.k, q.answerCount]));

  console.log('\n[6] 統計與匯出');
  r = await call(A, 'GET', `/surveys/${surveyId}/stats`, {});
  const q = r.data.questions.find((x) => x.k === 'why');
  check('選項分佈統計正確', r.data.answerCount === 1 && q.distribution[0].count === 1 && q.distribution[0].pct === 100, q.distribution);
  const w = r.data.questions.find((x) => x.k === 'what');
  check('高頻詞有抓到「結合」', w.words.some((x) => x.w === '結合'), w.words);
  check('統計帶群組分佈', r.data.perGroup.length === 2 && r.data.perGroup.find((g) => g.openGId === 'GID-A').answerCount === 1, r.data.perGroup);

  r = await call(B, 'GET', `/surveys/${surveyId}/stats`, {});
  check('非建立者看統計 → 403', r.statusCode === 403, r.data);

  r = await call(A, 'GET', `/surveys/${surveyId}/export.csv`, {});
  check('CSV 匯出有表頭與資料列', r.statusCode === 200 && typeof r.data === 'string' && r.data.includes('提交时间') && r.data.split('\r\n').length === 2, typeof r.data === 'string' ? r.data.slice(0, 120) : r.data);

  r = await call(A, 'GET', `/surveys/${surveyId}/export.xlsx`, {});
  let xlsxOk = false;
  if (r.statusCode === 200 && r.data && r.data.base64) {
    const buf = Buffer.from(r.data.base64, 'base64');
    xlsxOk = buf.length > 1000 && buf.slice(0, 2).toString() === 'PK';
  } else if (r.statusCode === 500 && /Cannot find module/.test(r.data.error || '')) {
    xlsxOk = 'skip';
  }
  check('XLSX 匯出（PK zip 檔頭）', xlsxOk === true || xlsxOk === 'skip', xlsxOk === 'skip' ? '沒裝 exceljs，跳過' : r.data);

  console.log('\n[7] 關閉與解綁');
  r = await call(A, 'POST', `/surveys/${surveyId}/close`, { closed: true });
  check('關閉問卷', r.statusCode === 200 && r.data.isClosed === true, r.data);
  r = await call(C, 'POST', `/surveys/${surveyId}/answer`, { answers }, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  check('已結束的問卷不能作答 → 409', r.statusCode === 409, r.data);
  r = await call(A, 'POST', `/surveys/${surveyId}/unbind`, {});
  check('解除全部群綁定', r.statusCode === 200, r.data);
  r = await call(A, 'GET', `/surveys/${surveyId}`, {});
  check('解綁後群清單空了', r.data.groups.length === 0 && r.data.hasGroupBound === false, r.data.groups);

  console.log('\n[8] 開放作答模式 + 開發模式群標識');
  r = await call(A, 'POST', '/surveys', { title: '開放問卷', bindMode: 'open', questions: defaultQuestions() });
  const openId2 = r.data.surveyId;
  r = await call(C, 'POST', `/surveys/${openId2}/answer`, { answers, devOpenGId: 'dev-gid' });
  check('open 模式沒分享資訊也能交（dev 模式帶 devOpenGId）', r.statusCode === 200, r.data);
  r = await call(A, 'GET', `/surveys/${openId2}/stats`, {});
  check('open 問卷也統計得到', r.data.answerCount === 1, r.data.answerCount);

  console.log('\n[9] 權限與邊界');
  r = await call(C, 'GET', `/surveys/${surveyId}/stats`, {});
  check('非建立者 → 403', r.statusCode === 403, r.data);
  r = await call(C, 'GET', '/surveys/9999', {});
  check('不存在的問卷 → 404', r.statusCode === 404, r.data);
  r = await call(A, 'GET', '/nope', {});
  check('未知路徑 → 404', r.statusCode === 404, r.data);
  r = await call(A, 'GET', `/surveys/${surveyId}`, {});
  check('建立者可以讀自己的問卷', r.statusCode === 200, r.data);

  console.log('\n[10] 資料匯入（seed.json 幂等）');
  const seed = {
    exportedAt: '2026-10-17T00:00:00.000Z',
    surveys: [{ SurveyId: 8, Title: '結合劑', GroupName: '研發一群', BindMode: 'group', Announcement: '公告', QuestionsJson: JSON.stringify(defaultQuestions()), CreatorOpenId: A, IsClosed: false, CreateTime: '2026-10-01T00:00:00.000Z', UpdateTime: '2026-10-01T00:00:00.000Z' }],
    answers: [{ SurveyId: 8, OpenId: 'oOld', OpenGId: 'GID-OLD', AnswersJson: JSON.stringify(answers), SubmitTime: '2026-10-02T00:00:00.000Z' }],
    visits: [{ SurveyId: 8, OpenId: 'oOld', OpenGId: 'GID-OLD', VisitTime: '2026-10-02T00:00:00.000Z' }],
    surveyGroups: [{ SurveyId: 8, OpenGId: 'GID-OLD', FirstSeenAt: '2026-10-02T00:00:00.000Z' }],
    groupNames: [{ OpenId: A, Name: '研發一群', UseCount: 3, LastUsedAt: '2026-10-02T00:00:00.000Z' }],
  };
  const stat1 = await db.importSeed(seed);
  const stat2 = await db.importSeed(seed);
  check('第一次匯入 1 問卷 / 1 答卷 / 1 群', stat1.survey === 1 && stat1.answer === 1 && stat1.survey_group === 1, stat1);
  check('第二次匯入全部跳過（幂等）', stat2.survey === 0 && stat2.skipped === 5, stat2);
  r = await call(A, 'GET', '/surveys/8', {});
  check('舊問卷編號 8 直接可用（舊連結不失效）', r.statusCode === 200 && r.data.title === '結合劑', r.data);
  r = await call(A, 'GET', '/surveys/8/stats', {});
  check('舊問卷統計得到 1 份', r.data.answerCount === 1 && r.data.visitCount === 1, r.data.answerCount);
  r = await call(A, 'GET', '/surveys');
  check('清單同時有舊問卷與新問卷', r.data.list.length === 3, r.data.list.map((s) => s.SurveyId));

  console.log('\n[11] 刪除問卷、發布後改題、匯出打碼、清理舊數據');
  // 建一份測試問卷，讓 B 作答後整份刪掉
  r = await call(A, 'POST', '/surveys', { title: '待刪除測試', questions: defaultQuestions() });
  const delId = r.data.surveyId;
  await call(B, 'POST', `/surveys/${delId}/visit`, {}, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  r = await call(B, 'POST', `/surveys/${delId}/answer`, { answers }, { shareCloudId: { cloudID: 'cid1', data: { openGId: 'GID-A' } } });
  check('刪除前可正常提交', r.statusCode === 200, r.data);

  r = await call(C, 'POST', `/surveys/${delId}/delete`, {});
  check('非建立者刪除 → 403', r.statusCode === 403, r.data);
  r = await call(A, 'POST', `/surveys/${delId}/delete`, {});
  check('建立者刪除，連答卷一起清', r.statusCode === 200 && r.data.removed.survey === 1 && r.data.removed.answers === 1 && r.data.removed.visits === 1, r.data);
  r = await call(A, 'GET', `/surveys/${delId}`, {});
  check('刪除後讀取 → 404', r.statusCode === 404, r.data);
  r = await call(A, 'GET', '/surveys', {});
  check('刪除後清單不再出現', !r.data.list.some((s) => s.SurveyId === delId), r.data.list.map((s) => s.SurveyId));

  // 編輯題目：改題干、加題、刪題走同一個端點
  r = await call(A, 'POST', `/surveys/${surveyId}/questions`, { questions: [...defaultQuestions().slice(0, 4), { k: 'extra', type: 'text', title: '補充：還有什麼想說的？', required: false }] });
  check('發布後改題（改題干＋加題）', r.statusCode === 200 && r.data.questions.length === 5 && r.data.questions[4].k === 'extra', r.data);
  r = await call(B, 'POST', `/surveys/${surveyId}/questions`, { questions: defaultQuestions() });
  check('非建立者改題 → 403', r.statusCode === 403, r.data);
  r = await call(A, 'POST', `/surveys/${surveyId}/questions`, { questions: [] });
  check('改題為空 → 400', r.statusCode === 400, r.data);

  // 匯出打碼：CSV 不能出現完整 openid
  r = await call(A, 'GET', `/surveys/${surveyId}/export.csv`, {});
  check('CSV 的 openid 已打碼（oB → oB****）', r.statusCode === 200 && r.data.includes('oB****') && !r.data.includes(',oB,'), typeof r.data === 'string' ? r.data.slice(0, 200) : r.data);

  // 清理：塞一份 2024 年的舊答卷，purge 365 天後只清舊的那筆
  await db.importSeed({
    surveys: [{ SurveyId: 99, Title: '過期測試', BindMode: 'open', QuestionsJson: JSON.stringify(defaultQuestions()), CreatorOpenId: A, CreateTime: '2024-01-01T00:00:00.000Z' }],
    answers: [
      { SurveyId: 99, OpenId: 'oOld1', AnswersJson: JSON.stringify(answers), SubmitTime: '2024-01-01T00:00:00.000Z' },
      { SurveyId: 99, OpenId: 'oNew1', AnswersJson: JSON.stringify(answers), SubmitTime: new Date().toISOString() },
    ],
    visits: [
      { SurveyId: 99, OpenId: 'oOld1', VisitTime: '2024-01-01T00:00:00.000Z' },
      { SurveyId: 99, OpenId: 'oNew1', VisitTime: new Date().toISOString() },
    ],
  });
  r = await call(A, 'POST', '/admin/purge', { days: 365 });
  check('清理 365 天前資料：只清過期的 1 答卷 / 1 開啟', r.statusCode === 200 && r.data.answers === 1 && r.data.visits === 1, r.data);
  r = await call(A, 'GET', '/surveys/99/stats', {});
  check('清理後新答卷還在', r.data.answerCount === 1 && r.data.visitCount === 1, r.data.answerCount);
  r = await call(B, 'POST', '/admin/purge', { days: 365 });
  check('別人清理不到我的資料', r.statusCode === 200 && r.data.answers === 0 && r.data.visits === 0, r.data);

  console.log('\n[12] 小程序碼（未認證帳號靠掃碼分發）');
  r = await call(C, 'GET', `/surveys/${surveyId}/qrcode`, {});
  check('非建立者生成 → 403', r.statusCode === 403, r.data);
  r = await call(A, 'GET', `/surveys/${surveyId}/qrcode`, {});
  const qrText = r.statusCode === 200 ? Buffer.from(r.data.base64, 'base64').toString('utf8') : '';
  check('生成碼：頁面與 scene 正確（默認 release）', r.statusCode === 200 && qrText === `PNG:pages/answer/answer|sid=${surveyId}|release` && r.data.scene === `sid=${surveyId}`, { status: r.statusCode, qrText });
  r = await call(A, 'GET', `/surveys/${surveyId}/qrcode`, {}, { query: { env: 'develop' } });
  check('?env=develop → 生成開發版碼（測試用）', r.statusCode === 200 && Buffer.from(r.data.base64, 'base64').toString('utf8').endsWith('|develop'), r.data && r.data.envVersion);
  r = await call(A, 'GET', `/surveys/${surveyId}/qrcode`, {}, { query: { env: 'weird' } });
  check('未知 env → 回落 release', r.statusCode === 200 && r.data.envVersion === 'release', r.data && r.data.envVersion);

  console.log('\n[13] 切換作答範圍（二維碼分發要用「開放作答」）');
  r = await call(A, 'POST', '/surveys', { title: '掃碼分發測試', questions: defaultQuestions() });
  const modeId = r.data.surveyId;
  r = await call(B, 'POST', `/surveys/${modeId}/bindmode`, { bindMode: 'open' });
  check('非建立者切換 → 403', r.statusCode === 403, r.data);
  r = await call(C, 'POST', `/surveys/${modeId}/answer`, { answers });
  check('綁定群組模式：沒帶分享資訊 → 422（掃碼進來會被擋）', r.statusCode === 422, r.data);
  r = await call(A, 'POST', `/surveys/${modeId}/bindmode`, { bindMode: 'open' });
  check('建立者切成「開放作答」', r.statusCode === 200 && r.data.bindMode === 'open', r.data);
  r = await call(C, 'POST', `/surveys/${modeId}/answer`, { answers });
  check('開放作答模式：沒帶群資訊也能提交（掃碼可用）', r.statusCode === 200, r.data);
  r = await call(A, 'GET', `/surveys/${modeId}`, {});
  check('詳情回報 bindMode=open', r.data.bindMode === 'open', r.data.bindMode);
  r = await call(A, 'POST', `/surveys/${modeId}/bindmode`, { bindMode: 'group' });
  check('切回「綁定群組」', r.statusCode === 200 && r.data.bindMode === 'group', r.data);

  console.log('\n[14] 內容安全、截止時間、答卷明細');
  r = await call(A, 'POST', '/surveys', { title: 'BADWORD 測試', questions: defaultQuestions() });
  check('標題含不當詞 → 400', r.statusCode === 400, r.data);
  r = await call(A, 'POST', '/surveys', { title: '截止測試', questions: defaultQuestions(), bindMode: 'open', deadline: new Date(Date.now() - 60000).toISOString() });
  const expiredId = r.data.surveyId;
  check('建立一份已過截止時間的問卷', r.statusCode === 200 && !!expiredId, r.data);
  r = await call(C, 'GET', `/surveys/${expiredId}`, {});
  check('詳情回報 isExpired=true', r.statusCode === 200 && r.data.isExpired === true, r.data && r.data.isExpired);
  r = await call(C, 'POST', `/surveys/${expiredId}/answer`, { answers });
  check('截止後提交 → 409', r.statusCode === 409, r.data);
  r = await call(A, 'POST', `/surveys/${expiredId}/deadline`, { deadline: null });
  check('建立者可以清除截止時間', r.statusCode === 200 && r.data.deadline === null, r.data);
  r = await call(C, 'POST', `/surveys/${expiredId}/answer`, { answers });
  check('清除截止後可以正常提交', r.statusCode === 200, r.data);

  r = await call(A, 'POST', '/surveys', { title: '答案內容安全', questions: defaultQuestions(), bindMode: 'open' });
  const safeId = r.data.surveyId;
  const badAnswers = answers.map((a) => (a.k === 'what' ? { k: a.k, value: 'BADWORD' } : a));
  r = await call(C, 'POST', `/surveys/${safeId}/answer`, { answers: badAnswers });
  check('答案含不當詞 → 400', r.statusCode === 400, r.data);

  r = await call(A, 'GET', `/surveys/${surveyId}/responses`, {});
  check('答卷明細：openid 已打碼且帶答案', r.statusCode === 200 && r.data.count >= 1 && r.data.list[0].openid.includes('****') && Array.isArray(r.data.list[0].answers), r.data);
  r = await call(B, 'GET', `/surveys/${surveyId}/responses`, {});
  check('非建立者看答卷明細 → 403', r.statusCode === 403, r.data);
  r = await call(A, 'GET', `/surveys/${surveyId}/stats`, {});
  check('統計回傳近 7 天趨勢', r.statusCode === 200 && Array.isArray(r.data.daily) && r.data.daily.length === 7, r.data && r.data.daily);

  console.log('\n[15] 多用戶帳號與微信綁定');
  r = await call('', 'POST', '/webauth/register', { username: 'webuser', password: 'secret1', displayName: '網頁用戶' });
  const webUser = r.data && r.data.user;
  check('註冊網頁帳號', r.statusCode === 200 && !!webUser && webUser.identity === 'web:' + webUser.userId, r.data);
  r = await call('', 'POST', '/webauth/login', { username: 'webuser', password: 'wrong' });
  check('錯密碼 → 401', r.statusCode === 401, r.data);
  r = await call('', 'POST', '/webauth/login', { username: 'webuser', password: 'secret1' });
  check('登入成功', r.statusCode === 200 && r.data.user.userId === webUser.userId, r.data);

  r = await call(webUser.identity, 'POST', '/surveys', { title: '網頁建立的問卷', questions: defaultQuestions(), bindMode: 'open' });
  const webSurveyId = r.data && r.data.surveyId;
  check('網頁身份建立問卷', r.statusCode === 200 && !!webSurveyId, r.data);
  r = await call(webUser.identity, 'POST', `/surveys/${webSurveyId}/answer`, { answers });
  check('網頁身份提交答案', r.statusCode === 200, r.data);

  r = await call(webUser.identity, 'POST', '/webaccount/bind/create', { userId: webUser.userId, webUid: 'browser-uuid-1' });
  const bindToken = r.data && r.data.token;
  check('建立綁定碼', r.statusCode === 200 && !!bindToken, r.data);
  r = await call(webUser.identity, 'GET', '/webaccount/bind/status', {}, { query: { token: bindToken } });
  check('綁定狀態 pending', r.statusCode === 200 && r.data.status === 'pending', r.data);
  r = await call('oMini', 'GET', `/surveys/${bindToken}`, {});
  check('小程序看到確認綁定頁', r.statusCode === 200 && r.data.title === '確認綁定網頁帳號', r.data);
  r = await call('oMini', 'POST', `/surveys/${bindToken}/answer`, { answers: [{ k: 'confirm', value: '確認綁定' }] });
  check('小程序確認綁定', r.statusCode === 200, r.data);
  r = await call(webUser.identity, 'GET', '/webaccount/bind/status', {}, { query: { token: bindToken } });
  check('綁定狀態 confirmed', r.statusCode === 200 && r.data.status === 'confirmed' && r.data.openid === 'oMini', r.data);
  r = await call('oMini', 'GET', `/surveys/${webSurveyId}`, {});
  check('綁定後小程序看到網頁建立的問卷', r.statusCode === 200 && r.data.isCreator === true, r.data);
  r = await call('oMini', 'GET', `/surveys/${webSurveyId}/stats`, {});
  check('綁定後統計可讀且只算一份', r.statusCode === 200 && r.data.answerCount === 1, r.data);

  console.log('\n[16] 重設密碼與反向綁定');
  const ADMIN_OPENID = 'oDdte3WoBj2ZZiEdvIG6hCLTIK_k';
  r = await call('oMini', 'GET', '/webaccount/me', {});
  check('已綁定微信查到網頁帳號', r.statusCode === 200 && r.data.bound === true && r.data.username === 'webuser', r.data);
  r = await call('oNobody', 'GET', '/webaccount/me', {});
  check('未綁定微信回 bound=false', r.statusCode === 200 && r.data.bound === false, r.data);

  r = await call('oMini', 'POST', '/webaccount/self-reset', { password: 'selfpass1' });
  check('微信自助重設密碼', r.statusCode === 200 && r.data.username === 'webuser', r.data);
  r = await call('', 'POST', '/webauth/login', { username: 'webuser', password: 'secret1' });
  check('舊密碼已失效 → 401', r.statusCode === 401, r.data);
  r = await call('', 'POST', '/webauth/login', { username: 'webuser', password: 'selfpass1' });
  check('新密碼可登入', r.statusCode === 200, r.data);

  r = await call('oNobody', 'POST', '/webaccount/self-reset', { password: 'whatever1' });
  check('未綁定微信不能重設 → 404', r.statusCode === 404, r.data);
  r = await call('oMini', 'POST', '/webaccount/self-reset', { password: '123' });
  check('自助重設短密碼 → 400', r.statusCode === 400, r.data);

  r = await call('oMini', 'POST', '/webaccount/reset', { username: 'webuser', password: 'hacked1' });
  check('非管理員被擋 → 403', r.statusCode === 403, r.data);
  r = await call('oMini', 'GET', '/webaccount/users', {});
  check('非管理員看不到用戶清單 → 403', r.statusCode === 403, r.data);
  r = await call(ADMIN_OPENID, 'GET', '/webaccount/users', {});
  check('管理員看到用戶清單', r.statusCode === 200 && r.data.list.some((u) => u.username === 'webuser'), r.data);
  r = await call(ADMIN_OPENID, 'POST', '/webaccount/reset', { username: 'webuser', password: 'adminpass1' });
  check('管理員重設密碼', r.statusCode === 200, r.data);
  r = await call('', 'POST', '/webauth/login', { username: 'webuser', password: 'adminpass1' });
  check('管理員重設後可登入', r.statusCode === 200, r.data);
  r = await call(ADMIN_OPENID, 'POST', '/webaccount/reset', { username: 'nobody', password: 'adminpass1' });
  check('重設不存在的用戶 → 404', r.statusCode === 404, r.data);

  r = await call('', 'POST', '/webauth/register', { username: 'webuser2', password: 'secret2', displayName: '第二個' });
  check('註冊第二個網頁帳號', r.statusCode === 200, r.data);
  r = await call('oMini2', 'POST', '/webaccount/bind-by-password', { username: 'webuser2', password: 'bad' });
  check('反向綁定錯密碼 → 401', r.statusCode === 401, r.data);
  r = await call('oMini2', 'POST', '/webaccount/bind-by-password', { username: 'webuser2', password: 'secret2' });
  check('小程序用帳密反向綁定', r.statusCode === 200 && r.data.username === 'webuser2', r.data);
  r = await call('oMini2', 'GET', '/webaccount/me', {});
  check('反向綁定後 me 回已綁定', r.statusCode === 200 && r.data.bound === true && r.data.username === 'webuser2', r.data);
  r = await call('oMini3', 'POST', '/webaccount/bind-by-password', { username: 'webuser2', password: 'secret2' });
  check('已綁定的帳號不能再綁別的微信 → 409', r.statusCode === 409, r.data);
  r = await call('oMini2', 'POST', '/webaccount/bind-by-password', { username: 'webuser', password: 'adminpass1' });
  check('已綁定的微信不能再綁別的帳號 → 409', r.statusCode === 409, r.data);

  console.log(`\n${fail ? '✗ 失敗 ' + fail + ' 項 / ' : ''}通過 ${pass} 項`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('測試本身出錯：', e); process.exit(1); });
