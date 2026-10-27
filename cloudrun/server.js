const express = require('express');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const QRCode = require('qrcode');
const mock = require('./mock');

const APPID = process.env.WX_APPID || '';
const SECRET = process.env.WX_SECRET || '';
const TCB_ENV = process.env.TCB_ENV || '';
const FUNCTION_NAME = process.env.FUNCTION_NAME || 'osurvey';
const PORT = Number(process.env.PORT || 80);
const ADMIN_PASSWORD = process.env.WEB_ADMIN_PASSWORD || '';
const ADMIN_OPENID = process.env.WEB_ADMIN_OPENID || '';
const ADMIN_USERNAME = process.env.WEB_ADMIN_USERNAME || 'admin';
const SESSION_SECRET = process.env.WEB_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// 微信雲托管的默認出網代理會替換 TLS 憑證（官方社區已知問題）。
// 只有明確設置 ALLOW_INSECURE_TLS=1 才接受該憑證，默認仍然嚴格校驗。
const ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS === '1';
// 僅本機預覽用；正式環境不要設 MOCK_API
const MOCK_API = process.env.MOCK_API === '1';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'web')));

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function signSession(user) {
  const payload = {
    uid: user.userId,
    username: user.username,
    displayName: user.displayName || user.username,
    identity: user.identity,
    boundOpenId: user.boundOpenId || null,
    exp: Date.now() + 7 * 86400000,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  return body + '.' + sig;
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function readSession(req) {
  const token = parseCookies(req).sid || '';
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const body = parts[0];
  const expect = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
function isHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function setSession(res, req, user) {
  const token = signSession(user);
  res.setHeader('Set-Cookie', 'sid=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800' + (isHttps(req) ? '; Secure' : ''));
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function sessionUser(s) {
  if (!s) return null;
  return {
    userId: s.uid,
    username: s.username,
    displayName: s.displayName,
    identity: s.identity,
    boundOpenId: s.boundOpenId || null,
    isLegacyAdmin: s.uid === 'admin',
  };
}

function requestJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname,
      servername: u.hostname,
      path: u.pathname + u.search,
      method,
      timeout: 15000,
      rejectUnauthorized: !ALLOW_INSECURE_TLS,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          reject(new Error('上游回傳不是 JSON：' + raw.slice(0, 300)));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('上游請求逾時')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestBuffer(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname,
      servername: u.hostname,
      path: u.pathname + u.search,
      method,
      timeout: 15000,
      rejectUnauthorized: !ALLOW_INSECURE_TLS,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const type = String(res.headers['content-type'] || '');
        if (type.includes('application/json')) {
          let data = {};
          try { data = JSON.parse(buf.toString('utf8')); } catch (e) { data = {}; }
          reject(new Error(data.errmsg || data.message || ('上游回傳錯誤：' + buf.toString('utf8').slice(0, 300))));
          return;
        }
        resolve(buf);
      });
    });
    req.on('timeout', () => req.destroy(new Error('上游請求逾時')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let tokenCache = { value: '', expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.value;
  if (!APPID || !SECRET) throw new Error('缺少 WX_APPID / WX_SECRET 環境變量');
  const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential'
    + '&appid=' + encodeURIComponent(APPID)
    + '&secret=' + encodeURIComponent(SECRET);
  const r = await requestJson('GET', url);
  if (!r.access_token) throw new Error('取得 access_token 失敗：' + JSON.stringify(r));
  tokenCache = {
    value: r.access_token,
    expiresAt: Date.now() + (Number(r.expires_in) || 7200) * 1000,
  };
  return tokenCache.value;
}

async function genMiniProgramCode({ scene, page }) {
  const token = await getAccessToken();
  const url = 'https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=' + encodeURIComponent(token);
  return requestBuffer('POST', url, {
    scene,
    page: page || 'pages/answer/answer',
    check_path: false,
    env_version: 'release',
    width: 430,
  });
}

async function invokeCloudFunction(event) {
  if (!TCB_ENV) throw new Error('缺少 TCB_ENV 環境變量');
  const token = await getAccessToken();
  const url = 'https://api.weixin.qq.com/tcb/invokecloudfunction'
    + '?access_token=' + encodeURIComponent(token)
    + '&env=' + encodeURIComponent(TCB_ENV)
    + '&name=' + encodeURIComponent(FUNCTION_NAME);
  const r = await requestJson('POST', url, event);
  if (r.errcode) throw new Error('invokecloudfunction 失敗 ' + r.errcode + '：' + (r.errmsg || ''));
  const raw = r.resp_data;
  return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
}

// 受訪者能呼叫的公開路徑（避免公開代理變成任意雲函數入口）
const PUBLIC_PATHS = [
  /^\/surveys\/\d+$/,
  /^\/surveys\/\d+\/visit$/,
  /^\/surveys\/\d+\/answer$/,
];

function isPublicPath(p) {
  return PUBLIC_PATHS.some((re) => re.test(p));
}

app.get('/api/health', async (req, res) => {
  if (MOCK_API) return res.json(mock.health());
  try {
    const out = await invokeCloudFunction({ method: 'GET', path: '/health', data: {}, query: {} });
    res.status(out.statusCode || 200).json(out.data || out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/webauth/login', async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!username || !password) return res.status(400).json({ error: '請輸入用戶名和密碼' });

  // 舊的單一管理員密碼保留作登入橋樑，避免改版後鎖死
  if (username === ADMIN_USERNAME.toLowerCase()) {
    if (!ADMIN_PASSWORD || !ADMIN_OPENID) return res.status(500).json({ error: '缺少 WEB_ADMIN_PASSWORD / WEB_ADMIN_OPENID' });
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: '用戶名或密碼不正確' });
    const user = { userId: 'admin', username: ADMIN_USERNAME, displayName: '管理員', identity: ADMIN_OPENID, boundOpenId: ADMIN_OPENID };
    setSession(res, req, user);
    return res.json({ user: { ...user, isLegacyAdmin: true } });
  }

  try {
    const out = await invokeCloudFunction({
      method: 'POST', path: '/webauth/login',
      data: { username, password }, query: {}, openid: '',
    });
    if (out.statusCode !== 200) return res.status(out.statusCode || 502).json(out.data || { error: '登入失敗' });
    const user = out.data.user;
    setSession(res, req, user);
    res.json({ user });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/webauth/register', async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  if (username === ADMIN_USERNAME.toLowerCase()) return res.status(409).json({ error: '這個用戶名是保留的' });
  try {
    const out = await invokeCloudFunction({
      method: 'POST', path: '/webauth/register',
      data: { username, password: String(body.password || ''), displayName: String(body.displayName || '') },
      query: {}, openid: '',
    });
    if (out.statusCode !== 200) return res.status(out.statusCode || 502).json(out.data || { error: '註冊失敗' });
    const user = out.data.user;
    setSession(res, req, user);
    res.json({ user });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/webauth/me', (req, res) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: '未登入' });
  res.json({ user: sessionUser(s) });
});

app.post('/api/webauth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.post('/api/account/bind/create', async (req, res) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: '未登入' });
  if (s.uid === 'admin' || s.boundOpenId) return res.status(400).json({ error: '管理員或已綁定帳號不需要再綁定' });
  try {
    const out = await invokeCloudFunction({
      method: 'POST', path: '/webaccount/bind/create',
      data: { userId: s.uid, webUid: String((req.body && req.body.webUid) || '') },
      query: {}, openid: s.identity,
    });
    if (out.statusCode !== 200) return res.status(out.statusCode || 502).json(out.data || { error: '建立綁定碼失敗' });
    const token = out.data.token;
    const png = await genMiniProgramCode({ scene: 'sid=' + token, page: 'pages/answer/answer' });
    res.json({ token, qr: 'data:image/png;base64,' + png.toString('base64') });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/account/bind/status', async (req, res) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: '未登入' });
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: '缺少綁定碼' });
  try {
    const out = await invokeCloudFunction({
      method: 'GET', path: '/webaccount/bind/status',
      data: {}, query: { token }, openid: s.identity,
    });
    if (out.statusCode !== 200) return res.status(out.statusCode || 502).json(out.data || { error: '查詢綁定狀態失敗' });
    const data = out.data || {};
    if (data.status === 'confirmed' && data.openid) {
      const user = {
        userId: s.uid, username: s.username, displayName: s.displayName,
        identity: data.openid, boundOpenId: data.openid,
      };
      setSession(res, req, user);
      return res.json({ status: 'confirmed', user });
    }
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 管理端代理：用登入 Session；openid 用該用戶自己的身份
app.post('/api/admin/proxy', async (req, res) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: '請先登入' });
  if (MOCK_API) {
    const out = mock.admin(String((req.body && req.body.path) || '/'), String((req.body && req.body.method) || 'GET').toUpperCase());
    return res.status(out.status || 200).json(out.data);
  }
  try {
    const body = req.body || {};
    const out = await invokeCloudFunction({
      method: String(body.method || 'GET').toUpperCase(),
      path: String(body.path || '/'),
      data: body.data || {},
      query: body.query || {},
      openid: s.identity,
    });
    res.status(out.statusCode || 200).json(out.data || out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 受訪者代理：只允許作答/看問卷/記開啟；登入後用帳號身份，否則用瀏覽器 UUID
app.post('/api/public/proxy', async (req, res) => {
  try {
    const body = req.body || {};
    const p = String(body.path || '/');
    if (!isPublicPath(p)) return res.status(403).json({ error: '此接口不開放' });
    const s = readSession(req);
    const openid = String((s && s.identity) || body.openid || '').trim();
    if (!openid || openid.length < 8 || openid.length > 64) {
      return res.status(400).json({ error: '缺少訪客標識' });
    }
    if (MOCK_API) {
      const out = mock.publicApi(p, String(body.method || 'GET').toUpperCase());
      return res.status(out.status || 200).json(out.data);
    }
    const out = await invokeCloudFunction({
      method: String(body.method || 'GET').toUpperCase(),
      path: p,
      data: body.data || {},
      query: body.query || {},
      openid,
    });
    res.status(out.statusCode || 200).json(out.data || out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 分享連結二維碼
app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 1024);
  if (!text) return res.status(400).json({ error: '缺少 text' });
  try {
    const buf = await QRCode.toBuffer(text, {
      type: 'png', width: 480, margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    res.type('png').send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 產生「小程序作答碼」：讓網頁建立的問卷可以直接在 1.0.7 小程序裡填
app.post('/api/survey/qrcode', async (req, res) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: '請先登入' });
  const id = Number(req.body && req.body.id);
  if (!id) return res.status(400).json({ error: '缺少問卷編號' });
  try {
    const png = await genMiniProgramCode({ scene: 'sid=' + id, page: 'pages/answer/answer' });
    res.json({ qr: 'data:image/png;base64,' + png.toString('base64') });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// SPA fallback（Express 5 的 '*' 會踩 path-to-regexp，這裡用 use）
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
});

app.listen(PORT, () => {
  console.log('[cloudrun] listening on ' + PORT);
  if (ALLOW_INSECURE_TLS) {
    console.warn('[cloudrun] ALLOW_INSECURE_TLS=1：已接受微信雲托管出網代理的憑證（僅測試用）');
  }
  if (MOCK_API) console.warn('[cloudrun] MOCK_API=1：使用本機假資料（正式環境不要開）');
});
