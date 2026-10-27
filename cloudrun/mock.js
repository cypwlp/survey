// 僅供本機/預覽測試：MOCK_API=1 時回傳假資料，不碰微信雲函數。
// 正式環境不要設置 MOCK_API，這個檔案不會被使用。
const now = new Date().toISOString();
const questions = [
  { k: 'name', type: 'text', title: '你的姓名／稱呼', required: false },
  { k: 'what', type: 'text', title: 'What｜這個公告要做什麼？（寫出你理解到的重點）', required: true },
  { k: 'why', type: 'choice', title: 'Why｜你對這次公告的背景與目標認可程度？', options: ['非常清楚目標', '大致清楚', '有疑問'], required: true },
  { k: 'when', type: 'date', title: 'When｜你預計什麼時候完成／哪天有空？（選日期）', required: true },
  { k: 'where', type: 'text', title: 'Where｜在哪裡進行？（會議連結或地點）', required: true },
  { k: 'how', type: 'text', title: 'How｜打算怎麼執行／怎麼配合？', required: false },
];

let answered = false;

const survey = {
  surveyId: 8,
  title: '十月新流程公告確認',
  groupName: '小夥伴群',
  hasGroupBound: false,
  groups: [],
  bindMode: 'open',
  isClosed: false,
  deadline: null,
  isExpired: false,
  announcement: '本週五前請完成新流程確認。\n\n請大家在問卷中寫下你理解的重點、預計完成的時間與地點；有疑問也歡迎提出。',
  questions,
  isCreator: true,
  myAnswers: null,
  submitTime: null,
};

const list = [
  { SurveyId: 8, Title: survey.title, GroupName: survey.groupName, BindMode: 'open', IsClosed: false, Deadline: null, CreateTime: now, AnswerCount: 12, VisitCount: 20, IsExpired: false },
  { SurveyId: 9, Title: '家庭聚會時間調查', GroupName: '家庭群', BindMode: 'open', IsClosed: false, Deadline: '2026-11-02T15:59:59.000Z', CreateTime: now, AnswerCount: 5, VisitCount: 9, IsExpired: false },
  { SurveyId: 10, Title: '舊版測試問卷', GroupName: null, BindMode: 'group', IsClosed: true, Deadline: null, CreateTime: now, AnswerCount: 3, VisitCount: 7, IsExpired: false },
];

const daily = ['10-20', '10-21', '10-22', '10-23', '10-24', '10-25', '10-26'].map((label, i) => ({
  day: label,
  label,
  count: [0, 2, 1, 4, 2, 3, 0][i],
}));

const stats = {
  surveyId: 8,
  title: survey.title,
  bindMode: 'open',
  isClosed: false,
  isExpired: false,
  deadline: null,
  hasGroupBound: false,
  groupCount: 0,
  perGroup: [],
  visitCount: 20,
  answerCount: 12,
  lastSubmitTime: now,
  daily,
  questions: [
    { k: 'name', type: 'text', title: '你的姓名／稱呼', answerCount: 10, words: [], texts: [] },
    { k: 'what', type: 'text', title: questions[1].title, answerCount: 12, words: [{ w: '流程', n: 9 }, { w: '確認', n: 7 }, { w: '重點', n: 5 }], texts: [
      { openid: 'oDdt****TIK_k', value: '確認新流程的三個步驟，先從倉庫開始。', submitTime: now },
      { openid: 'oAbc****9xyz', value: '需要先確認舊流程的交接方式。', submitTime: now },
    ] },
    { k: 'why', type: 'choice', title: questions[2].title, answerCount: 12, distribution: [
      { option: '非常清楚目標', count: 7, pct: 58 },
      { option: '大致清楚', count: 4, pct: 33 },
      { option: '有疑問', count: 1, pct: 9 },
    ] },
  ],
};

function admin(path, method) {
  if (method === 'GET' && path === '/surveys') return { data: { list } };
  if (method === 'GET' && path === '/surveys/8') return { data: { ...survey, myAnswers: null } };
  if (method === 'GET' && path === '/surveys/8/stats') return { data: stats };
  if (method === 'GET' && path === '/surveys/8/export.csv') {
    return { data: '\uFEFF提交时间,openid（已打码）,1. What\n2026-10-26 10:00,oDdt****TIK_k,確認新流程\n' };
  }
  if (method === 'GET' && path === '/surveys/8/export.xlsx') {
    return { status: 501, data: { error: 'mock 模式不提供 Excel，請測 CSV' } };
  }
  if (method === 'POST' && path === '/surveys') return { data: { surveyId: 12 } };
  if (method === 'POST' && /^\/surveys\/8\/(close|bindmode|deadline|delete)$/.test(path)) return { data: { ok: true } };
  if (method === 'GET' && path === '/webaccount/users') {
    return { data: { list: [
      { username: 'cypilu', displayName: '小威', bound: true, createdAt: now },
      { username: 'xiaoming', displayName: '小明', bound: false, createdAt: now },
    ] } };
  }
  if (method === 'POST' && path === '/webaccount/reset') return { data: { ok: true, username: 'cypilu' } };
  return { status: 404, data: { error: 'mock：找不到 ' + method + ' ' + path } };
}

function publicApi(path, method) {
  if (method === 'GET' && path === '/surveys/8') {
    return { data: { ...survey, isCreator: false, myAnswers: answered ? [
      { k: 'name', value: '小明' },
      { k: 'what', value: '確認新流程的三個步驟' },
      { k: 'why', value: '非常清楚目標' },
      { k: 'when', value: '2026-10-30' },
      { k: 'where', value: '線上會議' },
      { k: 'how', value: '先看公告再回報' },
    ] : null, submitTime: answered ? now : null } };
  }
  if (method === 'POST' && path === '/surveys/8/visit') return { data: { ok: true } };
  if (method === 'POST' && path === '/surveys/8/answer') { answered = true; return { data: { ok: true } }; }
  return { status: 404, data: { error: 'mock：找不到 ' + method + ' ' + path } };
}

function health() {
  return {
    ok: true,
    driver: 'mock',
    wxDevMode: false,
    db: { ok: true, driver: 'mock', detail: '本機假資料', counts: { survey: list.length, answer: 12, visit: 20, survey_group: 0, group_name: 0 } },
    dev: true,
  };
}

module.exports = { admin, publicApi, health };
