const api = require('../../../utils/api.js');
const { API_BASE } = require('../../../config.js');

Page({
  data: { id: 0, stats: null, loading: true, error: '', rate: '', exporting: false, maxGroupAnswerCount: 1 },

  onLoad(options) {
    this.setData({ id: Number(options.id || 0) });
    this.load();
  },

  async load() {
    try {
      const stats = await api.get(`/surveys/${this.data.id}/stats`);
      const rate = stats.visitCount > 0 ? Math.round((stats.answerCount / stats.visitCount) * 100) + '%' : '—';
      // 為選項分佈預算百分比寬度；高頻詞預算字級與色階
      stats.questions.forEach((q) => {
        if (q.type === 'choice') {
          const max = Math.max(1, ...q.distribution.map((d) => d.count));
          q.distribution.forEach((d) => { d.bar = Math.round((d.count / max) * 100) + '%'; });
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
      this.setData({ stats, rate, error: '', maxGroupAnswerCount });
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  exportCsv() {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    wx.request({
      url: `${API_BASE}/surveys/${this.data.id}/export.csv`,
      header: { Authorization: 'Bearer ' + api.getToken() },
      success: (resp) => {
        if (resp.statusCode === 200 && typeof resp.data === 'string') {
          wx.setClipboardData({
            data: resp.data.replace(/^\uFEFF/, ''),
            success: () => wx.showModal({
              title: '已複製 CSV',
              content: '內容已複製到剪貼簿，貼到 Excel 或記事本再另存為 .csv 即可。',
              showCancel: false,
            }),
          });
        } else {
          wx.showToast({ title: '匯出失敗', icon: 'none' });
        }
      },
      fail: () => wx.showToast({ title: '網路錯誤', icon: 'none' }),
      complete: () => this.setData({ exporting: false }),
    });
  },

  exportXlsx() {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    wx.showLoading({ title: '產生 Excel…' });
    wx.downloadFile({
      url: `${API_BASE}/surveys/${this.data.id}/export.xlsx`,
      header: { Authorization: 'Bearer ' + api.getToken() },
      success: (resp) => {
        if (resp.statusCode !== 200) {
          wx.showModal({ title: '匯出失敗', content: 'HTTP ' + resp.statusCode, showCancel: false });
          return;
        }
        wx.openDocument({
          filePath: resp.tempFilePath,
          fileType: 'xlsx',
          showMenu: true,
          fail: () => wx.showModal({
            title: '已下載但無法開啟',
            content: '模擬器常無法開啟 Excel，請改用「匯出 CSV」貼到記事本另存；真機或正式域名下這顆鈕可直接開啟／轉發。',
            showCancel: false,
          }),
        });
      },
      fail: (e) => wx.showModal({
        title: '下載失敗',
        content: (e.errMsg || '') + '\n模擬器請改用「匯出 CSV」；真機需要在後台配置 downloadFile 域名。',
        showCancel: false,
      }),
      complete: () => { wx.hideLoading(); this.setData({ exporting: false }); },
    });
  },
});
