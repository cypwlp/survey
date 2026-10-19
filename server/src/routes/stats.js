import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../lib/auth.js';

export const statsRouter = Router();
statsRouter.use(requireAuth);

async function loadOwnedSurvey(req, res) {
  const survey = await db.getSurvey(req.params.id);
  if (!survey) { res.status(404).json({ error: '問卷不存在' }); return null; }
  if (survey.CreatorOpenId !== req.openid) { res.status(403).json({ error: '只有建立者可以看統計' }); return null; }
  return survey;
}

// 高頻詞：中文走 2-gram、英數走詞彙；過濾虛詞與無資訊詞。不是分詞器，定位為「詞頻提示」
const STOP_CHARS = new Set('的了是在和就都也很這那我你他她們個要不沒為之中與及從到把被給對以或但將'.split(''));
const STOP_WORDS = new Set(['什麼', '怎麼', '如何', '可以', '需要', '進行', '因為', '所以', '但是', '如果', '已經', '還是', '一個', '這個', '那個', '大家', '時間', '工作', '任務', '相關', '部分', '麻煩', '謝謝', '目前', '可能', '應該', '沒有', '不是', '好的', '以上', '問題']);

function topWords(values, limit = 24) {
  const counts = new Map();
  const bump = (w) => counts.set(w, (counts.get(w) || 0) + 1);
  for (const raw of values) {
    const s = String(raw).toLowerCase();
    for (const run of s.match(/[a-z0-9]{2,}|[一-龥]+/g) || []) {
      if (/^[a-z0-9]+$/.test(run)) {
        if (!STOP_WORDS.has(run)) bump(run);
        continue;
      }
      const ch = [...run];
      for (let i = 0; i + 1 < ch.length; i++) {
        const g = ch[i] + ch[i + 1];
        if (STOP_CHARS.has(g[0]) || STOP_CHARS.has(g[1]) || STOP_WORDS.has(g)) continue;
        bump(g);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w, n]) => ({ w, n }));
}

function buildStats(survey, answerRows) {
  const questions = JSON.parse(survey.QuestionsJson);
  const parsed = answerRows.map((r) => ({
    openid: r.OpenId,
    openGId: r.OpenGId,
    submitTime: r.SubmitTime,
    answers: JSON.parse(r.AnswersJson),
  }));
  const perQuestion = questions.map((q) => {
    const values = parsed
      .map((p) => p.answers.find((a) => a.k === q.k)?.value || '')
      .filter((v) => v !== '');
    if (q.type === 'choice') {
      const total = parsed.length;
      const distribution = q.options.map((opt) => {
        const count = values.filter((v) => v === opt).length;
        return { option: opt, count, pct: total ? Math.round((count / total) * 100) : 0 };
      });
      const blank = parsed.length - values.length;
      if (blank > 0) distribution.push({ option: '（未填）', count: blank, pct: Math.round((blank / total) * 100) });
      return { k: q.k, type: q.type, title: q.title, answerCount: values.length, distribution };
    }
    return {
      k: q.k, type: q.type, title: q.title, answerCount: values.length,
      words: topWords(values),
      texts: parsed
        .filter((p) => (p.answers.find((a) => a.k === q.k)?.value || '') !== '')
        .slice(0, 500)
        .map((p) => ({ openid: p.openid, value: p.answers.find((a) => a.k === q.k).value, submitTime: p.submitTime })),
    };
  });
  return { questions: perQuestion, rows: parsed };
}

