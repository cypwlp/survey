const express = require('express');
const path = require('path');
const https = require('https');
const QRCode = require('qrcode');
const mock = require('./mock');

const APPID = process.env.WX_APPID || '';
const SECRET = process.env.WX_SECRET || '';
const TCB_ENV = process.env.TCB_ENV || '';
const FUNCTION_NAME = process.env.FUNCTION_NAME || 'osurvey';
const PORT = Number(process.env.PORT || 80);
const ADMIN_PASSWORD = process.env.WEB_ADMIN_PASSWORD || '';
const ADMIN_OPENID = process.env.WEB_ADMIN_OPENID || '';
// 微信雲托管的默認出網代理會替換 TLS 憑證（官方社區已知問題）。
// 只有明確設置 ALLOW_INSECURE_TLS=1 才接受該憑證，默認仍然嚴格校驗。
const ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS === '1';
// 僅本機預覽用；正式環境不要設 MOCK_API
const MOCK_API = process.env.MOCK_API === '1';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'web')));

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

// 管理端代理：一定要帶 x-admin-password；openid 固定用 WEB_ADMIN_OPENID
app.post('/api/admin/proxy', async (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: '缺少 WEB_ADMIN_PASSWORD 環境變量' });
  if (req.get('x-admin-password') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '管理員密碼不正確' });
  }
  if (!ADMIN_OPENID) return res.status(500).json({ error: '缺少 WEB_ADMIN_OPENID 環境變量' });
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
      openid: ADMIN_OPENID,
    });
    res.status(out.statusCode || 200).json(out.data || out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 受訪者代理：只允許作答/看問卷/記開啟；openid 用瀏覽器 UUID
app.post('/api/public/proxy', async (req, res) => {
  try {
    const body = req.body || {};
    const p = String(body.path || '/');
    if (!isPublicPath(p)) return res.status(403).json({ error: '此接口不開放' });
    const openid = String(body.openid || '').trim();
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
