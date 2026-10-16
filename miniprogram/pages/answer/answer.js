const api = require('../../utils/api.js');

Page({
  data: {
    sid: 0,
    survey: null,
    loading: true,
    error: '',
    openGId: '',
    groupWarning: '',
    answers: {},
    submitting: false,
    answered: 0,
    total: 0,
  },

  syncProgress() {
    const s = this.data.survey;
    if (!s) return;
    const a = this.data.answers;
    this.setData({
      total: s.questions.length,
      answered: s.questions.filter((q) => (a[q.k] || '').trim() !== '').length,
    });
  },

  onLoad(options) {
    this.setData({ sid: Number(options.sid || 0) });
    this.load();
  },

  onShow() {
    wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage'] });
  },

  async load() {
    const { sid } = this.data;
    if (!sid) {
      this.setData({ loading: false, error: '缺少問卷參數（sid）' });
      return;
    }
    try {
      // 1) 解析群分享資訊（shareTicket → encryptedData/iv；dev 模式用 devOpenGId）
      const app = getApp();
      const payload = await api.getSharePayload(app.globalData.shareTicket);
      this.sharePayload = payload;
      let openGId = '';
      let groupWarning = '';
      if (payload.encryptedData || payload.devOpenGId) {
        try {
          const r = await api.post(`/surveys/${sid}/shareresolve`, payload);
          openGId = r.openGId;
          if (!r.matches) groupWarning = '此問卷已綁定其他群組，提交將被拒絕';
        } catch (e) {
          groupWarning = e.message;
        }
      }

      // 2) 問卷內容
      const survey = await api.get(`/surveys/${sid}`);
      const answers = {};
      if (survey.myAnswers) {
        survey.myAnswers.forEach((a) => { answers[a.k] = a.value; });
      }
      this.setData({ survey, answers, openGId, groupWarning, error: '' });
      this.syncProgress();

      // 3) 記一次開啟（沒提交也算，用於提交率）
      if (!survey.myAnswers) {
        api.post(`/surveys/${sid}/visit`, payload).catch(() => {});
      }
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  onText(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`answers.${k}`]: e.detail.value });
    this.syncProgress();
  },

  onChoice(e) {
    const { k, opt } = e.currentTarget.dataset;
    this.setData({ [`answers.${k}`]: opt });
    this.syncProgress();
  },

  onDate(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`answers.${k}`]: e.detail.value });
    this.syncProgress();
  },

  onShareAppMessage() {
    const s = this.data.survey || {};
    const title = s.groupName
      ? `【${s.groupName}】${s.title}：請查收並確認`
      : `【公告問卷】${s.title || '群公告確認'}：請查收並確認`;
    return { title, path: `/pages/answer/answer?sid=${this.data.sid}`, imageUrl: '/images/survey-cover.jpg' };
  },

  async submit() {
    const { survey, answers, sid } = this.data;
    for (let i = 0; i < survey.questions.length; i++) {
      const q = survey.questions[i];
      if (q.required && !(answers[q.k] || '').trim()) {
        return wx.showToast({ title: `第 ${i + 1} 題是必填`, icon: 'none' });
      }
    }
    const payload = {
      ...(this.sharePayload || {}),
      answers: survey.questions.map((q) => ({ k: q.k, value: (answers[q.k] || '').trim() })),
    };
    this.setData({ submitting: true });
    try {
      await api.post(`/surveys/${sid}/answer`, payload);
      wx.showToast({ title: '提交成功', icon: 'success' });
      setTimeout(() => this.load(), 600);
    } catch (e) {
      wx.showModal({ title: '無法提交', content: e.message, showCancel: false });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
