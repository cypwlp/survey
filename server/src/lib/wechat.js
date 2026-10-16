import crypto from 'node:crypto';
import { config, wxDevMode } from '../config.js';

// openid → session_key（僅存記憶體；重啟後要求重新登入即可）
const sessionKeys = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function setSessionKey(openid, key) {
  sessionKeys.set(openid, { key, at: Date.now() });
}

export function getSessionKey(openid) {
  const hit = sessionKeys.get(openid);
  if (!hit) return null;
  if (Date.now() - hit.at > SESSION_TTL_MS) {
    sessionKeys.delete(openid);
    return null;
  }
  return hit.key;
}

export async function code2Session(code) {
  if (wxDevMode) {
    const openid = 'dev-' + crypto.createHash('sha1').update(String(code)).digest('hex').slice(0, 16);
    setSessionKey(openid, 'dev-session-key');
    return { openid };
  }
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', config.wx.appid);
  url.searchParams.set('secret', config.wx.secret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data.openid) throw new Error(`code2Session 失败：${data.errcode} ${data.errmsg}`);
  setSessionKey(data.openid, data.session_key);
  return { openid: data.openid };
}

/*
 * shareTicket 解密（自有伺服器路徑）：
 * 前端 wx.getShareInfo({ shareTicket }) 拿到 encryptedData + iv，
 * 後端用該用戶的 session_key 做 AES-128-CBC 解密，得到 { openGId, watermark }。
 * 註：微信已不支援前端直接解；雲開發是 cloudID/cloud.getOpenData 另一條路。
 */
export function decryptShareInfo({ openid, encryptedData, iv, devOpenGId }) {
  if (wxDevMode) {
    // dev 模式：允許前端傳 devOpenGId 模擬群標識，讓全鏈路可離線演練
    if (devOpenGId) return { openGId: String(devOpenGId).slice(0, 64), dev: true };
    throw new Error('dev 模式請帶 devOpenGId');
  }
  if (!encryptedData || !iv) throw new Error('缺少 encryptedData/iv');
  const sessionKey = getSessionKey(openid);
  if (!sessionKey) throw new Error('session_key 已過期，請重新登入後重試');
  const key = Buffer.from(sessionKey, 'base64');
  const ivBuf = Buffer.from(iv, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, ivBuf);
  decipher.setAutoPadding(true);
  let decoded;
  try {
    decoded = Buffer.concat([decipher.update(Buffer.from(encryptedData, 'base64')), decipher.final()]);
  } catch {
    throw new Error('shareTicket 解密失败（可能已過期，請重新從群卡片進入）');
  }
  const data = JSON.parse(decoded.toString('utf8'));
  if (data.watermark && data.watermark.appid && data.watermark.appid !== config.wx.appid) {
    throw new Error('分享資訊 appid 不符');
  }
  if (!data.openGId) throw new Error('分享資訊中沒有 openGId');
  return { openGId: data.openGId, dev: false };
}
