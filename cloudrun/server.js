const express = require('express');
const path = require('path');
const https = require('https');

const APPID = process.env.WX_APPID || '';
const SECRET = process.env.WX_SECRET || '';
const TCB_ENV = process.env.TCB_ENV || '';
const FUNCTION_NAME = process.env.FUNCTION_NAME || 'osurvey';
const PORT = Number(process.env.PORT || 80);
// 微信雲托管的默認出網代理會替換 TLS 憑證（官方社區已知問題）。
// 只有明確設置 ALLOW_INSECURE_TLS=1 才接受該憑證，默認仍然嚴格校驗。
const ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS === '1';

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

app.get('/api/health', async (req, res) => {
  try {
    const out = await invokeCloudFunction({ method: 'GET', path: '/health', data: {}, query: {} });
    res.status(out.statusCode || 200).json(out.data || out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 通用代理：前端傳 { method, path, data, query, openid }
app.post('/api/proxy', async (req, res) => {
  try {
    const body = req.body || {};
    const out = await invokeCloudFunction({
      method: String(body.method || 'GET').toUpperCase(),
      path: String(body.path || '/'),
      data: body.data || {},
      query: body.query || {},
      openid: String(body.openid || ''),
    });
    res.status(out.statusCode || 200).json(out.data || out);
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
});
