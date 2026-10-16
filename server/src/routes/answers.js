import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { gradeAnswers } from '../lib/questions.js';
import { decryptShareInfo } from '../lib/wechat.js';

export const answersRouter = Router();
answersRouter.use(requireAuth);

// POST /api/surveys/:id/answer  { answers:[{k,value}], encryptedData?, iv?, devOpenGId? }
answersRouter.post('/surveys/:id/answer', async (req, res) => {
  const survey = await db.getSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: '問卷不存在' });
  if (survey.IsClosed) return res.status(409).json({ error: '問卷已結束' });

  const questions = JSON.parse(survey.QuestionsJson);
  const { answers, error } = gradeAnswers(questions, req.body?.answers);
  if (error) return res.status(400).json({ error });

  // 群綁定：group 模式必須帶有效分享資訊；首次提交時綁定該群
  let openGId = null;
  if (survey.BindMode === 'group') {
    try {
      openGId = decryptShareInfo({
        openid: req.openid,
        encryptedData: req.body?.encryptedData,
        iv: req.body?.iv,
        devOpenGId: req.body?.devOpenGId,
      }).openGId;
    } catch (e) {
      return res.status(422).json({ error: `請從群組分享卡片進入作答（${e.message}）` });
    }
    // 多群模型：任何能解出 openGId 的群都可以加入這份問卷並提交
    await db.bindSurveyGroup(survey.SurveyId, openGId);
  } else {
    try {
      openGId = decryptShareInfo({
        openid: req.openid,
        encryptedData: req.body?.encryptedData,
        iv: req.body?.iv,
        devOpenGId: req.body?.devOpenGId,
      }).openGId;
    } catch { /* open 模式不強制歸群 */ }
  }

  try {
    await db.insertAnswer({
      surveyId: survey.SurveyId,
      openid: req.openid,
      openGId,
      answersJson: JSON.stringify(answers),
    });
  } catch (e) {
    if (e.code === 'DUPLICATE') return res.status(409).json({ error: '你已經提交過了，一人限一份' });
    throw e;
  }
  await db.saveVisit(survey.SurveyId, req.openid, openGId);
  res.json({ ok: true });
});
