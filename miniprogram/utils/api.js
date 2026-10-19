const { API_BASE, DEV_OPEN_GID, CLOUD_ENV, CLOUD_SERVICE, CLOUD_FUNCTION } = require('../config.js');
const DEV_MODE = !!DEV_OPEN_GID;

// 三條鏈路（見 config.js 說明）：
//   USE_FUNCTION  → wx.cloud.callFunction（雲開發；免域名、免 443、免備案，推薦）
//   USE_CONTAINER → wx.cloud.callContainer（雲托管內網）
//   都不是        → wx.request + API_BASE（自架 https／本機）
const USE_FUNCTION = !!CLOUD_FUNCTION;
const USE_CONTAINER = !USE_FUNCTION && !!(CLOUD_ENV && CLOUD_SERVICE);
let cloudInited = false;

const where = () => (USE_FUNCTION
  ? ('雲開發 ' + CLOUD_FUNCTION + (CLOUD_ENV ? '@' + CLOUD_ENV : ''))
  : (USE_CONTAINER ? ('雲托管 ' + CLOUD_ENV + '/' + CLOUD_SERVICE) : API_BASE));

function ensureCloudInit() {
  if (cloudInited) return;
  wx.cloud.init(CLOUD_ENV ? { env: CLOUD_ENV, traceUser: false } : { traceUser: false });
  cloudInited = true;
}

