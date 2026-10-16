import { Router } from 'express';
import { code2Session } from '../lib/wechat.js';
import { issueToken } from '../lib/auth.js';

export const authRouter = Router();

// POST /api/auth/login  { code } → { token, openid }
authRouter.post('/auth/login', async (req, res) => {
  const code = String(req.body?.code || '');
  if (!code) return res.status(400).json({ error: '缺少 code' });
  try {
    const { openid } = await code2Session(code);
    res.json({ token: issueToken(openid), openid });
  } catch (e) {
    console.error('[login 失敗] code=' + code.slice(0, 12) + '… →', e.message);
    res.status(502).json({ error: e.message });
  }
});