// GET /api/surveys/:id/stats
statsRouter.get('/surveys/:id/stats', async (req, res) => {
  const survey = await loadOwnedSurvey(req, res);
  if (!survey) return;
  const answers = await db.listAnswers(survey.SurveyId);
  const { questions, rows } = buildStats(survey, answers);
  const boundGroups = await db.listSurveyGroups(survey.SurveyId);
  const perGroup = boundGroups.map((g) => ({
    openGId: g.OpenGId,
    firstSeenAt: g.FirstSeenAt,
    answerCount: answers.filter((a) => a.OpenGId === g.OpenGId).length,
  }));
  res.json({
    surveyId: survey.SurveyId,
    title: survey.Title,
    bindMode: survey.BindMode,
    isClosed: !!survey.IsClosed,
    hasGroupBound: boundGroups.length > 0,
    groupCount: boundGroups.length,
    perGroup,
    visitCount: await db.countVisits(survey.SurveyId),
    answerCount: answers.length,
    lastSubmitTime: rows.length ? rows[rows.length - 1].submitTime : null,
    questions,
  });
});

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// UTC ISO → +8 牆上時間字串（報表用，避免管理員自己換算）
function localTime(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return String(iso || '');
  return new Date(t + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

// GET /api/surveys/:id/export.csv
statsRouter.get('/surveys/:id/export.csv', async (req, res) => {
  const survey = await loadOwnedSurvey(req, res);
  if (!survey) return;
  const questions = JSON.parse(survey.QuestionsJson);
  const answers = await db.listAnswers(survey.SurveyId);
  const header = ['提交时间', 'openid', ...questions.map((q) => q.title.replace(/[\r\n]+/g, ' '))];
  const lines = [header.map(csvCell).join(',')];
  for (const row of answers) {
    const parsed = JSON.parse(row.AnswersJson);
    const cells = [localTime(row.SubmitTime), row.OpenId];
    for (const q of questions) cells.push(parsed.find((a) => a.k === q.k)?.value || '');
    lines.push(cells.map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="survey-${survey.SurveyId}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n'));
});

// GET /api/surveys/:id/export.xlsx  → 兩个工作表：答卷明細＋統計摘要
statsRouter.get('/surveys/:id/export.xlsx', async (req, res) => {
  const survey = await loadOwnedSurvey(req, res);
  if (!survey) return;
  const { default: ExcelJS } = await import('exceljs');
  const questions = JSON.parse(survey.QuestionsJson);
  const answers = await db.listAnswers(survey.SurveyId);
  const { questions: qStats } = buildStats(survey, answers);
  const visitCount = await db.countVisits(survey.SurveyId);

  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const ws = wb.addWorksheet('答卷明細');
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.columns = [
    { header: '序號', key: 'i', width: 6 },
    { header: '提交時間(+8)', key: 't', width: 18 },
    { header: 'openid', key: 'o', width: 30 },
    ...questions.map((q, idx) => ({ header: `${idx + 1}. ${q.title}`, key: `q${idx}`, width: 34 })),
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  answers.forEach((row, n) => {
    const parsed = JSON.parse(row.AnswersJson);
    const rec = { i: n + 1, t: localTime(row.SubmitTime), o: row.OpenId };
    questions.forEach((q, idx) => { rec[`q${idx}`] = parsed.find((a) => a.k === q.k)?.value || ''; });
    ws.addRow(rec);
  });

  const sum = wb.addWorksheet('統計摘要');
  sum.columns = [{ width: 34 }, { width: 22 }, { width: 16 }];
  const kv = (k, v) => { const r = sum.addRow([k, v]); r.getCell(1).font = { bold: true }; };
  kv('問卷標題', survey.Title);
  kv('群名稱', survey.GroupName || '（未填）');
  kv('作答範圍', survey.BindMode === 'group' ? (survey.OpenGId ? '綁定群組（已綁定）' : '綁定群組（待綁定）') : '開放作答');
  kv('開啟人數', visitCount);
  kv('提交份數', answers.length);
  kv('提交/開啟', visitCount ? Math.round((answers.length / visitCount) * 100) + '%' : '—');
  sum.addRow([]);
  for (const q of qStats) {
    const head = sum.addRow([q.title, `回收 ${q.answerCount} 份`]);
    head.getCell(1).font = { bold: true };
    if (q.distribution) {
      for (const d of q.distribution) sum.addRow(['　' + d.option, `${d.count} 份（${d.pct}%）`]);
    }
  }

  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `survey-${survey.SurveyId}.xlsx`;
  // 小程序走雲托管 callcontainer 時沒有「下載域名」可用（單次回包上限 1000KiB），
  // 所以多一條 ?format=base64：前端拿到 base64 自己寫檔再 openDocument，
  // 這條路在 https 直連模式下也通，就不必再配置 downloadFile 合法域名。
  if (req.query.format === 'base64') {
    if (buf.length > 640 * 1024) {
      return res.status(413).json({ error: `這份問卷較大（${Math.round(buf.length / 1024)}KB），請改用「匯出 CSV」` });
    }
    return res.json({ filename, bytes: buf.length, base64: buf.toString('base64') });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});
