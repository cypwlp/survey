import assert from 'node:assert/strict';

process.env.DB_DRIVER = 'memory';
process.env.TOKEN_SECRET = process.env.TOKEN_SECRET || 'smoke-test-secret';
// 測試要用 dev 模式（假 openid／假 openGId），所以先蓋掉 .env 裡的真實憑證
process.env.WX_APPID = '';
process.env.WX_SECRET = '';
const { createApp } = await import('../src/app.js');

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} 失敗 ${extra}`);
  passed++;
  console.log(`  PASS  ${name}`);
}

async function call(method, path, { token, body } = {}) {
  const resp = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv 等非 JSON */ }
  return { status: resp.status, json, text };
}

const login = async (code) => (await call('POST', '/auth/login', { body: { code } })).json;
const questions = [
  { k: 'what', type: 'text', title: 'What｜公告要做什麼？', required: true },
  { k: 'when', type: 'text', title: 'When｜什麼時間？', required: true },
  { k: 'ok', type: 'choice', title: '你同意這個安排嗎？', options: ['同意', '有疑問'], required: true },
];

console.log('== 1. 登入與驗權 ==');
const admin = await login('dev:admin');
const m1 = await login('dev:m1');
const m2 = await login('dev:m2');
const m3 = await login('dev:m3');
ok('admin 取得 token', admin.token && admin.openid.startsWith('dev-'));
const noAuth = await call('GET', '/surveys');
ok('無 token 被擋 401', noAuth.status === 401);

console.log('== 2. 建立問卷 ==');
const created = await call('POST', '/surveys', {
  token: admin.token,
  body: { title: '十月群公告確認', groupName: '測試群A', bindMode: 'group', announcement: '請大家十月起改用新流程。', questions },
});
ok('建立成功', created.status === 200 && created.json.surveyId === 1, JSON.stringify(created.json));
const sid = created.json.surveyId;
const badCreate = await call('POST', '/surveys', { token: admin.token, body: { title: '', questions } });
ok('空標題被擋 400', badCreate.status === 400);

console.log('== 3. 群內成員作答（含群綁定）==');
const sr1 = await call('POST', `/surveys/${sid}/shareresolve`, { token: m1.token, body: { devOpenGId: 'gid-A' } });
ok('m1 解密 openGId', sr1.json.openGId === 'gid-A', JSON.stringify(sr1.json));
ok('從群卡片「進入」即加入該群（不等首次提交）', sr1.json.justAdded === true && sr1.json.groupCount === 1, JSON.stringify(sr1.json));
const boundCheck = await call('GET', `/surveys/${sid}`, { token: admin.token });
ok('尚無人提交時 hasGroupBound 已為 true', boundCheck.json.hasGroupBound === true);
const srOther = await call('POST', `/surveys/${sid}/shareresolve`, { token: m3.token, body: { devOpenGId: 'gid-B' } });
ok('多群模型：第二個群也可加入', srOther.json.justAdded === true && srOther.json.groupCount === 2, JSON.stringify(srOther.json));
const srAgain = await call('POST', `/surveys/${sid}/shareresolve`, { token: m3.token, body: { devOpenGId: 'gid-B' } });
ok('重複進入同一群不會重複加入', srAgain.json.justAdded === false && srAgain.json.groupCount === 2, JSON.stringify(srAgain.json));
ok('m1 記錄開啟', (await call('POST', `/surveys/${sid}/visit`, { token: m1.token, body: { devOpenGId: 'gid-A' } })).status === 200);
const a1 = await call('POST', `/surveys/${sid}/answer`, {
  token: m1.token,
  body: { devOpenGId: 'gid-A', answers: [{ k: 'what', value: '改用新流程' }, { k: 'when', value: '十月起' }, { k: 'ok', value: '同意' }] },
});
ok('m1 提交成功', a1.status === 200, JSON.stringify(a1.json));
const a1dup = await call('POST', `/surveys/${sid}/answer`, { token: m1.token, body: { devOpenGId: 'gid-A', answers: [{ k: 'what', value: 'x' }, { k: 'when', value: 'x' }, { k: 'ok', value: '同意' }] } });
ok('m1 重複提交被擋 409', a1dup.status === 409);
const a2 = await call('POST', `/surveys/${sid}/answer`, {
  token: m2.token, body: { devOpenGId: 'gid-A' },
});
ok('m2 缺答案被擋 400', a2.status === 400);

const a2ok = await call('POST', `/surveys/${sid}/answer`, {
  token: m2.token,
  body: { devOpenGId: 'gid-A', answers: [{ k: 'what', value: '換流程' }, { k: 'when', value: '十月' }, { k: 'ok', value: '有疑問' }] },
});
ok('m2 提交成功', a2ok.status === 200);

console.log('== 4. 群邊界（多群模型下，其他群也能作答）==');
const a3 = await call('POST', `/surveys/${sid}/answer`, {
  token: m3.token,
  body: { devOpenGId: 'gid-B', answers: [{ k: 'what', value: 'B 群的答案' }, { k: 'when', value: '月底' }, { k: 'ok', value: '有疑問' }] },
});
ok('多群模型：其他群的成員也能提交', a3.status === 200, JSON.stringify(a3.json));
const a3b = await call('POST', `/surveys/${sid}/answer`, {
  token: m3.token,
  body: { answers: [{ k: 'what', value: 'x' }, { k: 'when', value: 'x' }, { k: 'ok', value: '同意' }] },
});
ok('m3 無分享資訊被擋 422', a3b.status === 422);

console.log('== 5. 統計與匯出 ==');
const statsM1 = await call('GET', `/surveys/${sid}/stats`, { token: m1.token });
ok('非建立者看統計被擋 403', statsM1.status === 403);
const stats = await call('GET', `/surveys/${sid}/stats`, { token: admin.token });
ok('answerCount = 3（A 群 2 份＋B 群 1 份）', stats.json.answerCount === 3, JSON.stringify({ n: stats.json.answerCount }));
ok('visitCount = 3（m1 開啟 + m2／m3 提交自動記）', stats.json.visitCount === 3, JSON.stringify({ n: stats.json.visitCount }));
ok('groupCount = 2（多群）', stats.json.groupCount === 2, JSON.stringify({ n: stats.json.groupCount }));
const gA = stats.json.perGroup.find((g) => g.openGId === 'gid-A');
const gB = stats.json.perGroup.find((g) => g.openGId === 'gid-B');
ok('分群統計：A 群 2 份、B 群 1 份', gA.answerCount === 2 && gB.answerCount === 1, JSON.stringify(stats.json.perGroup));
const choice = stats.json.questions.find((q) => q.k === 'ok');
ok('選擇題分佈 同意1/有疑問2', choice.distribution[0].count === 1 && choice.distribution[1].count === 2, JSON.stringify(choice.distribution));
ok('各選項百分比（33%／67%）', choice.distribution[0].pct === 33 && choice.distribution[1].pct === 67, JSON.stringify(choice.distribution.map((d) => d.pct)));
ok('5W 語義化 key 原樣保留', stats.json.questions.map((q) => q.k).join(',') === 'what,when,ok', stats.json.questions.map((q) => q.k).join(','));
const whatQ = stats.json.questions.find((q) => q.k === 'what');
ok('文字題回收 3 筆（含 B 群那一份）', whatQ.texts.length === 3);
ok('高頻詞統計出「流程」×2', (whatQ.words || []).some((x) => x.w === '流程' && x.n === 2), JSON.stringify((whatQ.words || []).slice(0, 5)));

const csvRaw = await fetch(base + `/surveys/${sid}/export.csv`, { headers: { Authorization: `Bearer ${admin.token}` } });
const csvBuf = Buffer.from(await csvRaw.arrayBuffer());
ok('CSV 帶 UTF-8 BOM', csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF, `first3=${[...csvBuf.slice(0, 3)].join(',')}`);
const csvText = csvBuf.toString('utf8');
ok('CSV 表頭＋3 列資料', csvText.split('\r\n').filter(Boolean).length === 4, JSON.stringify(csvText.slice(0, 80)));
ok('CSV 時間已轉 +8 牆上時間', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(csvText) && !csvText.includes('T0'), csvText.split('\r\n')[1]?.slice(0, 24));

const xlsxRaw = await fetch(base + `/surveys/${sid}/export.xlsx`, { headers: { Authorization: `Bearer ${admin.token}` } });
const xlsxBuf = Buffer.from(await xlsxRaw.arrayBuffer());
ok('XLSX content-type 正確', (xlsxRaw.headers.get('content-type') || '').includes('spreadsheetml'), xlsxRaw.headers.get('content-type'));
ok('XLSX 為合法 ZIP 檔頭（PK）', xlsxBuf[0] === 0x50 && xlsxBuf[1] === 0x4b, `first2=${xlsxBuf.slice(0, 2).toString()}`);
ok('XLSX 有實質內容（>3KB）', xlsxBuf.length > 3000, `size=${xlsxBuf.length}`);

const list = await call('GET', '/surveys', { token: admin.token });
ok('清單帶計數', list.json.list.length === 1 && list.json.list[0].VisitCount === 3 && list.json.list[0].AnswerCount === 3);

console.log('== 6. 詳情頁（本人答案回顯）==');
const detailM1 = await call('GET', `/surveys/${sid}`, { token: m1.token });
ok('m1 看得到自己的答案', detailM1.json.myAnswers?.find((a) => a.k === 'what')?.value === '改用新流程');
ok('m1 非建立者', detailM1.json.isCreator === false);

console.log('== 7. 結束問卷與 open 模式 ==');
await call('POST', `/surveys/${sid}/close`, { token: admin.token, body: { closed: true } });
const m4 = await login('dev:m4');
const a4 = await call('POST', `/surveys/${sid}/answer`, {
  token: m4.token,
  body: { devOpenGId: 'gid-A', answers: [{ k: 'what', value: 'x' }, { k: 'when', value: 'x' }, { k: 'ok', value: '同意' }] },
});
ok('結束後提交被擋 409', a4.status === 409);

const openSurvey = await call('POST', '/surveys', {
  token: admin.token,
  body: { title: '開放式收集', bindMode: 'open', questions: [{ k: 'what', type: 'text', title: '想說什麼？', required: true }] },
});
const osid = openSurvey.json.surveyId;
const a5 = await call('POST', `/surveys/${osid}/answer`, {
  token: m3.token,
  body: { answers: [{ k: 'what', value: '不綁群也能答' }] },
});
ok('open 模式無分享資訊可答', a5.status === 200, JSON.stringify(a5.json));

console.log('== 8. 綁定管理 ==');
const unbind = await call('POST', `/surveys/${sid}/unbind`, { token: admin.token });
ok('解除綁定成功', unbind.json.ok === true);
const sr2 = await call('POST', `/surveys/${sid}/shareresolve`, { token: m3.token, body: { devOpenGId: 'gid-B' } });
ok('解除後可重新加入群（groupCount 回到 1）', sr2.json.justAdded === true && sr2.json.groupCount === 1, JSON.stringify(sr2.json));

console.log('== 9. date 題型（設計要求：When 用時間選擇）==');
const dsurv = await call('POST', '/surveys', {
  token: admin.token,
  body: { title: '日期題測試', bindMode: 'open', questions: [{ k: 'due', type: 'date', title: '你哪天可以？', required: true }] },
});
const dsid = dsurv.json.surveyId;
ok('date 題型可建立', dsurv.status === 200 && dsid > 0, JSON.stringify(dsurv.json));
const badDate = await call('POST', `/surveys/${dsid}/answer`, { token: m4.token, body: { answers: [{ k: 'due', value: '10月20日' }] } });
ok('非 YYYY-MM-DD 被擋 400', badDate.status === 400, JSON.stringify(badDate.json));
const goodDate = await call('POST', `/surveys/${dsid}/answer`, { token: m4.token, body: { answers: [{ k: 'due', value: '2026-10-20' }] } });
ok('合法日期可提交', goodDate.status === 200, JSON.stringify(goodDate.json));
const badType = await call('POST', '/surveys', { token: admin.token, body: { title: 'x', questions: [{ k: 'a', type: 'radio', title: 'y' }] } });
ok('未知題型被擋 400', badType.status === 400);

console.log('== 10. 快取標頭（wx.request 帶 If-None-Match 時不能被回 304）==');
const first = await fetch(base + '/surveys', { headers: { Authorization: `Bearer ${admin.token}` } });
const firstText = await first.text();
ok('回應不帶 ETag', first.headers.get('etag') === null, String(first.headers.get('etag')));
ok('Cache-Control 為 no-store', (first.headers.get('cache-control') || '').includes('no-store'), first.headers.get('cache-control'));
const second = await fetch(base + '/surveys', {
  headers: { Authorization: `Bearer ${admin.token}`, 'If-None-Match': '"anything"' },
});
await second.text();
ok('帶 If-None-Match 仍回 200（不會 304 空本體）', second.status === 200, `HTTP ${second.status}`);

server.close();
console.log(`\n全部通過：${passed} 項`);
