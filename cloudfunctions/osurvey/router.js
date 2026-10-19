/*
 * 路由層：把原本 Express 的 REST 端點原封不動搬到雲函式。
 * 回應格式與自架版一致：成功 → { statusCode:200, data:{...} }、失敗 → { statusCode:4xx/5xx, data:{ error:'...' } }，
 * 所以小程式端只換「傳輸方式」，頁面程式碼一行都不用改。
 *
 * 與 server/src/routes/*.js 的差異（刻意的）：
 *  1. 不必登入換 token：雲函式用 cloud.getWXContext().OPENID 免鑑權直接拿到 openid。
 *  2. 群 openGId 走 CloudID（微信在雲函式入口就把 openGId 解好塞進 event），不是 AES 解密。
 */
const { validateQuestions, gradeAnswers } = require('./lib/questions');
const { buildStats, buildCsv, buildXlsx, parseSurvey } = require('./lib/stats');

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const ok = (data) => ({ statusCode: 200, data });

function createRouter({ db, resolveOpenData, allowDevGid = false, genWxacode = null, log = () => {} }) {
  const shareOf = (req) => ({
    shareCloudId: req.shareCloudId,
    devOpenGId: req.data && req.data.devOpenGId,
  });

  async function loadOwned(id, openid) {
    const survey = await db.getSurvey(id);
    if (!survey) throw httpError(404, '問卷不存在');
    if (survey.CreatorOpenId !== openid) throw httpError(403, '只有建立者可以操作');
    return survey;
  }

  // 分享資訊 → openGId
  async function shareOpenGId(share) {
    if (share && share.shareCloudId) {
      const data = await resolveOpenData(share.shareCloudId);
      if (data && data.openGId) return { openGId: String(data.openGId).slice(0, 64), dev: false };
      throw httpError(422, '分享資訊裡沒有群標識（請從群組分享卡片進入）');
    }
    if (allowDevGid && share && share.devOpenGId) {
      return { openGId: String(share.devOpenGId).slice(0, 64), dev: true };
    }
    throw httpError(422, '缺少分享資訊（請從群組分享卡片進入）');
  }

  async function createSurvey(params, req) {
    const body = req.data || {};
    const title = String(body.title || '').trim().slice(0, 100);
    if (!title) throw httpError(400, '缺少標題');
    const { questions, error } = validateQuestions(body.questions);
    if (error) throw httpError(400, error);
    const surveyId = await db.createSurvey({
      title,
      groupName: String(body.groupName || '').trim().slice(0, 100),
      bindMode: body.bindMode === 'open' ? 'open' : 'group',
      announcement: String(body.announcement || '').slice(0, 20000),
      questionsJson: JSON.stringify(questions),
      creatorOpenId: req.openid,
    });
    return ok({ surveyId });
  }

  async function listSurveys(params, req) {
    return ok({ list: await db.listSurveys(req.openid) });
  }

  async function listGroupNames(params, req) {
    const rows = await db.listGroupNames(req.openid);
    return ok({
      names: rows.map((r) => r.Name),
      list: rows.map((r) => ({ name: r.Name, useCount: r.UseCount, lastUsedAt: r.LastUsedAt })),
    });
  }

  async function saveGroupNames(params, req) {
    const names = Array.isArray(req.data && req.data.names) ? req.data.names : [];
    const saved = await db.touchGroupNames(req.openid, names);
    const rows = await db.listGroupNames(req.openid);
    return ok({
      saved,
      names: rows.map((r) => r.Name),
      list: rows.map((r) => ({ name: r.Name, useCount: r.UseCount, lastUsedAt: r.LastUsedAt })),
    });
  }

  async function getSurvey(params, req) {
    const id = Number(params[0]);
    const survey = await db.getSurvey(id);
    if (!survey) throw httpError(404, '問卷不存在');
    const mine = await db.getAnswer(id, req.openid);
    const groups = await db.listSurveyGroups(id);
    return ok({
      surveyId: survey.SurveyId,
      title: survey.Title,
      groupName: survey.GroupName,
      hasGroupBound: groups.length > 0,
      groups: groups.map((g) => ({ openGId: g.OpenGId, firstSeenAt: g.FirstSeenAt })),
      bindMode: survey.BindMode,
      isClosed: !!survey.IsClosed,
      announcement: survey.Announcement,
      questions: parseSurvey(survey),
      isCreator: survey.CreatorOpenId === req.openid,
      myAnswers: mine ? JSON.parse(typeof mine.AnswersJson === 'string' ? mine.AnswersJson : JSON.stringify(mine.AnswersJson)) : null,
      submitTime: mine ? mine.SubmitTime : null,
    });
  }

  async function closeSurvey(params, req) {
    const survey = await loadOwned(Number(params[0]), req.openid);
    const closed = !!(req.data && req.data.closed);
    await db.setClosed(survey.SurveyId, closed);
    return ok({ ok: true, isClosed: closed });
  }

  // 切換作答範圍：綁定群組 ⇄ 開放作答（只影響之後的提交校驗；二維碼分發必須用「開放作答」）
  async function setBindMode(params, req) {
    const survey = await loadOwned(Number(params[0]), req.openid);
    const mode = (req.data && req.data.bindMode) === 'open' ? 'open' : 'group';
    await db.setBindMode(survey.SurveyId, mode);
    return ok({ ok: true, bindMode: mode });
  }

  async function unbindGroups(params, req) {
    const survey = await loadOwned(Number(params[0]), req.openid);
    await db.clearSurveyGroup(survey.SurveyId);
    return ok({ ok: true });
  }

  // 只調整「題目順序」：答案以 k 對應，已回收的答卷不受影響
  async function reorderQuestions(params, req) {
    const survey = await loadOwned(Number(params[0]), req.openid);
    const order = Array.isArray(req.data && req.data.order) ? req.data.order.map(String) : null;
    if (!order) throw httpError(400, '缺少題目順序');
    const current = parseSurvey(survey);
    const byKey = new Map(current.map((q) => [q.k, q]));
    if (order.length !== current.length || new Set(order).size !== order.length || order.some((k) => !byKey.has(k))) {
      throw httpError(400, '題目清單不一致，請重新載入再調整');
    }
    const questions = order.map((k) => byKey.get(k));
    await db.updateSurveyQuestions(survey.SurveyId, JSON.stringify(questions));
    return ok({ ok: true, questions });
  }

  // 發布後改題：改題干／選項／必填、加題、刪題（答案以 k 對應，已回收的答卷不受影響）
  async function updateQuestions(params, req) {
    const survey = await loadOwned(Number(params[0]), req.openid);
    const { questions, error } = validateQuestions(req.data && req.data.questions);
    if (error) throw httpError(400, error);
    await db.updateSurveyQuestions(survey.SurveyId, JSON.stringify(questions));
    return ok({ ok: true, questions });
  }

  // 刪除問卷（連答卷／開啟記錄／群綁定一起刪，不可恢復）
  async function deleteSurvey(params, req) {
    const survey = await loadOwned(Number(params[0]), req.openid);
    const removed = await db.deleteSurveyCascade(survey.SurveyId);
    return ok({ ok: true, removed });
  }

  // 掃碼進入問卷：生成這份問卷的小程式碼（雲調用 wxacode.getUnlimited，免 access_token、免 appsecret）。
  // 未認證帳號不能被搜尋／被分享，二維碼就是分發入口；掃碼不帶群資訊，請搭配「開放作答」模式。
  async function surveyQrcode(params, req) {
    const survey = await loadOwned(Number(params[0]), req.openid);
    if (typeof genWxacode !== 'function') {
      throw httpError(500, '這個雲函式版本還不支援生成小程序碼，請先重新部署 cloudfunctions/osurvey');
    }
    const envRaw = String((req.query && req.query.env) || 'release');
    const envVersion = envRaw === 'develop' || envRaw === 'trial' ? envRaw : 'release';
    const scene = `sid=${survey.SurveyId}`;
    const buffer = await genWxacode({ page: 'pages/answer/answer', scene, envVersion });
    if (!buffer || !buffer.length) throw httpError(502, '生成小程序碼失敗：沒有拿到圖片');
    return ok({
      surveyId: survey.SurveyId,
      page: 'pages/answer/answer',
      scene,
      envVersion,
      bytes: buffer.length,
      base64: Buffer.from(buffer).toString('base64'),
    });
  }

  // 清理超過保留期限的答卷與開啟記錄（隱私指引：365 天）
  async function purgeData(params, req) {
    const days = Math.min(3650, Math.max(30, Number(req.data && req.data.days) || 365));
    const result = await db.purgeOldData(days, { creatorOpenId: req.openid });
    return ok({ ok: true, days, ...result });
  }

  // 從群卡片進入時呼叫：拿到 openGId 供前端顯示群名；group 模式下把該群加入問卷（多群模型）
  async function shareResolve(params, req) {
    const id = Number(params[0]);
    const survey = await db.getSurvey(id);
    if (!survey) throw httpError(404, '問卷不存在');
    const { openGId, dev } = await shareOpenGId(shareOf(req));
    const before = await db.listSurveyGroups(id);
    let added = false;
    if (survey.BindMode === 'group') added = await db.bindSurveyGroup(id, openGId);
    const groups = (await db.listSurveyGroups(id)).map((g) => ({ openGId: g.OpenGId, firstSeenAt: g.FirstSeenAt }));
    return ok({
      openGId, dev, justAdded: added,
      knownGroup: before.some((g) => g.OpenGId === openGId),
      groupCount: groups.length, groups,
    });
  }

  // 記錄一次「開啟」（同人同問卷只記一次）
  async function visit(params, req) {
    const id = Number(params[0]);
    const survey = await db.getSurvey(id);
    if (!survey) throw httpError(404, '問卷不存在');
    let openGId = null;
    try { openGId = (await shareOpenGId(shareOf(req))).openGId; } catch (e) { /* 沒有分享資訊也能記開啟 */ }
    await db.saveVisit(id, req.openid, openGId);
    return ok({ ok: true });
  }

  async function submitAnswer(params, req) {
    const id = Number(params[0]);
    const survey = await db.getSurvey(id);
    if (!survey) throw httpError(404, '問卷不存在');
    if (survey.IsClosed) throw httpError(409, '問卷已結束');

    const questions = parseSurvey(survey);
    const { answers, error } = gradeAnswers(questions, req.data && req.data.answers);
    if (error) throw httpError(400, error);

    // 群綁定：group 模式必須帶有效分享資訊；首次提交時綁定該群
    let openGId = null;
    if (survey.BindMode === 'group') {
      try {
        openGId = (await shareOpenGId(shareOf(req))).openGId;
      } catch (e) {
        throw httpError(422, `請從群組分享卡片進入作答（${e.message}）`);
      }
      await db.bindSurveyGroup(id, openGId);
    } else {
      try { openGId = (await shareOpenGId(shareOf(req))).openGId; } catch (e) { /* open 模式不強制歸群 */ }
    }

    try {
      await db.insertAnswer({ surveyId: id, openid: req.openid, openGId, answersJson: JSON.stringify(answers) });
    } catch (e) {
      if (e.code === 'DUPLICATE') throw httpError(409, '你已經提交過了，一人限一份');
      throw e;
    }
    await db.saveVisit(id, req.openid, openGId);
    return ok({ ok: true });
  }

  async function stats(params, req) {
    const id = Number(params[0]);
    const survey = await loadOwned(id, req.openid);
    const answers = await db.listAnswers(id);
    const { questions, rows } = buildStats(survey, answers);
    const boundGroups = await db.listSurveyGroups(id);
    const perGroup = boundGroups.map((g) => ({
      openGId: g.OpenGId,
      firstSeenAt: g.FirstSeenAt,
      answerCount: answers.filter((a) => a.OpenGId === g.OpenGId).length,
    }));
    return ok({
      surveyId: survey.SurveyId,
      title: survey.Title,
      bindMode: survey.BindMode,
      isClosed: !!survey.IsClosed,
      hasGroupBound: boundGroups.length > 0,
      groupCount: boundGroups.length,
      perGroup,
      visitCount: await db.countVisits(id),
      answerCount: answers.length,
      lastSubmitTime: rows.length ? rows[rows.length - 1].submitTime : null,
      questions,
    });
  }

  async function exportCsv(params, req) {
    const id = Number(params[0]);
    const survey = await loadOwned(id, req.openid);
    const answers = await db.listAnswers(id);
    return ok(buildCsv(survey, answers));
  }

  async function exportXlsx(params, req) {
    const id = Number(params[0]);
    const survey = await loadOwned(id, req.openid);
    const answers = await db.listAnswers(id);
    const visitCount = await db.countVisits(id);
    const buf = await buildXlsx(survey, answers, visitCount);
    // 雲函式回包不能太大：超過 400KiB 就請使用者改用 CSV（本專案規模幾乎不會遇到）
    if (buf.length > 400 * 1024) {
      throw httpError(413, `這份問卷較大（${Math.round(buf.length / 1024)}KB），請改用「匯出 CSV」`);
    }
    return ok({ filename: `survey-${id}.xlsx`, bytes: buf.length, base64: buf.toString('base64') });
  }

  async function health() {
    const state = await db.check();
    return { statusCode: state.ok ? 200 : 503, data: { ok: state.ok, driver: 'cloud', wxDevMode: false, db: state, dev: allowDevGid } };
  }

  // 一次性資料搬遷：把 seed.json（由 server/test/export-seed.js 從 SQL Server 匯出）灌進雲資料庫。
  // 幂等：已存在的 _id 一律跳過，重複執行不會產生重複資料，也不會刪任何東西。
  async function importSeed() {
    let seed = null;
    try { seed = require('./seed.json'); } catch (e) { seed = null; }
    if (!seed) throw httpError(404, '這個雲函式裡沒有 seed.json（還沒匯出資料，或已刪除）');
    if (typeof db.importSeed !== 'function') throw httpError(500, '此驅動不支援匯入');
    if (typeof db.ensureCollections === 'function') await db.ensureCollections();
    const stat = await db.importSeed(seed);
    return ok({ ok: true, exportedAt: seed.exportedAt || null, stat, counts: await db.countDocs() });
  }

  const routes = [
    ['GET', /^\/auth\/whoami$/, async (p, req) => ok({ openid: req.openid, mode: 'cloud', dev: allowDevGid })],
    ['GET', /^\/health$/, health],
    ['POST', /^\/surveys$/, createSurvey],
    ['GET', /^\/surveys$/, listSurveys],
    ['GET', /^\/groupnames$/, listGroupNames],
    ['POST', /^\/groupnames$/, saveGroupNames],
    ['GET', /^\/surveys\/(\d+)$/, getSurvey],
    ['POST', /^\/surveys\/(\d+)\/close$/, closeSurvey],
    ['POST', /^\/surveys\/(\d+)\/bindmode$/, setBindMode],
    ['POST', /^\/surveys\/(\d+)\/unbind$/, unbindGroups],
    ['POST', /^\/surveys\/(\d+)\/reorder$/, reorderQuestions],
    ['POST', /^\/surveys\/(\d+)\/questions$/, updateQuestions],
    ['POST', /^\/surveys\/(\d+)\/delete$/, deleteSurvey],
    ['GET', /^\/surveys\/(\d+)\/qrcode$/, surveyQrcode],
    ['POST', /^\/surveys\/(\d+)\/shareresolve$/, shareResolve],
    ['POST', /^\/surveys\/(\d+)\/visit$/, visit],
    ['POST', /^\/surveys\/(\d+)\/answer$/, submitAnswer],
    ['GET', /^\/surveys\/(\d+)\/stats$/, stats],
    ['GET', /^\/surveys\/(\d+)\/export\.csv$/, exportCsv],
    ['GET', /^\/surveys\/(\d+)\/export\.xlsx$/, exportXlsx],
    ['POST', /^\/admin\/importSeed$/, importSeed],
    ['POST', /^\/admin\/purge$/, purgeData],
  ];

  async function handle(event) {
    const method = String(event.method || 'GET').toUpperCase();
    const path = String(event.path || '/');
    const started = Date.now();
    try {
      for (const [m, re, fn] of routes) {
        const hit = re.exec(path);
        if (!hit) continue;
        if (m !== method) continue;
        const res = await fn(hit.slice(1), { ...event, method, path, openid: event.openid || '' });
        log(`[osurvey] ${method} ${path} → ${res.statusCode} (${Date.now() - started}ms)`);
        return res;
      }
      return { statusCode: 404, data: { error: `找不到此 API：${method} ${path}` } };
    } catch (e) {
      const status = e.status || 500;
      log(`[osurvey] ${method} ${path} → ${status} ${e.message}`);
      if (status >= 500) log(e.stack || '');
      return { statusCode: status, data: { error: e.message || '雲函式錯誤' } };
    }
  }

  return { handle, routes };
}

module.exports = { createRouter, httpError };
