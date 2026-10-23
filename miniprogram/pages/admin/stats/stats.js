const api = require('../../../utils/api.js');

const PALETTE = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316'];

// 後端時間是 UTC ISO；固定顯示為 +8 時區牆上時間
function fmtTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const d = new Date(t + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getUTCMonth() + 1) + '-' + d.getUTCDate() + ' ' + d.getUTCHours() + ':' + p(d.getUTCMinutes());
}

Page({
  data: { id: 0, stats: null, loading: true, error: '', rate: '', exporting: false, maxGroupAnswerCount: 1, lastSubmitText: '', deadlineText: '', todayCount: 0 },

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
      const stats = await api.get(`/surveys/${this.data.id}/stats`);
      const rate = stats.visitCount > 0 ? Math.round((stats.answerCount / stats.visitCount) * 100) + '%' : '—';
      // 為選項分佈預算百分比寬度；高頻詞預算字級與色階
      stats.questions.forEach((q) => {
        if (q.type === 'choice') {
          const max = Math.max(1, ...q.distribution.map((d) => d.count));
          q.distribution.forEach((d, idx) => {
            d.bar = Math.round((d.count / max) * 100) + '%';
            d.color = PALETTE[idx % PALETTE.length];
          });
        }
        if (q.words && q.words.length) {
          const max = Math.max(...q.words.map((w) => w.n));
          q.words.forEach((w) => {
            const r = w.n / max;
            w.fs = Math.round(26 + r * 24);
            w.tier = r >= 0.6 ? 0 : (r >= 0.3 ? 1 : 2);
          });
        }
      });
      const maxGroupAnswerCount = Math.max(1, ...(stats.perGroup || []).map((g) => g.answerCount));
      const daily = stats.daily || [];
      const maxDaily = Math.max(1, ...daily.map((d) => d.count));
      daily.forEach((d) => { d.h = Math.round((d.count / maxDaily) * 100); });
      this.setData({
        stats,
        rate,
        error: '',
        maxGroupAnswerCount,
        lastSubmitText: fmtTime(stats.lastSubmitTime),
        deadlineText: fmtTime(stats.deadline),
        todayCount: daily.length ? daily[daily.length - 1].count : 0,
      });
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  exportCsv() {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    api.getText(`/surveys/${this.data.id}/export.csv`)
      .then((text) => {
        wx.setClipboardData({
          data: String(text).replace(/^\uFEFF/, ''),
          success: () => wx.showModal({
            title: '已複製 CSV',
            content: '內容已複製到剪貼簿，貼到 Excel 或記事本再另存為 .csv 即可。',
            showCancel: false,
          }),
        });
      })
      .catch(() => wx.showToast({ title: '匯出失敗', icon: 'none' }))
      .then(() => this.setData({ exporting: false }));
  },

  exportXlsx() {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    wx.showLoading({ title: '產生 Excel…' });
    // 走 API 拿 base64 再自己寫檔：這條路不必配置 downloadFile 合法域名，
    // 雲托管 callContainer 鏈路也通（回包上限 1000KiB，後端超過 640KiB 會要你改用 CSV）。
    api.get(`/surveys/${this.data.id}/export.xlsx?format=base64`)
      .then((res) => new Promise((resolve, reject) => {
        if (!res || !res.base64) return reject(new Error('後端沒回檔案內容'));
        const filePath = `${wx.env.USER_DATA_PATH}/${res.filename || ('survey-' + this.data.id + '.xlsx')}`;
        wx.getFileSystemManager().writeFile({
          filePath,
          data: res.base64,
          encoding: 'base64',
          success: () => resolve(filePath),
          fail: (e) => reject(new Error(e.errMsg || '寫入檔案失敗')),
        });
      }))
      .then((filePath) => new Promise((resolve, reject) => {
        wx.openDocument({
          filePath,
          fileType: 'xlsx',
          showMenu: true,
          success: resolve,
          fail: () => reject(new Error('已下載但無法開啟：模擬器常打不開 Excel，請改用「匯出 CSV」。')),
        });
      }))
      .catch((e) => wx.showModal({ title: '匯出失敗', content: e.message || '未知錯誤', showCancel: false }))
      .then(() => { wx.hideLoading(); this.setData({ exporting: false }); });
  },

  goResponses() {
    wx.navigateTo({ url: `/pages/admin/responses/responses?id=${this.data.id}` });
  },
});
