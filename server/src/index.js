import { createApp } from './app.js';
import { config, wxDevMode } from './config.js';
import { checkDb } from './db.js';

const app = createApp();
app.listen(config.port, async () => {
  const mode = config.dbDriver === 'mssql'
    ? `SQL Server ${config.db.server}:${config.db.port}/${config.db.database}`
    : 'memory（重啟即清空）';
  console.log(`Survey-System server listening on http://0.0.0.0:${config.port}`);
  console.log(`  DB  ：${mode}`);
  console.log(`  微信 ：${wxDevMode ? 'dev 模式（未設 WX_APPID/WX_SECRET，允許假 openid/openGId 演練）' : '正式模式'}`);

  const dbState = await checkDb();
  if (!dbState.ok) {
    console.error(`  ✗ 資料庫連不上：${dbState.detail}`);
    console.error('    檢查 .env 的 DB_SERVER/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME，以及 SQL Server 是否允許 TCP 1433 與 SQL 驗證');
  } else if (dbState.driver === 'mssql') {
    console.log(`  ✓ 已連線：${dbState.detail}｜${dbState.version}`);
    if (!dbState.tablesOk) {
      console.error(`  ✗ 檢視不就緒（找到 ${dbState.views}/4 個：需要 Survey / Answer / Visit / SurveyGroup）`);
      console.error('    全新庫：F5 database/01_schema.sql；舊版表結構：F5 database/02_t_plus_view.sql');
      console.error('    多群模型：F5 database/04_multi_group.sql');
    } else {
      const r = dbState.rows;
      console.log(`  ✓ 結構就緒：四個檢視可用（經檢視列數 Survey=${r.Survey} Answer=${r.Answer} Visit=${r.Visit}）`);
    }
  }
});