// 頁面沿用原本的 '/surveys/8/export.xlsx?format=base64' 寫法，這裡才拆出 query
function splitQuery(p) {
  const s = String(p || '');
  const i = s.indexOf('?');
  if (i < 0) return { path: s, query: {} };
  const query = {};
  for (const kv of s.slice(i + 1).split('&')) {
    if (!kv) continue;
    const eq = kv.indexOf('=');
    const k = eq < 0 ? kv : kv.slice(0, eq);
    const v = eq < 0 ? '' : kv.slice(eq + 1);
    query[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return { path: s.slice(0, i), query };
}

// 把三條鏈路包成同一個介面：resolve({ statusCode, data })
function callApi(opts) {
  return new Promise((resolve, reject) => {
    if (USE_FUNCTION) {
      ensureCloudInit();
      const parts = splitQuery(opts.path);
      const data = Object.assign({}, opts.data || {});
      // CloudID 只有放在 event 的最上層，微信才會把它換成開放資料（群 openGId），
      // 所以從 body 裡提出來放最上層；值本身是同一個物件，不會被複製壞。
      const shareCloudId = data.shareCloudId;
      delete data.shareCloudId;
      wx.cloud.callFunction({
        name: CLOUD_FUNCTION,
        data: { method: opts.method, path: parts.path, query: parts.query, data: data, shareCloudId: shareCloudId },
        success: (resp) => {
          const r = (resp && resp.result) || {};
          resolve({ statusCode: r.statusCode === undefined ? 200 : r.statusCode, data: r.data });
        },
        fail: (e) => reject(new Error((e && e.errMsg) || '雲函式呼叫失敗')),
      });
      return;
    }

    if (!USE_CONTAINER) {
      wx.request({
        url: API_BASE + opts.path,
        method: opts.method,
        data: opts.data,
        header: opts.header,
        responseType: opts.responseType,
        success: (resp) => resolve({ statusCode: resp.statusCode, data: resp.data }),
        fail: (e) => reject(new Error(e.errMsg || '網路錯誤')),
      });
      return;
    }

    ensureCloudInit();
    wx.cloud.callContainer({
      config: { env: CLOUD_ENV },
      path: '/api' + opts.path,       // 後端路由都掛在 /api 底下
      method: opts.method,
      data: opts.data,
      header: Object.assign({ 'X-WX-SERVICE': CLOUD_SERVICE }, opts.header || {}),
      dataType: opts.dataType || 'json',
      responseType: opts.responseType || 'text',
      success: (resp) => resolve({ statusCode: resp.statusCode === undefined ? 200 : resp.statusCode, data: resp.data }),
      fail: (e) => reject(new Error(e.errMsg || '雲托管呼叫失敗')),
    });
  });
}

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

// 取得 shareTicket（app.onLaunch/onShow 捕捉）後向微信換分享資訊。
// 雲開發：wx.getShareInfo 會多回一個 cloudID，交給雲函式就能拿到開放資料（含 openGId），
//         不必自己解密、也不必管 session_key 過期。
// 自架：回 encryptedData + iv，由後端用 session_key AES 解密。
function getSharePayload(shareTicket) {
  const fallback = () => (DEV_OPEN_GID ? { devOpenGId: DEV_OPEN_GID } : {});
  if (!shareTicket) return Promise.resolve(fallback());
  return new Promise((resolve) => {
    wx.getShareInfo({
      shareTicket,
      success: (res) => {
        if (USE_FUNCTION) {
          ensureCloudInit();
          if (res.cloudID && wx.cloud && wx.cloud.CloudID) return resolve({ shareCloudId: wx.cloud.CloudID(res.cloudID) });
          return resolve(fallback());
        }
        resolve({ encryptedData: res.encryptedData, iv: res.iv });
      },
      fail: () => resolve(fallback()),
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

    // 雲開發不需要登入：openid 由雲函式的 cloud.getWXContext() 直接給，
    // 這裡只是問一次「我是誰」，讓首頁能顯示 openid、也順便驗證連線通不通。
    if (USE_FUNCTION) {
      callApi({ method: 'GET', path: '/auth/whoami' }).then((resp) => {
        if (resp.statusCode === 200 && resp.data && resp.data.openid) {
          wx.setStorageSync('openid', resp.data.openid);
          wx.setStorageSync('loginError', '');
          resolve({ openid: resp.data.openid, token: '' });
        } else {
          fail('雲函式沒回 openid：' + ((resp.data && resp.data.error) || ('HTTP ' + resp.statusCode)));
        }
      }).catch((e) => fail('連不到雲函式（' + where() + '）：' + (e.message || '網路錯誤')));
      return;
    }

    const send = (code) => callApi({
      method: 'POST',
      path: '/auth/login',
      data: { code },
      header: { 'Content-Type': 'application/json' },
    }).then((resp) => {
      if (resp.statusCode === 200 && resp.data && resp.data.token) {
        wx.setStorageSync('token', resp.data.token);
        wx.setStorageSync('openid', resp.data.openid);
        wx.setStorageSync('loginError', '');
        resolve(resp.data);
      } else {
        fail('後端拒絕登入：' + ((resp.data && resp.data.error) || ('HTTP ' + resp.statusCode)));
      }
    }).catch((e) => fail('連不到後端（' + where() + '）：' + (e.message || '網路錯誤')));
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

function authHeader(login) {
  const h = { 'Content-Type': 'application/json' };
  if (login.token) h.Authorization = 'Bearer ' + login.token;
  return h;
}

function request(method, path, data, retry = true) {
  return ensureLogin().then((login) => callApi({
    method,
    path,
    data,
    header: authHeader(login),
  })).then((resp) => {
    if (resp.statusCode === 401 && retry) {
      loginPromise = null;
      return request(method, path, data, false);
    }
    if (resp.statusCode >= 200 && resp.statusCode < 300) return resp.data;
    throw new Error((resp.data && resp.data.error) || ('HTTP ' + resp.statusCode));
  });
}

// 取純文字（CSV 匯出用）：callContainer 要 dataType:'text' 才不會被 JSON.parse 吃掉
function getText(path) {
  return ensureLogin().then((login) => callApi({
    method: 'GET',
    path,
    header: authHeader(login),
    dataType: 'text',
  })).then((resp) => {
    if (resp.statusCode !== 200) throw new Error((resp.data && resp.data.error) || ('HTTP ' + resp.statusCode));
    return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  });
}

// 這次拿到的分享資訊夠不夠用來歸群？三條鏈路各帶不同欄位。
function hasSharePayload(p) {
  if (!p) return false;
  return !!(p.shareCloudId || p.encryptedData || p.devOpenGId);
}

module.exports = {
  ensureLogin,
  getSharePayload,
  hasSharePayload,
  // 自架版：後端說 session_key 失靈時（服務重啟或超過 24 小時）必須重新登入，
  // 且重新呼叫 wx.getShareInfo 取新的 encryptedData —— 舊密文用新金鑰解不開。
  // 雲開發沒有 session_key 這回事，永遠不必重試。
  resetLogin: () => { if (!USE_FUNCTION) loginPromise = null; },
  isSessionExpired: (msg) => (USE_FUNCTION ? false : /session_key|解密失败|解密失敗/.test(String(msg || ''))),
  getToken: () => wx.getStorageSync('token') || '',
  getOpenid: () => wx.getStorageSync('openid') || '',
  getLoginError: () => wx.getStorageSync('loginError') || '',
  get: (path) => request('GET', path),
  post: (path, data) => request('POST', path, data),
  getText,
  usesContainer: () => USE_CONTAINER,
  usesCloudFunction: () => USE_FUNCTION,
  initCloud: ensureCloudInit,
  describeMode: () => (USE_FUNCTION ? '雲開發（雲函式 ' + CLOUD_FUNCTION + '）' : (USE_CONTAINER ? '雲托管（' + CLOUD_SERVICE + '）' : API_BASE)),
  where,
};
