import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { validateQuestions } from '../lib/questions.js';
import { decryptShareInfo } from '../lib/wechat.js';

export const surveysRouter = Router();
surveysRouter.use(requireAuth);

async function loadOwned(req, res) {
  const survey = await db.getSurvey(req.params.id);
  if (!survey) { res.status(404).json({ error: '問卷不存在' }); return null; }
  if (survey.CreatorOpenId !== req.openid) { res.status(403).json({ error: '只有建立者可以操作' }); return null; }
  return survey;
}

// POST /api/surveys
surveysRouter.post('/surveys', async (req, res) => {
  const body = req.body || {};
  const title = String(body.title || '').trim().slice(0, 100);
  if (!title) return res.status(400).json({ error: '缺少標題' });
  const { questions, error } = validateQuestions(body.questions);
  if (error) return res.status(400).json({ error });
  const bindMode = body.bindMode === 'open' ? 'open' : 'group';
  const surveyId = await db.createSurvey({
    title,
    groupName: String(body.groupName || '').trim().slice(0, 100),
    bindMode,
    announcement: String(body.announcement || '').slice(0, 20000),
    questionsJson: JSON.stringify(questions),
    creatorOpenId: req.openid,
  });
  res.json({ surveyId });
});

// GET /api/surveys  → 我建立的清單
surveysRouter.get('/surveys', async (req, res) => {
  res.json({ list: await db.listSurveys(req.openid) });
});

// GET /api/surveys/:id  → 詳情（作答頁與管理頁共用；附我是否已作答）
surveysRouter.get('/surveys/:id', async (req, res) => {
  const survey = await db.getSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: '問卷不存在' });
  const mine = await db.getAnswer(survey.SurveyId, req.openid);
  res.json({
    surveyId: survey.SurveyId,
    title: survey.Title,
    groupName: survey.GroupName,
    hasGroupBound: (await db.listSurveyGroups(survey.SurveyId)).length > 0,
    groups: (await db.listSurveyGroups(survey.SurveyId)).map((g) => ({ openGId: g.OpenGId, firstSeenAt: g.FirstSeenAt })),
    bindMode: survey.BindMode,
    isClosed: !!survey.IsClosed,
    announcement: survey.Announcement,
    questions: JSON.parse(survey.QuestionsJson),
    isCreator: survey.CreatorOpenId === req.openid,
    myAnswers: mine ? JSON.parse(mine.AnswersJson) : null,
    submitTime: mine ? mine.SubmitTime : null,
  });
});

// POST /api/surveys/:id/close  { closed: true|false }
surveysRouter.post('/surveys/:id/close', async (req, res) => {
  const survey = await loadOwned(req, res);
  if (!survey) return;
  await db.setClosed(survey.SurveyId, !!req.body?.closed);
  res.json({ ok: true, isClosed: !!req.body?.closed });
});

// POST /api/surveys/:id/unbind  → 解除全部群綁定（誤綁時用）
surveysRouter.post('/surveys/:id/unbind', async (req, res) => {
  const survey = await loadOwned(req, res);
  if (!survey) return;
  await db.clearSurveyGroup(survey.SurveyId);
  res.json({ ok: true });
});

// POST /api/surveys/:id/shareresolve  { shareTicket, encryptedData, iv, devOpenGId? }
// 從群卡片進入時呼叫：解密出 openGId 供前端 <open-data> 顯示群名。
// 多群模型：group 模式下，第一次從「任一群」進入就把該群加入問卷（不再只有唯一一群）。
surveysRouter.post('/surveys/:id/shareresolve', async (req, res) => {
  const survey = await db.getSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: '問卷不存在' });
  const body = req.body || {};
  try {
    const { openGId, dev } = decryptShareInfo({
      openid: req.openid,
      encryptedData: body.encryptedData,
      iv: body.iv,
      devOpenGId: body.devOpenGId,
    });
    const before = await db.listSurveyGroups(survey.SurveyId);
    let added = false;
    if (survey.BindMode === 'group') {
      added = await db.bindSurveyGroup(survey.SurveyId, openGId);
    }
    const groups = (await db.listSurveyGroups(survey.SurveyId))
      .map((g) => ({ openGId: g.OpenGId, firstSeenAt: g.FirstSeenAt }));
    res.json({
      openGId,
      dev,
      justAdded: added,
      knownGroup: before.some((g) => g.OpenGId === openGId),
      groupCount: groups.length,
      groups,
    });
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

// POST /api/surveys/:id/visit  → 記錄一次「開啟」（同人同問卷只記一次）
surveysRouter.post('/surveys/:id/visit', async (req, res) => {
  const survey = await db.getSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: '問卷不存在' });
  let openGId = null;
  try {
    openGId = decryptShareInfo({
      openid: req.openid,
      encryptedData: req.body?.encryptedData,
      iv: req.body?.iv,
      devOpenGId: req.body?.devOpenGId,
    }).openGId;
  } catch { /* 無分享資訊也能記開啟 */ }
  await db.saveVisit(survey.SurveyId, req.openid, openGId);
  res.json({ ok: true });
});
