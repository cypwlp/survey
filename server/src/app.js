import express from 'express';
import cors from 'cors';
import { config, wxDevMode } from './config.js';
import { checkDb } from './db.js';
import { authRouter } from './routes/auth.js';
import { surveysRouter } from './routes/surveys.js';
import { answersRouter } from './routes/answers.js';
import { statsRouter } from './routes/stats.js';

export function createApp() {
  const app = express();
  // wx.request 會帶 If-None-Match 回來，Express 預設的 ETag 會讓伺服器回 304 空本體，
  // 而小程序端只把 2xx 當成功 → 304 會被誤判成錯誤。API 一律不快取。
  app.set('etag', false);
  app.use(cors());
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    const t = Date.now();
    res.on('finish', () => {
      const stamp = new Date().toTimeString().slice(0, 8);
      console.log(`${stamp} ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - t}ms)`);
    });
    next();
  });

  app.get('/api/health', async (req, res) => {
    const dbState = await checkDb();
    res.status(dbState.ok ? 200 : 503).json({ ok: dbState.ok, driver: config.dbDriver, wxDevMode, db: dbState });
  });

  app.use('/api', authRouter, surveysRouter, answersRouter, statsRouter);

  app.use((req, res) => res.status(404).json({ error: '找不到此 API' }));
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: '伺服器錯誤：' + err.message });
  });
  return app;
}
