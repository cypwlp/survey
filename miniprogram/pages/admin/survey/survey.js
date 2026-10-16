const api = require('../../../utils/api.js');

Page({
  data: { id: 0, survey: null, loading: true, error: '' },

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
    return { title, path: `/pages/answer/answer?sid=${this.data.id}`, imageUrl: '/images/survey-cover.jpg' };
  },

  goStats() {
    wx.navigateTo({ url: `/pages/admin/stats/stats?id=${this.data.id}` });
  },

  copyPath() {
    wx.setClipboardData({
      data: `/pages/answer/answer?sid=${this.data.id}`,
      success: () => wx.showToast({ title: '已複製分享路徑', icon: 'none' }),
    });
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
