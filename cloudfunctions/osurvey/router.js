/*
 * 路由層：把原本 Express 的 REST 端點原封不動搬到雲函式。
 * 回應格式與自架版一致：成功 → { statusCode:200, data:{...} }、失敗 → { statusCode:4xx/5xx, data:{ error:'...' } }，
 * 所以小程式端只換「傳輸方式」，頁面程式碼一行都不用改。
 *
 * 與 server/src/routes/*.js 的差異（刻意的）：
 *  1. 不必登入換 token：雲函式用 cloud.getWXContext().OPENID 免鑑權直接拿到 openid。
 *  2. 群 openGId 走 CloudID（微信在雲函式入口就把 openGId 解好塞進 event），不是 AES 解密。
 */
const crypto = require('crypto');
const { validateQuestions, gradeAnswers } = require('./lib/questions');
const { buildStats, buildCsv, buildXlsx, parseSurvey, maskOpenId } = require('./lib/stats');

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const ok = (data) => ({ statusCode: 200, data });

const BIND_QUESTIONS = [
  { k: 'confirm', type: 'choice', title: '確認綁定這個網頁帳號？', options: ['確認綁定', '取消'], required: true },
];
const BIND_ANNOUNCEMENT = '這是一次性綁定。綁定後，這個微信和你的網頁帳號會使用同一個身份，同一份問卷只算一份。若不是你本人操作，請選「取消」。';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + '$' + hash;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 2) return false;
  const test = crypto.scryptSync(String(password), parts[0], 64);
  const target = Buffer.from(parts[1], 'hex');
  return target.length === test.length && crypto.timingSafeEqual(test, target);
}

function newUserId() {
  return crypto.randomBytes(8).toString('hex');
}

function newBindToken() {
  return String(Date.now()) + String(crypto.randomInt ? crypto.randomInt(100, 999) : Math.floor(Math.random() * 900 + 100));
}

function publicUser(u) {
  return {
    userId: u.UserId,
    username: u.Username,
    displayName: u.DisplayName,
    identity: u.Identity || ('web:' + u.UserId),
    boundOpenId: u.BoundOpenId || null,
  };
}

