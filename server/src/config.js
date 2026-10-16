import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  dbDriver: process.env.DB_DRIVER || 'memory',
  db: {
    server: process.env.DB_SERVER || '127.0.0.1',
    port: Number(process.env.DB_PORT || 1433),
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'SurveySystem',
  },
  wx: {
    appid: process.env.WX_APPID || '',
    secret: process.env.WX_SECRET || '',
  },
  tokenSecret: process.env.TOKEN_SECRET || 'change-me-please-a-long-random-string',
};

export const wxDevMode = !config.wx.appid || !config.wx.secret;
