/*
 * 題目校驗／作答評分（雲函式版，CommonJS）
 * 與 server/src/lib/questions.js 同一套規則：改一邊記得改另一邊。
 * 規則：題型只有 text/choice/date；上限 30 題；choice 至少 2 個選項；k 不可重複。
 */
const TYPES = new Set(['text', 'choice', 'date']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function defaultQuestions() {
  return [
    { k: 'what', type: 'text', title: 'What｜这个公告要做什麼？（写出你理解到的重點）', required: true },
    { k: 'why', type: 'choice', title: 'Why｜你对这次公告的背景与目标认可程度？', options: ['非常清楚目标', '大致清楚', '有疑问'], required: true },
    { k: 'when', type: 'date', title: 'When｜你预计什么时候完成／哪天有空？（选日期）', required: true },
    { k: 'where', type: 'text', title: 'Where｜在哪裡进行？影响哪些范围？', required: true },
    { k: 'how', type: 'text', title: 'How｜打算怎麼执行／怎麼配合？', required: false },
  ];
}

function validateQuestions(input) {
  if (!Array.isArray(input) || input.length === 0) return { error: '题目不能为空' };
  if (input.length > 30) return { error: '题目最多 30 题' };
  const questions = [];
  for (const q of input) {
    if (!q || typeof q.title !== 'string' || !q.title.trim()) return { error: '每题都要有标题' };
    if (!TYPES.has(q.type)) return { error: `题目类型不合法：${q.type}` };
    const item = {
      k: String(q.k || '').slice(0, 32) || `q${questions.length + 1}`,
      type: q.type,
      title: q.title.trim().slice(0, 300),
      required: q.required !== false,
    };
    if (q.type === 'choice') {
      const options = (Array.isArray(q.options) ? q.options : [])
        .map((o) => String(o).trim())
        .filter(Boolean)
        .slice(0, 20);
      if (options.length < 2) return { error: '选择题至少要有 2 个选项' };
      item.options = options;
    }
    questions.push(item);
  }
  const keys = new Set(questions.map((q) => q.k));
  if (keys.size !== questions.length) return { error: '题目 key 不可重复' };
  return { questions };
}

function gradeAnswers(questions, answers) {
  if (!Array.isArray(answers)) return { error: '答案格式不正确' };
  const map = new Map(answers.map((a) => [String(a.k), String(a.value ?? '').trim()]));
  const out = [];
  for (const q of questions) {
    const value = (map.get(q.k) || '').slice(0, 2000);
    if (q.required && !value) return { error: `必填题未作答：${q.title}` };
    if (q.type === 'choice' && value && !q.options.includes(value)) {
      return { error: `选项不在范围内：${q.title}` };
    }
    if (q.type === 'date' && value && !DATE_RE.test(value)) {
      return { error: `日期格式不正确（要 YYYY-MM-DD）：${q.title}` };
    }
    out.push({ k: q.k, value });
  }
  return { answers: out };
}

module.exports = { TYPES, DATE_RE, defaultQuestions, validateQuestions, gradeAnswers };
