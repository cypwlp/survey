const api = require('../../utils/api.js');

// 掃小程序碼進來時，參數包在 options.scene（如 "sid=8"，微信可能再包一層 URL 編碼），
// 這裡統一解出來；直接帶 ?sid=8 進來的老路徑不受影響。
function sidFromScene(scene) {
  let v = String(scene || '');
  for (let i = 0; i < 2 && v; i++) {
    const m = /(?:^|[&;])sid=(\d+)/.exec(v);
    if (m) return Number(m[1]);
    let d;
    try { d = decodeURIComponent(v); } catch (e) { break; }
    if (d === v) break;
    v = d;
  }
  return 0;
}

// 後端時間是 UTC ISO；固定顯示為 +8 時區牆上時間（與裝置時區無關）
function fmtTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const d = new Date(t + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getUTCMonth() + 1) + '-' + d.getUTCDate() + ' ' + d.getUTCHours() + ':' + p(d.getUTCMinutes());
}

Page({
  data: {
    sid: 0,
    survey: null,
    loading: true,
    error: '',
    openGId: '',
    groupNote: '',
    groupWarning: '',
    answers: {},
    submitting: false,
    answered: 0,
    total: 0,
    submitTimeText: '',
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
    let sid = Number(options.sid || 0);
    if (!sid && options.scene) sid = sidFromScene(options.scene);
    this.setData({ sid });
    this.load();
  },

  onShow() {
    wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage'] });
  },

  // shareTicket → openGId：session_key 失靈時重新登入並重新取一次分享資訊
  async resolveGroup(sid) {
    const shareTicket = getApp().globalData.shareTicket;
    let attempts = 0;
    let lastError = '';
    while (attempts < 2) {
      attempts += 1;
      const payload = await api.getSharePayload(shareTicket);
      if (!api.hasSharePayload(payload)) {
        return { payload, openGId: '', note: '', warning: '' };
      }
      try {
        const r = await api.post(`/surveys/${sid}/shareresolve`, payload);
        const note = r.dev
          ? '開發模式：使用設定的測試群 ID（非真實群）'
          : `${r.justAdded ? '已識別本群並加入問卷' : '本群已在問卷的群清單中'}｜目前共 ${r.groupCount} 個群`;
        return { payload, openGId: r.openGId, note, warning: '' };
      } catch (e) {
        lastError = e.message;
        if (api.isSessionExpired(lastError)) { api.resetLogin(); continue; }
        break;
      }
    }
    return { payload: this.sharePayload || {}, openGId: '', note: '', warning: lastError };
  },

  async load() {
    const { sid } = this.data;
    if (!sid) {
      this.setData({ loading: false, error: '缺少問卷參數（sid）' });
      return;
    }
    try {
      const group = await this.resolveGroup(sid);
      this.sharePayload = group.payload;

      // 問卷內容
      const survey = await api.get(`/surveys/${sid}`);
      const answers = {};
      if (survey.myAnswers) {
        survey.myAnswers.forEach((a) => { answers[a.k] = a.value; });
      }
      this.setData({
        survey,
        answers,
        openGId: group.openGId,
        groupNote: group.note,
        groupWarning: group.warning,
        submitTimeText: survey.submitTime ? fmtTime(survey.submitTime) : '',
        error: '',
      });
      this.syncProgress();

      // 記一次開啟（沒提交也算，用於提交率）
      if (!survey.myAnswers) {
        api.post(`/surveys/${sid}/visit`, this.sharePayload).catch(() => {});
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
    return { title, path: `/pages/answer/answer?sid=${this.data.sid}`, imageUrl: '/images/survey-cover.png' };
  },

  async submit() {
    const { survey, answers, sid } = this.data;
    for (let i = 0; i < survey.questions.length; i++) {
      const q = survey.questions[i];
      if (q.required && !(answers[q.k] || '').trim()) {
        return wx.showToast({ title: `第 ${i + 1} 題是必填`, icon: 'none' });
      }
    }
    const answerList = survey.questions.map((q) => ({ k: q.k, value: (answers[q.k] || '').trim() }));
    this.setData({ submitting: true });
    try {
      // 提交前重新取一次分享資訊：確保 encryptedData 對應後端手上的 session_key
      let payload = await api.getSharePayload(getApp().globalData.shareTicket);
      try {
        await api.post(`/surveys/${sid}/answer`, { ...payload, answers: answerList });
      } catch (e) {
        if (!api.isSessionExpired(e.message)) throw e;
        api.resetLogin();
        payload = await api.getSharePayload(getApp().globalData.shareTicket);
        await api.post(`/surveys/${sid}/answer`, { ...payload, answers: answerList });
      }
      wx.showToast({ title: '提交成功', icon: 'success' });
      setTimeout(() => this.load(), 600);
    } catch (e) {
      wx.showModal({ title: '無法提交', content: e.message, showCancel: false });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