function createRouter({ db, resolveOpenData, allowDevGid = false, genWxacode = null, checkContent = null, log = () => {} }) {
  function splitChunks(text, size = 2000) {
    const s = String(text || '');
    const out = [];
    for (let i = 0; i < s.length && out.length < 20; i += size) out.push(s.slice(i, i + size));
    return out;
  }

  // 把一次操作裡所有用戶輸入併起來送檢；任何一段 risky 就整筆擋下。
  async function assertSafeContent(parts, openid) {
    if (typeof checkContent !== 'function') return;
    const text = (Array.isArray(parts) ? parts : [parts])
      .filter((x) => x !== null && x !== undefined && String(x).trim() !== '')
      .map(String)
      .join('\n')
      .trim();
    if (!text) return;
    for (const chunk of splitChunks(text)) {
      const r = await checkContent({ content: chunk, openid, scene: 2 });
      if (r && r.ok === false) throw httpError(400, '內容包含不當資訊，請修改後再送出');
    }
  }

  function isExpired(survey) {
    return !!(survey && survey.Deadline && Date.parse(survey.Deadline) <= Date.now());
  }

  function normalizeDeadline(value) {
    if (!value) return null;
    const t = Date.parse(value);
    return isNaN(t) ? null : new Date(t).toISOString();
  }

  // 近 7 天（+8 時區）每日提交數，給統計頁畫趨勢柱狀圖
  function dailyTrend(answerRows, days = 7) {
    const out = [];
    const now = Date.now();
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(now - i * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
      out.push({ day, label: day.slice(5), count: 0 });
    }
    const byDay = new Map(out.map((x) => [x.day, x]));
    for (const a of answerRows) {
      const t = Date.parse(a.SubmitTime);
      if (isNaN(t)) continue;
      const day = new Date(t + 8 * 3600000).toISOString().slice(0, 10);
      const hit = byDay.get(day);
      if (hit) hit.count += 1;
    }
    return out;
  }

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
    const groupName = String(body.groupName || '').trim().slice(0, 100);
    const announcement = String(body.announcement || '').slice(0, 20000);
    const deadline = normalizeDeadline(body.deadline);
    const safeParts = [title, groupName, announcement];
    for (const q of questions) safeParts.push(q.title, ...(q.options || []));
    await assertSafeContent(safeParts, req.openid);
    const surveyId = await db.createSurvey({
      title,
      groupName,
      bindMode: body.bindMode === 'open' ? 'open' : 'group',
      announcement,
      questionsJson: JSON.stringify(questions),
      creatorOpenId: req.openid,
      deadline,
    });
    return ok({ surveyId });
  }

  async function registerWebUser(params, req) {
    const body = req.data || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const displayName = String(body.displayName || '').trim().slice(0, 50);
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw httpError(400, '用戶名需為 3~32 位字母、數字或底線');
    if (password.length < 6 || password.length > 72) throw httpError(400, '密碼長度需為 6~72 位');
    const existing = await db.getWebUserByUsername(username);
    if (existing) throw httpError(409, '這個用戶名已被使用');
    const user = await db.createWebUser({
      userId: newUserId(),
      username,
      passwordHash: hashPassword(password),
      displayName: displayName || username,
    });
    return ok({ user: publicUser(user) });
  }

  async function loginWebUser(params, req) {
    const body = req.data || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = await db.getWebUserByUsername(username);
    if (!user || !verifyPassword(password, user.PasswordHash)) throw httpError(401, '用戶名或密碼不正確');
    return ok({ user: publicUser(user) });
  }

  async function createWebBind(params, req) {
    const body = req.data || {};
    const userId = String(body.userId || '');
    const user = await db.getWebUserById(userId);
    if (!user) throw httpError(404, '找不到網頁帳號');
    if (req.openid && user.Identity && user.Identity !== req.openid) throw httpError(403, '這個綁定碼不屬於目前的網頁帳號');
    if (user.BoundOpenId) throw httpError(400, '這個帳號已經綁定微信');
    const token = newBindToken();
    const expireAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await db.createWebBind({
      token,
      userId: user.UserId,
      identity: user.Identity || ('web:' + user.UserId),
      webUid: String(body.webUid || '').slice(0, 64),
      expireAt,
    });
    return ok({ token, expireAt });
  }

  async function webBindStatus(params, req) {
    const token = String((req.query && req.query.token) || (req.data && req.data.token) || '');
    const bind = await db.getWebBind(token);
    if (!bind) throw httpError(404, '綁定碼不存在或已失效');
    if (req.openid && bind.Identity && bind.Identity !== req.openid) throw httpError(403, '這個綁定碼不屬於目前的網頁帳號');
    if (bind.Status === 'pending' && Date.parse(bind.ExpireAt) <= Date.now()) {
      await db.setWebBindStatus(token, 'expired', null);
      return ok({ status: 'expired' });
    }
    return ok({ status: bind.Status, openid: bind.Status === 'confirmed' ? bind.OpenId : null });
  }

  function assertPassword(password) {
    const p = String(password || '');
    if (p.length < 6 || p.length > 72) throw httpError(400, '密碼長度需為 6~72 位');
    return p;
  }

  // 管理員身份的錨點：CloudRun 會用登入 session 的 identity 當 openid 轉發，
  // 小程序端則由微信注入真實 openid（見 index.js 的取值順序），兩邊都無法偽造。
  const DEFAULT_ADMIN_OPENID = 'oDdte3WoBj2ZZiEdvIG6hCLTIK_k';
  function isAdminCaller(req) {
    const openid = String((req && req.openid) || '');
    if (!openid) return false;
    const list = String(process.env.OSURVEY_ADMIN_OPENID || DEFAULT_ADMIN_OPENID)
      .split(',').map((s) => s.trim()).filter(Boolean);
    return list.includes(openid);
  }

  async function myWebAccount(params, req) {
    const openid = String((req && req.openid) || '');
    const user = openid ? await db.getWebUserByBoundOpenId(openid) : null;
    if (!user) return ok({ bound: false, isAdmin: isAdminCaller(req) });
    return ok({
      bound: true,
      isAdmin: isAdminCaller(req),
      username: user.Username,
      displayName: user.DisplayName,
    });
  }

  async function selfResetPassword(params, req) {
    const openid = String((req && req.openid) || '');
    const password = assertPassword((req.data || {}).password);
    const user = openid ? await db.getWebUserByBoundOpenId(openid) : null;
    if (!user) throw httpError(404, '這個微信還沒綁定網頁帳號，請先用用戶名和密碼綁定');
    await db.setWebUserPassword(user.UserId, hashPassword(password));
    return ok({ ok: true, username: user.Username });
  }

  // 反向綁定：在小程序輸入網頁帳密，把這個 openid 綁到該網頁帳號。
  async function bindWebByPassword(params, req) {
    const openid = String((req && req.openid) || '');
    if (!openid) throw httpError(401, '無法取得微信用戶身份');
    const body = req.data || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = await db.getWebUserByUsername(username);
    if (!user || !verifyPassword(password, user.PasswordHash)) throw httpError(401, '用戶名或密碼不正確');
    if (user.BoundOpenId && user.BoundOpenId !== openid) throw httpError(409, '這個網頁帳號已綁定其他微信');
    const already = await db.getWebUserByBoundOpenId(openid);
    if (already && already.UserId !== user.UserId) throw httpError(409, '這個微信已經綁定其他網頁帳號');
    if (user.BoundOpenId === openid) {
      return ok({ ok: true, username: user.Username, displayName: user.DisplayName, already: true });
    }
    const oldIdentity = user.Identity || ('web:' + user.UserId);
    await db.setWebUserBoundOpenId(user.UserId, openid);
    const merged = await db.migrateWebIdentity({ webIds: [oldIdentity], openid });
    return ok({ ok: true, username: user.Username, displayName: user.DisplayName, merged });
  }

  function assertAdmin(req) {
    if (isAdminCaller(req)) return;
    log('[osurvey] 拒絕管理員操作 caller=' + String((req && req.openid) || '').slice(0, 8) + '…');
    throw httpError(403, '只有管理員可以執行這個操作');
  }

  async function listWebUsers(params, req) {
    assertAdmin(req);
    const list = await db.listWebUsers();
    return ok({
      list: list.map((u) => ({
        username: u.Username,
        displayName: u.DisplayName,
        bound: !!u.BoundOpenId,
        createdAt: u.CreatedAt || null,
      })),
    });
  }

  async function adminResetPassword(params, req) {
    assertAdmin(req);
    const body = req.data || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = assertPassword(body.password);
    const user = await db.getWebUserByUsername(username);
    if (!user) throw httpError(404, '找不到這個用戶');
    await db.setWebUserPassword(user.UserId, hashPassword(password));
    return ok({ ok: true, username: user.Username });
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

  async function removeGroupNames(params, req) {
    const names = Array.isArray(req.data && req.data.names) ? req.data.names : [];
    const removed = await db.deleteGroupNames(req.openid, names);
    const rows = await db.listGroupNames(req.openid);
    return ok({ removed, names: rows.map((r) => r.Name) });
  }

  async function getSurvey(params, req) {
    const id = Number(params[0]);
    const bind = await db.getWebBind(String(id));
    if (bind) {
      if (bind.Status === 'pending' && Date.parse(bind.ExpireAt) <= Date.now()) {
        await db.setWebBindStatus(String(id), 'expired', null);
        throw httpError(410, '綁定碼已過期，請回網頁重新產生');
      }
      const done = bind.Status === 'confirmed' && bind.OpenId === req.openid;
      return ok({
        surveyId: id,
        title: '確認綁定網頁帳號',
        groupName: '網頁登錄',
        hasGroupBound: false,
        groups: [],
        bindMode: 'open',
        isClosed: false,
        deadline: null,
        isExpired: false,
        announcement: BIND_ANNOUNCEMENT,
        questions: BIND_QUESTIONS,
        isCreator: false,
        myAnswers: done ? [{ k: 'confirm', value: '確認綁定' }] : null,
        submitTime: bind.Status === 'confirmed' ? bind.UpdatedAt || null : null,
      });
    }
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
      deadline: survey.Deadline || null,
      isExpired: isExpired(survey),
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

  async function setSurveyDeadline(params, req) {
    const survey = await loadOwned(Number(params[0]), req.openid);
    const deadline = normalizeDeadline(req.data && req.data.deadline);
    await db.setDeadline(survey.SurveyId, deadline);
    return ok({ ok: true, deadline });
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
    const safeParts = [];
    for (const q of questions) safeParts.push(q.title, ...(q.options || []));
    await assertSafeContent(safeParts, req.openid);
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
    const bind = await db.getWebBind(String(id));
    if (bind) {
      return ok({ openGId: '', dev: false, justAdded: false, knownGroup: false, groupCount: 0, groups: [] });
    }
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
    const bind = await db.getWebBind(String(id));
    if (bind) return ok({ ok: true });
    const survey = await db.getSurvey(id);
    if (!survey) throw httpError(404, '問卷不存在');
    let openGId = null;
    try { openGId = (await shareOpenGId(shareOf(req))).openGId; } catch (e) { /* 沒有分享資訊也能記開啟 */ }
    await db.saveVisit(id, req.openid, openGId);
    return ok({ ok: true });
  }

  async function submitAnswer(params, req) {
    const id = Number(params[0]);
    const bind = await db.getWebBind(String(id));
    if (bind) {
      if (bind.Status !== 'pending') throw httpError(409, '這個綁定碼已使用或已失效');
      if (Date.parse(bind.ExpireAt) <= Date.now()) {
        await db.setWebBindStatus(String(id), 'expired', null);
        throw httpError(410, '綁定碼已過期，請回網頁重新產生');
      }
      const { answers, error } = gradeAnswers(BIND_QUESTIONS, req.data && req.data.answers);
      if (error) throw httpError(400, error);
      const choice = answers.find((a) => a.k === 'confirm');
      if (!choice || choice.value !== '確認綁定') {
        await db.setWebBindStatus(String(id), 'cancelled', req.openid);
        return ok({ ok: true, cancelled: true });
      }
      const already = await db.getWebUserByBoundOpenId(req.openid);
      if (already && already.UserId !== bind.UserId) throw httpError(409, '這個微信已經綁定其他網頁帳號');
      await db.setWebBindStatus(String(id), 'confirmed', req.openid);
      await db.setWebUserBoundOpenId(bind.UserId, req.openid);
      const webIds = [bind.Identity, bind.WebUid].filter(Boolean);
      const merged = await db.migrateWebIdentity({ webIds, openid: req.openid });
      return ok({ ok: true, merged });
    }
    const survey = await db.getSurvey(id);
    if (!survey) throw httpError(404, '問卷不存在');
    if (survey.IsClosed) throw httpError(409, '問卷已結束');
    if (isExpired(survey)) throw httpError(409, '問卷已截止');

    const questions = parseSurvey(survey);
    const { answers, error } = gradeAnswers(questions, req.data && req.data.answers);
    if (error) throw httpError(400, error);

    await assertSafeContent(answers.map((a) => a.value), req.openid);

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
      deadline: survey.Deadline || null,
      isExpired: isExpired(survey),
      hasGroupBound: boundGroups.length > 0,
      groupCount: boundGroups.length,
      perGroup,
      visitCount: await db.countVisits(id),
      answerCount: answers.length,
      lastSubmitTime: rows.length ? rows[rows.length - 1].submitTime : null,
      daily: dailyTrend(answers),
      questions,
    });
  }

  // 答卷明細：一份一份看（openid 只回打碼後的版本）
  async function responses(params, req) {
    const id = Number(params[0]);
    const survey = await loadOwned(id, req.openid);
    const answers = await db.listAnswers(id);
    const list = answers.map((a, i) => {
      let parsed = [];
      try {
        parsed = typeof a.AnswersJson === 'string' ? JSON.parse(a.AnswersJson) : a.AnswersJson;
      } catch (e) {
        parsed = [];
      }
      return {
        i,
        openid: maskOpenId(a.OpenId),
        openGId: a.OpenGId || '',
        submitTime: a.SubmitTime,
        answers: Array.isArray(parsed) ? parsed : [],
      };
    });
    return ok({
      surveyId: id,
      title: survey.Title,
      count: list.length,
      questions: parseSurvey(survey),
      list,
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
    ['POST', /^\/webauth\/register$/, registerWebUser],
    ['POST', /^\/webauth\/login$/, loginWebUser],
    ['POST', /^\/webaccount\/bind\/create$/, createWebBind],
    ['GET', /^\/webaccount\/bind\/status$/, webBindStatus],
    ['GET', /^\/webaccount\/me$/, myWebAccount],
    ['POST', /^\/webaccount\/self-reset$/, selfResetPassword],
    ['POST', /^\/webaccount\/bind-by-password$/, bindWebByPassword],
    ['GET', /^\/webaccount\/users$/, listWebUsers],
    ['POST', /^\/webaccount\/reset$/, adminResetPassword],
    ['POST', /^\/surveys$/, createSurvey],
    ['GET', /^\/surveys$/, listSurveys],
    ['GET', /^\/groupnames$/, listGroupNames],
    ['POST', /^\/groupnames$/, saveGroupNames],
    ['POST', /^\/groupnames\/delete$/, removeGroupNames],
    ['GET', /^\/surveys\/(\d+)$/, getSurvey],
    ['POST', /^\/surveys\/(\d+)\/close$/, closeSurvey],
    ['POST', /^\/surveys\/(\d+)\/deadline$/, setSurveyDeadline],
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
    ['GET', /^\/surveys\/(\d+)\/responses$/, responses],
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
