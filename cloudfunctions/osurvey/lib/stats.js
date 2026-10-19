/*
 * 統計與匯出（雲函式版，CommonJS）
 * 與 server/src/routes/stats.js 同一套演算法：改一邊記得改另一邊。
 *  - buildStats ：逐題統計（選項分佈／高頻詞／文字明細）
 *  - buildCsv   ：答卷明細 CSV（帶 BOM，Excel 直開不亂碼）
 *  - buildXlsx  ：兩張工作表（答卷明細＋統計摘要）
 * 高頻詞定位是「詞頻提示」不是分詞器：中文走 2-gram、英數走詞彙，過濾虛詞。
 */
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

function parseSurvey(survey) {
  return JSON.parse(typeof survey.QuestionsJson === 'string' ? survey.QuestionsJson : JSON.stringify(survey.QuestionsJson));
}

// openid 打碼：首 4 + **** + 末 4（導出與統計頁都不再暴露完整 openid）
function maskOpenId(id) {
  const s = String(id || '');
  if (!s) return '';
  if (s.length <= 10) return s.slice(0, 2) + '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

function buildStats(survey, answerRows) {
  const questions = parseSurvey(survey);
  const parsed = answerRows.map((r) => ({
    openid: r.OpenId,
    openGId: r.OpenGId,
    submitTime: r.SubmitTime,
    answers: typeof r.AnswersJson === 'string' ? JSON.parse(r.AnswersJson) : r.AnswersJson,
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
        .map((p) => ({ openid: maskOpenId(p.openid), value: p.answers.find((a) => a.k === q.k).value, submitTime: p.submitTime })),
    };
  });
  return { questions: perQuestion, rows: parsed };
}

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

function buildCsv(survey, answers) {
  const questions = parseSurvey(survey);
  const header = ['提交时间', 'openid（已打码）', ...questions.map((q) => q.title.replace(/[\r\n]+/g, ' '))];
  const lines = [header.map(csvCell).join(',')];
  for (const row of answers) {
    const parsed = typeof row.AnswersJson === 'string' ? JSON.parse(row.AnswersJson) : row.AnswersJson;
    const cells = [localTime(row.SubmitTime), maskOpenId(row.OpenId)];
    for (const q of questions) cells.push(parsed.find((a) => a.k === q.k)?.value || '');
    lines.push(cells.map(csvCell).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

async function buildXlsx(survey, answers, visitCount) {
  const { default: ExcelJS } = await import('exceljs');
  const questions = parseSurvey(survey);
  const { questions: qStats } = buildStats(survey, answers);

  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const ws = wb.addWorksheet('答卷明細');
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.columns = [
    { header: '序號', key: 'i', width: 6 },
    { header: '提交時間(+8)', key: 't', width: 18 },
    { header: 'openid（已打码）', key: 'o', width: 30 },
    ...questions.map((q, idx) => ({ header: `${idx + 1}. ${q.title}`, key: `q${idx}`, width: 34 })),
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  answers.forEach((row, n) => {
    const parsed = typeof row.AnswersJson === 'string' ? JSON.parse(row.AnswersJson) : row.AnswersJson;
    const rec = { i: n + 1, t: localTime(row.SubmitTime), o: maskOpenId(row.OpenId) };
    questions.forEach((q, idx) => { rec[`q${idx}`] = parsed.find((a) => a.k === q.k)?.value || ''; });
    ws.addRow(rec);
  });

  const sum = wb.addWorksheet('統計摘要');
  sum.columns = [{ width: 34 }, { width: 22 }, { width: 16 }];
  const kv = (k, v) => { const r = sum.addRow([k, v]); r.getCell(1).font = { bold: true }; };
  kv('問卷標題', survey.Title);
  kv('群名稱', survey.GroupName || '（未填）');
  kv('作答範圍', survey.BindMode === 'group' ? '綁定群組（已綁定）' : '開放作答');
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

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { topWords, buildStats, csvCell, localTime, buildCsv, buildXlsx, parseSurvey, maskOpenId };
