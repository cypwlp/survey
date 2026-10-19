/*
 * SQL Server → MySQL 一次性搬資料（正式搬家時，在一台同時連得到兩邊的機器上跑）
 *   cd server && cmd /c "node test/migrate-to-mysql.js"          # 演練：只數筆數，不寫入
 *   cd server && cmd /c "node test/migrate-to-mysql.js --apply"  # 真的搬（可重複執行，同 id 會覆蓋）
 *
 * 來源（SQL Server，唯讀，只 Select）：
 *   SRC_HOST / SRC_PORT(1433) / SRC_USER(sa) / SRC_PASSWORD / SRC_NAME(OSurveyDB)
 *   不填就沿用 .env 的 DB_SERVER / DB_USER / DB_PASSWORD / DB_NAME
 * 目標（MySQL）：
 *   DST_HOST / DST_PORT(3306) / DST_USER / DST_PASSWORD / DST_NAME(OSurveyDB)
 *   雲托管 MySQL 要先在控制台開「外網地址」才連得到，搬完記得關掉。
 *
 * 前置：目標庫先跑過 database/06_mysql_schema.sql。
 * 順序：Survey → SurveyGroup → Answer → Visit → GroupName（先父表，避開外鍵）。
 */
import 'dotenv/config';
import mssqlPkg from 'mssql';
import mysqlPkg from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const BATCH = 500;

const SRC = {
  server: process.env.SRC_HOST || process.env.DB_SERVER || '127.0.0.1',
  port: Number(process.env.SRC_PORT || 1433),
  user: process.env.SRC_USER || process.env.DB_USER || 'sa',
  password: process.env.SRC_PASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.SRC_NAME || process.env.DB_NAME || 'OSurveyDB',
};
const DST = {
  host: process.env.DST_HOST || process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DST_PORT || 3306),
  user: process.env.DST_USER || process.env.DB_USER || 'root',
  password: process.env.DST_PASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.DST_NAME || process.env.DB_NAME || 'OSurveyDB',
};

const TABLES = [
  { name: 'Survey', key: 'SurveyId', from: 'dbo.Survey',
    cols: ['SurveyId', 'Title', 'GroupName', 'OpenGId', 'BindMode', 'Announcement', 'QuestionsJson', 'CreatorOpenId', 'IsClosed', 'CreateTime', 'UpdateTime'] },
  { name: 'SurveyGroup', key: 'SurveyGroupId', from: 'dbo.SurveyGroup',
    cols: ['SurveyGroupId', 'SurveyId', 'OpenGId', 'FirstSeenAt'] },
  { name: 'Answer', key: 'AnswerId', from: 'dbo.Answer',
    cols: ['AnswerId', 'SurveyId', 'OpenId', 'OpenGId', 'AnswersJson', 'SubmitTime'] },
  { name: 'Visit', key: 'VisitId', from: 'dbo.Visit',
    cols: ['VisitId', 'SurveyId', 'OpenId', 'OpenGId', 'VisitTime'] },
  { name: 'GroupName', key: 'GroupNameId', from: 'dbo.GroupName',
    cols: ['GroupNameId', 'OpenId', 'Name', 'UseCount', 'LastUsedAt'] },
];

// SQL Server 的 Date / bit → MySQL 的 UTC 字串 / 0・1
function normalize(col, v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

const sql = await mssqlPkg.connect({
  server: SRC.server,
  port: SRC.port,
  user: SRC.user,
  password: SRC.password,
  database: SRC.database,
  options: { encrypt: false, trustServerCertificate: true },
});
const dbo = sql;   // 只是給下面的查詢一個短名字

let my = null;
if (APPLY) {
  my = await mysqlPkg.createConnection({ ...DST, dateStrings: true, multipleStatements: false });
  const [tb] = await my.query(
    `Select Table_Name From information_schema.Tables Where Table_Schema = Database()
     And Table_Name In ('Survey', 'Answer', 'Visit', 'SurveyGroup', 'GroupName');`,
  );
  if (tb.length !== 5) {
    console.error(`目標庫只有 ${tb.length}/5 張表，請先在 ${DST.database} 執行 database/06_mysql_schema.sql`);
    process.exit(1);
  }
}

console.log(`來源 SQL Server：${SRC.server}:${SRC.port}/${SRC.database}`);
console.log(`目標 MySQL   ：${DST.host}:${DST.port}/${DST.database}${APPLY ? '' : '（演練中，不會寫入）'}`);

const report = [];
for (const t of TABLES) {
  const rs = await dbo.request().query(`Select ${t.cols.join(', ')} From ${t.from} Order By ${t.key};`);
  const rows = rs.recordset || [];
  let written = 0;
  if (APPLY && rows.length) {
    const setClause = t.cols.filter((c) => c !== t.key).map((c) => `${c} = Values(${c})`).join(', ');
    const holders = `(${t.cols.map(() => '?').join(', ')})`;
    // 逐列 insert（不是多列 Value 批次）：問卷量小，這樣最不容易踩 SQL 方言差異
    for (const [idx, row] of rows.entries()) {
      const [res] = await my.query(
        `Insert Into ${t.name} (${t.cols.join(', ')}) Values ${holders} On Duplicate Key Update ${setClause};`,
        t.cols.map((c) => normalize(c, row[c])),
      );
      written += res.affectedRows;
      if ((idx + 1) % BATCH === 0) process.stdout.write(`\r  ${t.name} … ${idx + 1}/${rows.length}`);
    }
  }
  report.push({ 表: t.name, 來源筆數: rows.length, 已寫入: APPLY ? written : '（演練）' });
}

if (APPLY) {
  // 回讀比對：兩邊筆數要一致
  for (const t of TABLES) {
    const rs = await dbo.request().query(`Select Count(*) As n From ${t.from};`);
    const [cnt] = await my.query(`Select Count(*) As n From ${t.name};`);
    const src = Number(rs.recordset[0].n);
    const dst = Number(cnt[0].n);
    const hit = report.find((r) => r.表 === t.name);
    hit.目標筆數 = dst;
    hit.結果 = dst === src ? '✓' : '✗ 不一致';
  }
}

console.table(report);
console.log(APPLY ? '\n搬遷完成。記得回雲托管控制台把 MySQL 外網地址關掉。' : '\n以上是演練結果；確認無誤後加 --apply 真的搬。');
console.log('提醒：SQL Server 這邊一個字都沒改（全程只 Select）。');

if (my) await my.end();
await sql.close();
process.exit(0);
