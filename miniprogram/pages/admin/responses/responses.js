const api = require('../../../utils/api.js');

// 後端時間是 UTC ISO；固定顯示為 +8 時區牆上時間
function fmtTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const d = new Date(t + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getUTCMonth() + 1) + '-' + d.getUTCDate() + ' ' + d.getUTCHours() + ':' + p(d.getUTCMinutes());
}

Page({
  data: { id: 0, title: '', count: 0, list: [], loading: true, error: '' },

  onLoad(options) {
    this.setData({ id: Number(options.id || 0) });
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    try {
      const res = await api.get(`/surveys/${this.data.id}/responses`);
      const questions = res.questions || [];
      const list = (res.list || []).map((row) => {
        const answerMap = {};
        (row.answers || []).forEach((a) => { answerMap[a.k] = a.value; });
        const first = questions.find((q) => ((answerMap[q.k] || '') + '').trim() !== '');
        const preview = first ? String(answerMap[first.k] || '').slice(0, 40) : '（尚未作答）';
        return { ...row, timeText: fmtTime(row.submitTime), preview };
      });
      this.setData({ title: res.title || '', count: res.count || list.length, questions, list, error: '' });
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  open(e) {
    const i = Number(e.currentTarget.dataset.i);
    const row = this.data.list[i];
    if (!row) return;
    wx.setStorageSync('surveyResponseDetail', {
      title: this.data.title,
      questions: this.data.questions || [],
      row,
    });
    wx.navigateTo({ url: '/pages/admin/response/response' });
  },
});
