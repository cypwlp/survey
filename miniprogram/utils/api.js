const { API_BASE, DEV_OPEN_GID } = require('../config.js');
const DEV_MODE = !!DEV_OPEN_GID;

let loginPromise = null;

// dev 演練用假 code（遊客模式下 wx.login 可能失敗，此時仍能打通本機後端）
function devCode() {
  let c = wx.getStorageSync('devCode');
  if (!c) {
    c = 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    wx.setStorageSync('devCode', c);
  }
  return c;
}

// 取得 shareTicket（app.onLaunch/onShow 捕捉）後向微信換分享資訊；
// 拿不到（非群卡片進入 / devtools 遊客模式）時，若設了 DEV_OPEN_GID 則用它演練。
function getSharePayload(shareTicket) {
  if (!shareTicket) {
    return Promise.resolve(DEV_OPEN_GID ? { devOpenGId: DEV_OPEN_GID } : {});
  }
  return new Promise((resolve) => {
    wx.getShareInfo({
      shareTicket,
      success: (res) => resolve({ encryptedData: res.encryptedData, iv: res.iv }),
      fail: () => resolve(DEV_OPEN_GID ? { devOpenGId: DEV_OPEN_GID } : {}),
    });
  });
}

function doLogin() {
  return new Promise((resolve, reject) => {
    const fail = (msg) => {
      loginPromise = null;
      wx.setStorageSync('loginError', msg);
      reject(new Error(msg));
    };
    const send = (code) => wx.request({
      url: API_BASE + '/auth/login',
      method: 'POST',
      data: { code },
      success: (resp) => {
        if (resp.statusCode === 200 && resp.data.token) {
          wx.setStorageSync('token', resp.data.token);
          wx.setStorageSync('openid', resp.data.openid);
          wx.setStorageSync('loginError', '');
          resolve(resp.data);
        } else {
          fail('後端拒絕登入：' + ((resp.data && resp.data.error) || ('HTTP ' + resp.statusCode)));
        }
      },
      fail: (e) => fail('連不到後端（' + API_BASE + '）：' + (e.errMsg || '網路錯誤')),
    });
    wx.login({
      success: (r) => {
        if (r.code) return send(r.code);
        if (DEV_MODE) return send(devCode());
        fail('wx.login 沒回 code');
      },
      fail: (e) => {
        if (DEV_MODE) return send(devCode());
        fail('wx.login 失敗：' + (e.errMsg || '未知原因'));
      },
    });
  });
}

function ensureLogin() {
  if (!loginPromise) {
    loginPromise = doLogin().catch((e) => { loginPromise = null; throw e; });
  }
  return loginPromise;
}

function request(method, path, data, retry = true) {
  return ensureLogin().then((login) => new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE + path,
      method,
      data,
      header: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token },
      success: (resp) => {
        if (resp.statusCode === 401 && retry) {
          loginPromise = null;
          request(method, path, data, false).then(resolve, reject);
          return;
        }
        if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(resp.data);
        else reject(new Error((resp.data && resp.data.error) || ('HTTP ' + resp.statusCode)));
      },
      fail: (e) => reject(new Error(e.errMsg || '網路錯誤')),
    });
  }));
}

module.exports = {
  ensureLogin,
  getSharePayload,
  getToken: () => wx.getStorageSync('token') || '',
  getOpenid: () => wx.getStorageSync('openid') || '',
  getLoginError: () => wx.getStorageSync('loginError') || '',
  get: (path) => request('GET', path),
  post: (path, data) => request('POST', path, data),
};
