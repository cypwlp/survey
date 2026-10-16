const api = require('./utils/api.js');

App({
  globalData: {
    shareTicket: '',
    enterOptions: null,
  },

  onLaunch(options) {
    this.captureShare(options);
    api.ensureLogin().catch((e) => console.warn('登入失敗', e));
  },

  onShow(options) {
    this.captureShare(options);
  },

  captureShare(options) {
    this.globalData.enterOptions = options || null;
    let st = options && options.shareTicket;
    // 部分基礎庫版本的 onShow options 不带 shareTicket，依規格用同步 API 兜底
    if (!st && typeof wx.getEnterOptionsSync === 'function') {
      try { st = wx.getEnterOptionsSync().shareTicket; } catch (e) { /* 忽略 */ }
    }
    if (!st && typeof wx.getLaunchOptionsSync === 'function') {
      try { st = wx.getLaunchOptionsSync().shareTicket; } catch (e) { /* 忽略 */ }
    }
    if (st) this.globalData.shareTicket = st;
  },
});
