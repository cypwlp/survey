const api = require('../../utils/api.js');

Page({
  data: {
    loading: true,
    err: '',
    bound: false,
    username: '',
    displayName: '',
    usernameInput: '',
    password: '',
    password2: '',
    saving: false,
  },

  onShow() { this.reload(); },

  async reload() {
    this.setData({ loading: true, err: '' });
    try {
      await api.ensureLogin();
      const me = await api.get('/webaccount/me');
      this.setData({
        loading: false,
        bound: !!me.bound,
        username: me.username || '',
        displayName: me.displayName || me.username || '',
      });
    } catch (e) {
      this.setData({ loading: false, err: e.message || '載入失敗' });
    }
  },

  onUsername(e) { this.setData({ usernameInput: e.detail.value }); },
  onPassword(e) { this.setData({ password: e.detail.value }); },
  onPassword2(e) { this.setData({ password2: e.detail.value }); },

  async submit() {
    if (this.data.saving) return;
    const password = String(this.data.password || '');
    if (password.length < 6 || password.length > 72) {
      wx.showToast({ title: '密碼需 6~72 位', icon: 'none' });
      return;
    }

    if (this.data.bound) {
      if (password !== String(this.data.password2 || '')) {
        wx.showToast({ title: '兩次輸入不一致', icon: 'none' });
        return;
      }
      this.setData({ saving: true });
      try {
        const res = await api.post('/webaccount/self-reset', { password });
        this.setData({ password: '', password2: '' });
        wx.showModal({
          title: '密碼已重設',
          content: '帳號 ' + res.username + ' 的網頁密碼已更新，請回網頁用新密碼登入。',
          showCancel: false,
        });
      } catch (e) {
        wx.showToast({ title: e.message || '重設失敗', icon: 'none' });
      } finally {
        this.setData({ saving: false });
      }
      return;
    }

    const username = String(this.data.usernameInput || '').trim();
    if (!username) {
      wx.showToast({ title: '請輸入網頁用戶名', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const res = await api.post('/webaccount/bind-by-password', { username, password });
      this.setData({
        bound: true,
        username: res.username,
        displayName: res.displayName || res.username,
        password: '',
        password2: '',
      });
      wx.showModal({
        title: '綁定成功',
        content: '已把這個微信綁定到網頁帳號 ' + res.username + '。',
        showCancel: false,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '綁定失敗', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
