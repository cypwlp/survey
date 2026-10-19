import 'dotenv/config';

// 驅動：mssql = SQL Server（自架正式）／mysql = MySQL（微信雲托管或自架）／memory = 記憶體示範
const dbDriver = process.env.DB_DRIVER || 'memory';
// 兩種關聯式驅動共用同一組欄位名（DB_HOST 與 DB_SERVER 都吃），只有預設值不同
const dbHost = process.env.DB_HOST || process.env.DB_SERVER || '127.0.0.1';

export const config = {
  port: Number(process.env.PORT || 3000),
  dbDriver,
  db: {
    server: dbHost,          // mssql 驅動沿用這個欄位名
    host: dbHost,
    port: Number(process.env.DB_PORT || (dbDriver === 'mysql' ? 3306 : 1433)),
    user: process.env.DB_USER || (dbDriver === 'mysql' ? 'root' : 'sa'),
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || (dbDriver === 'mysql' ? 'OSurveyDB' : 'SurveySystem'),
  },
  wx: {
    appid: process.env.WX_APPID || '',
    secret: process.env.WX_SECRET || '',
  },
  tokenSecret: process.env.TOKEN_SECRET || 'change-me-please-a-long-random-string',
};

export const wxDevMode = !config.wx.appid || !config.wx.secret;
