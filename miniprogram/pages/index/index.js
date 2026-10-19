const api = require('../../utils/api.js');
const { API_BASE, CLOUD_FUNCTION } = require('../../config.js');
// 首頁只顯示「現在的後端是哪一條鏈路」，方便一眼確認有沒有接上
const BACKEND_LABEL = CLOUD_FUNCTION ? ('雲開發（雲函式 ' + CLOUD_FUNCTION + '）') : API_BASE;

// 只有開發版（開發者工具／真機調試）顯示技術資訊（openid、後端鏈路、開發提示）。
// 體驗版、正式版都對用戶隱藏 —— 體驗版也可能給同事／外部體驗成員看。
// 取不到版本資訊時一律當正式版處理（寧可不顯示，也不要漏給用戶看）。
function isDevMode() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion === 'develop';
  } catch (e) {
    return false;
  }
}

Page({
  data: {
    openid: '',
    apiBase: BACKEND_LABEL,
    devMode: isDevMode(),
    loginErr: '',
    steps: [
      { t: '建立問卷', d: '管理員輸入群名、貼上公告，確認 5W 題目' },
      { t: '分享到群', d: '送出問卷卡片到微信群，成員從卡片進入' },
      { t: '成員答題', d: '逐項回答後提交，系統自動去重（一人一份）' },
      { t: '回收統計', d: '看提交率、選項分佈、高頻詞，匯出 Excel／CSV' },
    ],
  },

  onShow() {
    this.setData({ apiBase: BACKEND_LABEL });
    api.ensureLogin()
      .then(() => this.setData({ openid: api.getOpenid(), loginErr: '' }))
      .catch((e) => this.setData({ openid: '', loginErr: e.message }));
  },

  retryLogin() {
    api.ensureLogin()
      .then(() => this.setData({ openid: api.getOpenid(), loginErr: '' }))
      .catch((e) => this.setData({ openid: '', loginErr: e.message }));
  },

  goCreate() { wx.navigateTo({ url: '/pages/admin/create/create' }); },
  goList() { wx.navigateTo({ url: '/pages/admin/list/list' }); },
});
