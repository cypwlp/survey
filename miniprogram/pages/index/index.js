const api = require('../../utils/api.js');
const { API_BASE } = require('../../config.js');

Page({
  data: {
    openid: '',
    apiBase: API_BASE,
    loginErr: '',
    steps: [
      { t: '建立問卷', d: '管理員輸入群名、貼上公告，確認 5W 題目' },
      { t: '分享到群', d: '送出問卷卡片到微信群，成員從卡片進入' },
      { t: '成員答題', d: '逐項回答後提交，系統自動去重（一人一份）' },
      { t: '回收統計', d: '看提交率、選項分佈、高頻詞，匯出 Excel／CSV' },
    ],
  },

  onShow() {
    this.setData({ apiBase: API_BASE });
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
