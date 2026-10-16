import crypto from 'node:crypto';
import { config } from '../config.js';

const TTL_MS = 24 * 60 * 60 * 1000;

function sign(payload) {
  return crypto.createHmac('sha256', config.tokenSecret).update(payload).digest('base64url');
}

export function issueToken(openid) {
  const payload = Buffer.from(JSON.stringify({ o: openid, t: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expect = sign(payload);
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.o || Date.now() - data.t > TTL_MS) return null;
    return data.o;
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : req.headers['x-token'];
  const openid = verifyToken(token);
  if (!openid) return res.status(401).json({ error: '未登入或凭证已过期' });
  req.openid = openid;
  next();
}
