const api = require('../../../utils/api.js');

const TYPE_KEYS = ['text', 'choice', 'date'];

const DEFAULT_QUESTIONS = [
  { k: 'what', type: 'text', title: 'What｜這個公告要做什麼？（寫出你理解到的重點）', required: true },
  { k: 'why', type: 'choice', title: 'Why｜你對這次公告的背景與目標認可程度？', required: true, optionsText: '非常清楚目標，大致清楚，有疑問' },
  { k: 'when', type: 'date', title: 'When｜你預計什麼時候完成／哪天有空？（選日期）', required: true },
  { k: 'where', type: 'text', title: 'Where｜在哪裡進行？（會議連結或地點）', required: true },
  { k: 'how', type: 'text', title: 'How｜打算怎麼執行／怎麼配合？', required: false },
];

Page({
  data: {
    title: '',
    groupNames: [],
    groupInput: '',
    savedGroups: [],
    announcement: '',
    bindMode: 'group',
    questions: [],
    typeLabels: ['填充題', '單選題', '日期選擇'],
    submitting: false,
  },

  onLoad() {
    const saved = wx.getStorageSync('groupHistory') || [];
    this.setData({
      questions: DEFAULT_QUESTIONS.map((q) => ({
        ...q,
        optionsText: q.optionsText || '',
        typeIndex: TYPE_KEYS.indexOf(q.type),
      })),
      savedGroups: saved,
    });
  },

  onTitle(e) { this.setData({ title: e.detail.value }); },
  onGroupInput(e) { this.setData({ groupInput: e.detail.value }); },
  onAnnouncement(e) { this.setData({ announcement: e.detail.value }); },
  setBindMode(e) { this.setData({ bindMode: e.currentTarget.dataset.mode }); },

  addGroupName() {
    const name = (this.data.groupInput || '').trim();
    if (!name) return wx.showToast({ title: '先輸入群名', icon: 'none' });
    if (this.data.groupNames.includes(name)) return wx.showToast({ title: '這個群名已經加了', icon: 'none' });
    const groupNames = this.data.groupNames.concat([name]);
    // 記住歷史群名（本機 storage，下次可直接選）
    const savedGroups = [name, ...this.data.savedGroups.filter((g) => g !== name)].slice(0, 20);
    wx.setStorageSync('groupHistory', savedGroups);
    this.setData({ groupNames, savedGroups, groupInput: '' });
  },

  removeGroupName(e) {
    const name = e.currentTarget.dataset.name;
    this.setData({ groupNames: this.data.groupNames.filter((g) => g !== name) });
  },

  pickSaved(e) {
    const name = e.currentTarget.dataset.name;
    if (!this.data.groupNames.includes(name)) {
      this.setData({ groupNames: this.data.groupNames.concat([name]) });
    }
  },

  pasteAnnouncement() {
    wx.getClipboardData({
      success: (res) => {
        const text = (res.data || '').trim();
        if (!text) return wx.showToast({ title: '剪貼簿是空的', icon: 'none' });
        const cur = this.data.announcement;
        this.setData({ announcement: cur ? cur + '\n' + text : text });
      },
    });
  },

  addQuestion() {
    const questions = this.data.questions.concat([{ type: 'text', typeIndex: 0, title: '', required: true, optionsText: '' }]);
    this.setData({ questions });
  },

  removeQuestion(e) {
    const i = e.currentTarget.dataset.index;
    const questions = this.data.questions.slice();
    questions.splice(i, 1);
    this.setData({ questions });
  },

  onQuestionTitle(e) {
    const i = e.currentTarget.dataset.index;
    this.setData({ [`questions[${i}].title`]: e.detail.value });
  },

  onQuestionType(e) {
    const i = e.currentTarget.dataset.index;
    const idx = Number(e.detail.value);
    this.setData({
      [`questions[${i}].type`]: TYPE_KEYS[idx],
      [`questions[${i}].typeIndex`]: idx,
    });
  },

  onQuestionRequired(e) {
    const i = e.currentTarget.dataset.index;
    this.setData({ [`questions[${i}].required`]: e.detail.value });
  },

  onQuestionOptions(e) {
    const i = e.currentTarget.dataset.index;
    this.setData({ [`questions[${i}].optionsText`]: e.detail.value });
  },

  buildQuestions() {
    const used = {};
    return this.data.questions.map((q, i) => {
      // 5W 題目保留語義化 key（what/when/where/why/how），新增題才用 qN
      let k = String(q.k || '').trim().replace(/[^\w-]/g, '').slice(0, 32) || `q${i + 1}`;
      if (used[k]) k = `q${i + 1}`;
      used[k] = true;
      const item = { k, type: q.type, title: (q.title || '').trim(), required: !!q.required };
      if (q.type === 'choice') {
        item.options = (q.optionsText || '')
          .split(/[,，、\n]/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return item;
    });
  },

  validate(questions) {
    if (!this.data.title.trim()) return '請填問卷標題';
    if (!questions.length) return '至少要有一道題目';
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.title) return `第 ${i + 1} 題沒有標題`;
      if (q.type === 'choice' && (!q.options || q.options.length < 2)) {
        return `第 ${i + 1} 題是單選題，至少要有 2 個選項（用逗號分隔）`;
      }
    }
    if (new Set(questions.map((q) => q.k)).size !== questions.length) return '題目編號重複，請刪除多加的題目';
    return '';
  },

  async submit() {
    const questions = this.buildQuestions();
    const err = this.validate(questions);
    if (err) return wx.showToast({ title: err, icon: 'none' });

    this.setData({ submitting: true });
    try {
      const res = await api.post('/surveys', {
        title: this.data.title.trim(),
        groupName: this.data.groupNames.join('／'),
        bindMode: this.data.bindMode,
        announcement: this.data.announcement,
        questions,
      });
      wx.showToast({ title: '已建立', icon: 'success' });
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/admin/survey/survey?id=${res.surveyId}` });
      }, 400);
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
