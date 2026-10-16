const api = require('../../../utils/api.js');

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
  data: { list: [], loading: true, error: '' },

  onShow() {
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.get('/surveys');
      const list = (res.list || []).map((s) => ({ ...s, dateText: fmtTime(s.CreateTime) }));
      this.setData({ list });
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  open(e) {
    wx.navigateTo({ url: `/pages/admin/survey/survey?id=${e.currentTarget.dataset.id}` });
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/admin/create/create' });
  },
});
