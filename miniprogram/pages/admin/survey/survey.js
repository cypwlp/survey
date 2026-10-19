const api = require('../../../utils/api.js');

const TYPE_KEYS = ['text', 'choice', 'date'];

Page({
  data: { id: 0, survey: null, loading: true, error: '', editMode: false, draft: [], typeLabels: ['填充題', '單選題', '日期選擇'], saving: false, deleting: false, qrVisible: false, qrLoading: false, qrImage: '', qrError: '', qrScene: '' },

  onLoad(options) {
    this.setData({ id: Number(options.id || 0) });
  },

  onShow() {
    wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage'] });
    if (this.data.id) this.load();
  },

  async load() {
    try {
      const survey = await api.get(`/surveys/${this.data.id}`);
      this.setData({ survey, error: '' });
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  onShareAppMessage() {
    const s = this.data.survey || {};
    const title = s.groupName
      ? `【${s.groupName}】${s.title}：請查收並確認`
      : `【公告問卷】${s.title || '群公告確認'}：請查收並確認`;
    return { title, path: `/pages/answer/answer?sid=${this.data.id}`, imageUrl: '/images/survey-cover.png' };
  },

  goStats() {
    wx.navigateTo({ url: `/pages/admin/stats/stats?id=${this.data.id}` });
  },

  // 「編輯題目」模式：改題干／類型／選項／必填、加題、刪題、調順序都在這裡
  toggleEdit() {
    this.seq = 0;
    const draft = (this.data.survey.questions || []).map((q) => ({
      ...q,
      uid: 'd' + (++this.seq),
      optionsText: (q.options || []).join('，'),
      typeIndex: Math.max(0, TYPE_KEYS.indexOf(q.type)),
    }));
    this.setData({ editMode: true, draft });
  },

  cancelEdit() {
    this.setData({ editMode: false, draft: [] });
  },

  moveQuestion(e) {
    const i = Number(e.currentTarget.dataset.index);
    const j = i + Number(e.currentTarget.dataset.dir);
    const draft = this.data.draft.slice();
    if (j < 0 || j >= draft.length) return;
    const t = draft[i]; draft[i] = draft[j]; draft[j] = t;
    this.setData({ draft });
  },

  addQuestion() {
    const draft = this.data.draft.concat([{ uid: 'n' + (++this.seq), type: 'text', typeIndex: 0, title: '', required: true, optionsText: '' }]);
    this.setData({ draft });
  },

  removeQuestion(e) {
    const draft = this.data.draft.slice();
    draft.splice(Number(e.currentTarget.dataset.index), 1);
    this.setData({ draft });
  },

  onQuestionTitle(e) {
    this.setData({ [`draft[${e.currentTarget.dataset.index}].title`]: e.detail.value });
  },

  onQuestionType(e) {
    const i = e.currentTarget.dataset.index;
    const idx = Number(e.detail.value);
    this.setData({ [`draft[${i}].type`]: TYPE_KEYS[idx], [`draft[${i}].typeIndex`]: idx });
  },

  onQuestionRequired(e) {
    this.setData({ [`draft[${e.currentTarget.dataset.index}].required`]: e.detail.value });
  },

  onQuestionOptions(e) {
    this.setData({ [`draft[${e.currentTarget.dataset.index}].optionsText`]: e.detail.value });
  },

  buildQuestions() {
    const used = {};
    return this.data.draft.map((q, i) => {
      // 舊題保留原 key（答案以 k 對應）；新題自動給 qN，撞號就往後找一個沒用過的
      let k = String(q.k || '').trim().replace(/[^\w-]/g, '').slice(0, 32);
      if (!k || used[k]) {
        let n = i + 1;
        while (used[`q${n}`]) n += 1;
        k = `q${n}`;
      }
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

  async saveQuestions() {
    if (this.data.saving) return;
    const questions = this.buildQuestions();
    if (!questions.length) return wx.showToast({ title: '至少要有一道題目', icon: 'none' });
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.title) return wx.showToast({ title: `第 ${i + 1} 題沒有標題`, icon: 'none' });
      if (q.type === 'choice' && (!q.options || q.options.length < 2)) {
        return wx.showToast({ title: `第 ${i + 1} 題至少要有 2 個選項`, icon: 'none' });
      }
    }
    if (new Set(questions.map((q) => q.k)).size !== questions.length) {
      return wx.showToast({ title: '題目編號重複，請刪除多加的題目', icon: 'none' });
    }
    this.setData({ saving: true });
    try {
      const res = await api.post(`/surveys/${this.data.id}/questions`, { questions });
      this.setData({ survey: { ...this.data.survey, questions: res.questions }, editMode: false, draft: [] });
      wx.showToast({ title: '已保存修改', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  async deleteSurvey() {
    const res = await new Promise((r) => wx.showModal({
      title: '刪除問卷',
      content: '會把這份問卷的答卷、開啟記錄、群綁定一起刪掉，不可恢復。確定嗎？',
      confirmText: '刪除',
      confirmColor: '#ef4444',
      success: r,
    }));
    if (!res.confirm) return;
    this.setData({ deleting: true });
    try {
      const out = await api.post(`/surveys/${this.data.id}/delete`, {});
      wx.showToast({ title: `已刪除（含 ${out.removed.answers} 份答卷）`, icon: 'none' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ deleting: false });
    }
  },

  copyPath() {
    wx.setClipboardData({
      data: `/pages/answer/answer?sid=${this.data.id}`,
      success: () => wx.showToast({ title: '已複製分享路徑', icon: 'none' }),
    });
  },

  // 未認證帳號不能「被分享／被搜尋」，二維碼是唯一能把問卷發出去的方式。
  // 圖片長按可保存／轉發，朋友掃碼或長按識別即進入答題頁。
  openQrcode() {
    if (this.data.qrLoading) return;
    this.setData({ qrVisible: true, qrLoading: true, qrImage: '', qrError: '', qrScene: '' });
    api.get(`/surveys/${this.data.id}/qrcode`)
      .then((r) => this.setData({ qrImage: 'data:image/png;base64,' + r.base64, qrScene: r.scene, qrLoading: false }))
      .catch((e) => this.setData({ qrError: e.message || '生成失敗', qrLoading: false }));
  },

  closeQrcode() {
    this.setData({ qrVisible: false });
  },

  noop() {},

  // 綁定群組 ⇄ 開放作答：掃碼／轉發分發要用「開放作答」，微信群卡片模式用「綁定群組」
  async toggleBindMode() {
    const s = this.data.survey;
    const toOpen = s.bindMode === 'group';
    const res = await new Promise((r) => wx.showModal({
      title: toOpen ? '改為「開放作答」' : '改為「綁定群組」',
      content: toOpen
        ? '任何人拿到問卷入口（含掃小程序碼）都能提交，不再要求從群卡片進入。已回收的答卷不受影響。'
        : '之後必須從微信群卡片進入才能提交，掃碼進來的人會被擋下。已回收的答卷不受影響。',
      success: r,
    }));
    if (!res.confirm) return;
    try {
      await api.post(`/surveys/${this.data.id}/bindmode`, { bindMode: toOpen ? 'open' : 'group' });
      wx.showToast({ title: toOpen ? '已改為開放作答' : '已改為綁定群組', icon: 'none' });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async toggleClose() {
    const s = this.data.survey;
    const action = s.isClosed ? '重新開放' : '結束';
    const res = await new Promise((r) => wx.showModal({
      title: `${action}問卷`,
      content: s.isClosed ? '重新開放後成員可繼續作答。' : '結束後成員將無法再提交。',
      success: r,
    }));
    if (!res.confirm) return;
    try {
      await api.post(`/surveys/${this.data.id}/close`, { closed: !s.isClosed });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async unbind() {
    const res = await new Promise((r) => wx.showModal({
      title: '解除群綁定',
      content: '解除後，下一個從其他群進入並提交的人會重新綁定此問卷。',
      success: r,
    }));
    if (!res.confirm) return;
    try {
      await api.post(`/surveys/${this.data.id}/unbind`, {});
      wx.showToast({ title: '已解除', icon: 'success' });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
