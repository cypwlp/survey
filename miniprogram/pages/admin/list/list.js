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
  data: {
    list: [],
    filtered: [],
    visibleList: [],
    visibleCount: 20,
    loading: true,
    error: '',
    keyword: '',
    filter: 'all',
    counts: { all: 0, live: 0, ended: 0 },
  },

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
      const list = (res.list || []).map((s) => ({
        ...s,
        dateText: fmtTime(s.CreateTime),
        deadlineText: fmtTime(s.Deadline),
        isExpired: !!(s.Deadline && Date.parse(s.Deadline) <= Date.now()),
      }));
      this.setData({ list }, () => this.applyFilter(true));
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  open(e) {
    wx.navigateTo({ url: `/pages/admin/survey/survey?id=${e.currentTarget.dataset.id}` });
  },

  applyFilter(reset = false) {
    const list = this.data.list;
    const visibleCount = reset ? 20 : this.data.visibleCount;
    const kw = this.data.keyword.trim().toLowerCase();
    const filter = this.data.filter;
    const filtered = list.filter((s) => {
      const ended = !!(s.IsClosed || s.isExpired);
      if (filter === 'live' && ended) return false;
      if (filter === 'ended' && !ended) return false;
      if (!kw) return true;
      return ((s.Title || '') + ' ' + (s.GroupName || '')).toLowerCase().indexOf(kw) >= 0;
    });
    this.setData({
      filtered,
      visibleList: filtered.slice(0, visibleCount),
      visibleCount,
      counts: {
        all: list.length,
        live: list.filter((s) => !s.IsClosed && !s.isExpired).length,
        ended: list.filter((s) => s.IsClosed || s.isExpired).length,
      },
    });
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value }, () => this.applyFilter(true));
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.f }, () => this.applyFilter(true));
  },

  clearKeyword() {
    this.setData({ keyword: '' }, () => this.applyFilter(true));
  },

  clearAllFilter() {
    this.setData({ keyword: '', filter: 'all' }, () => this.applyFilter(true));
  },

  loadMore() {
    const visibleCount = this.data.visibleCount + 20;
    this.setData({ visibleCount, visibleList: this.data.filtered.slice(0, visibleCount) });
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/admin/create/create' });
  },

  // 隱私指引承諾保存 365 天：一鍵清理自己問卷裡超過期限的答卷與開啟記錄
  async purgeOld() {
    const modal = await new Promise((r) => wx.showModal({
      title: '清理舊數據',
      content: '將刪除你名下問卷中 365 天前的答卷與開啟記錄（不可恢復），問卷本身保留。確定嗎？',
      confirmText: '清理',
      confirmColor: '#ef4444',
      success: r,
    }));
    if (!modal.confirm) return;
    try {
      const res = await api.post('/admin/purge', { days: 365 });
      wx.showToast({ title: `已清理 ${res.answers} 份答卷、${res.visits} 筆開啟`, icon: 'none' });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
