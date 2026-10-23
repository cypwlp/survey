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
  data: { title: '', timeText: '', row: null, items: [], error: '' },

  onLoad() {
    const d = wx.getStorageSync('surveyResponseDetail');
    if (!d || !d.row) {
      this.setData({ error: '找不到這份答卷，請返回列表重新選一份。' });
      return;
    }
    const map = {};
    (d.row.answers || []).forEach((a) => { map[a.k] = a.value; });
    const items = (d.questions || []).map((q, i) => {
      const raw = map[q.k] === undefined || map[q.k] === null ? '' : String(map[q.k]);
      return {
        no: i + 1,
        title: q.title,
        value: raw.trim() ? raw : '（未填）',
        filled: !!raw.trim(),
      };
    });
    this.setData({
      title: d.title || '答卷詳情',
      timeText: fmtTime(d.row.submitTime),
      row: d.row,
      items,
    });
  },

  back() {
    wx.navigateBack();
  },
});
