import { config } from './config.js';

/*
 * 三種驅動（對外方法語意一致；unique 索引衝突一律丟 { code: 'DUPLICATE' }）：
 *  - mssql ：連 SQL Server（自架正式）。資料表由 database/01_schema.sql 建立（T_ 表＋同名檢視）。
 *  - mysql ：連 MySQL（微信雲托管 MySQL 或自架）。表結構見 database/06_mysql_schema.sql。
 *  - memory：記憶體示範（重啟即清空），讓沒有 DB 也能跑通全鏈路。
 */
function duplicateError(msg) {
  const e = new Error(msg || '重複資料');
  e.code = 'DUPLICATE';
  return e;
}

function memoryDriver() {
  let seqSurvey = 0;
  let seqAnswer = 0;
  let seqVisit = 0;
  let seqGroup = 0;
  let seqGroupName = 0;
  const surveys = new Map();
  const answers = [];
  const visits = [];
  const groups = [];
  const groupNames = [];
  const now = () => new Date().toISOString();

  return {
    async createSurvey({ title, groupName, bindMode, announcement, questionsJson, creatorOpenId }) {
      const id = ++seqSurvey;
      surveys.set(id, {
        SurveyId: id, Title: title, GroupName: groupName || null, OpenGId: null,
        BindMode: bindMode, Announcement: announcement || null, QuestionsJson: questionsJson,
        CreatorOpenId: creatorOpenId, IsClosed: false, CreateTime: now(), UpdateTime: now(),
      });
      return id;
    },
    async getSurvey(id) {
      const s = surveys.get(Number(id));
      return s ? { ...s } : null;   // 回傳副本，避免呼叫端持有參照時被後續寫入改到
    },
    async listSurveys(creatorOpenId) {
      return [...surveys.values()]
        .filter((s) => s.CreatorOpenId === creatorOpenId)
        .sort((a, b) => b.SurveyId - a.SurveyId)
        .map((s) => ({
          ...s,
          AnswerCount: answers.filter((a) => a.SurveyId === s.SurveyId).length,
          VisitCount: visits.filter((v) => v.SurveyId === s.SurveyId).length,
        }));
    },
    async setClosed(id, closed) {
      const s = surveys.get(Number(id));
      if (!s) return false;
      s.IsClosed = !!closed;
      s.UpdateTime = now();
      return true;
    },
    async updateSurveyQuestions(id, questionsJson) {
      const s = surveys.get(Number(id));
      if (!s) return false;
      s.QuestionsJson = questionsJson;
      s.UpdateTime = now();
      return true;
    },
    async bindGroup(id, openGId) {
      const s = surveys.get(Number(id));
      if (!s || s.OpenGId) return false;
      s.OpenGId = openGId;
      s.UpdateTime = now();
      return true;
    },
    async clearGroup(id) {
      const s = surveys.get(Number(id));
      if (!s) return false;
      s.OpenGId = null;
      s.UpdateTime = now();
      return true;
    },
    // 多群：一個問卷可歸屬多個群（第一次從某群進入就加入）
    async bindSurveyGroup(surveyId, openGId) {
      const sid = Number(surveyId);
      if (!surveys.has(sid)) return false;
      if (groups.some((g) => g.SurveyId === sid && g.OpenGId === openGId)) return false;
      groups.push({ SurveyGroupId: ++seqGroup, SurveyId: sid, OpenGId: openGId, FirstSeenAt: now() });
      return true;
    },
    async listSurveyGroups(surveyId) {
      return groups
        .filter((g) => g.SurveyId === Number(surveyId))
        .sort((a, b) => a.SurveyGroupId - b.SurveyGroupId)
        .map((g) => ({ ...g }));
    },
    async clearSurveyGroup(surveyId) {
      const sid = Number(surveyId);
      const before = groups.length;
      for (let i = groups.length - 1; i >= 0; i--) if (groups[i].SurveyId === sid) groups.splice(i, 1);
      return before !== groups.length;
    },
    // 群名歷史：每位管理員一份，存資料庫所以換手機不丟
    async touchGroupNames(openid, names) {
      const list = (Array.isArray(names) ? names : [names])
        .map((n) => String(n || '').trim().slice(0, 100))
        .filter(Boolean);
      for (const name of list) {
        const hit = groupNames.find((g) => g.OpenId === openid && g.Name === name);
        if (hit) { hit.UseCount += 1; hit.LastUsedAt = now(); }
        else groupNames.push({ GroupNameId: ++seqGroupName, OpenId: openid, Name: name, UseCount: 1, LastUsedAt: now() });
      }
      return list.length;
    },
    async listGroupNames(openid, limit = 50) {
      return groupNames
        .filter((g) => g.OpenId === openid)
        .sort((a, b) => String(b.LastUsedAt).localeCompare(String(a.LastUsedAt)))
        .slice(0, limit)
        .map((g) => ({ ...g }));
    },
    async getAnswer(surveyId, openid) {
      const a = answers.find((x) => x.SurveyId === Number(surveyId) && x.OpenId === openid);
      return a ? { ...a } : null;
    },
    async insertAnswer({ surveyId, openid, openGId, answersJson }) {
      if (answers.some((a) => a.SurveyId === Number(surveyId) && a.OpenId === openid)) {
        throw duplicateError('此問卷已提交過');
      }
      const row = {
        AnswerId: ++seqAnswer, SurveyId: Number(surveyId), OpenId: openid,
        OpenGId: openGId || null, AnswersJson: answersJson, SubmitTime: now(),
      };
      answers.push(row);
      return row;
    },
    async saveVisit(surveyId, openid, openGId) {
      const sid = Number(surveyId);
      if (visits.some((v) => v.SurveyId === sid && v.OpenId === openid)) return false;
      visits.push({ VisitId: ++seqVisit, SurveyId: sid, OpenId: openid, OpenGId: openGId || null, VisitTime: now() });
      return true;
    },
    async countVisits(surveyId) {
      return visits.filter((v) => v.SurveyId === Number(surveyId)).length;
    },
    async listAnswers(surveyId) {
      return answers
        .filter((a) => a.SurveyId === Number(surveyId))
        .sort((a, b) => a.AnswerId - b.AnswerId);
    },
    async check() {
      return { ok: true, driver: 'memory', detail: '記憶體驅動（重啟即清空）' };
    },
    async raw() {
      throw new Error('memory 驅動不支援 raw SQL（對账腳本請用 DB_DRIVER=mssql）');
    },
  };
}

/* ---------------------------------------------------------------
 * MySQL 驅動（微信雲托管 MySQL／自架 MySQL 5.7+）
 * 直接用同名表：Survey / Answer / Visit / SurveyGroup / GroupName。
 * （不沿用 SQL Server 那套 T_ 表＋檢視：MySQL 沒有 DENY 權限模型，
 *   而雲托管 MySQL 是專用庫，不需要借檢視隔離寫入權限。）
 * 時間欄位一律由程式寫入 UTC 牆上時間，讀出轉成 ISO（帶 Z），
 * 讓 API 回應與 mssql 驅動一致，不受容器時區影響。
 * ------------------------------------------------------------- */
function mysqlDriver() {
  let poolPromise = null;
  async function pool() {
    if (!poolPromise) {
      poolPromise = (async () => {
        const { default: mysql } = await import('mysql2/promise');
        return mysql.createPool({
          host: config.db.host,
          port: config.db.port,
          user: config.db.user,
          password: config.db.password,
          database: config.db.database,
          waitForConnections: true,
          connectionLimit: 10,
          dateStrings: true,   // 時間以字串回傳，再由 stamp() 轉 ISO；不讓驅動用本機時區改寫
        });
      })().catch((e) => { poolPromise = null; throw e; });
    }
    return poolPromise;
  }
  async function q(text, params = []) {
    const p = await pool();
    const [rows] = await p.query(text, params);
    return rows;
  }

  const isDup = (e) => !!e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);
  const num = (v) => Number(v);
  const nowUtc = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const TIME_COLS = ['CreateTime', 'UpdateTime', 'SubmitTime', 'VisitTime', 'FirstSeenAt', 'LastUsedAt'];
  // 'YYYY-MM-DD HH:MM:SS'（UTC）→ 'YYYY-MM-DDTHH:MM:SSZ'，讓 JSON 輸出與 mssql 的 Date 一致
  function stamp(row) {
    if (!row) return row;
    for (const k of TIME_COLS) {
      const v = row[k];
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) row[k] = v.replace(' ', 'T') + 'Z';
    }
    return row;
  }
  const stampAll = (rows) => (rows || []).map(stamp);

  return {
    async createSurvey({ title, groupName, bindMode, announcement, questionsJson, creatorOpenId }) {
      const now = nowUtc();
      const r = await q(
        `Insert Into Survey (Title, GroupName, BindMode, Announcement, QuestionsJson, CreatorOpenId, CreateTime, UpdateTime)
         Values (?, ?, ?, ?, ?, ?, ?, ?);`,
        [title, groupName || null, bindMode, announcement || null, questionsJson, creatorOpenId, now, now],
      );
      return num(r.insertId);
    },
    async getSurvey(id) {
      const rows = await q('Select * From Survey Where SurveyId = ?;', [num(id)]);
      return stamp(rows[0]) || null;
    },
    async listSurveys(creatorOpenId) {
      const rows = await q(
        `Select s.SurveyId, s.Title, s.GroupName, s.OpenGId, s.BindMode, s.IsClosed, s.CreateTime, s.UpdateTime,
                (Select Count(*) From Answer a Where a.SurveyId = s.SurveyId) As AnswerCount,
                (Select Count(*) From Visit v Where v.SurveyId = s.SurveyId) As VisitCount
         From Survey s Where s.CreatorOpenId = ? Order By s.SurveyId Desc;`,
        [creatorOpenId],
      );
      return stampAll(rows);
    },
    async setClosed(id, closed) {
      const r = await q('Update Survey Set IsClosed = ?, UpdateTime = ? Where SurveyId = ?;', [closed ? 1 : 0, nowUtc(), num(id)]);
      return r.affectedRows > 0;
    },
    async updateSurveyQuestions(id, questionsJson) {
      const r = await q('Update Survey Set QuestionsJson = ?, UpdateTime = ? Where SurveyId = ?;', [questionsJson, nowUtc(), num(id)]);
      return r.affectedRows > 0;
    },
    async bindGroup(id, openGId) {
      const r = await q('Update Survey Set OpenGId = ?, UpdateTime = ? Where SurveyId = ? And OpenGId Is Null;', [openGId, nowUtc(), num(id)]);
      return r.affectedRows > 0;
    },
    async clearGroup(id) {
      const r = await q('Update Survey Set OpenGId = Null, UpdateTime = ? Where SurveyId = ?;', [nowUtc(), num(id)]);
      return r.affectedRows > 0;
    },
    // 多群：一個問卷可歸屬多個群（第一次從某群進入就加入）
    async bindSurveyGroup(surveyId, openGId) {
      try {
        await q('Insert Into SurveyGroup (SurveyId, OpenGId, FirstSeenAt) Values (?, ?, ?);', [num(surveyId), openGId, nowUtc()]);
        return true;
      } catch (e) {
        if (isDup(e)) return false;
        throw e;
      }
    },
    async listSurveyGroups(surveyId) {
      const rows = await q('Select * From SurveyGroup Where SurveyId = ? Order By SurveyGroupId;', [num(surveyId)]);
      return stampAll(rows);
    },
    async clearSurveyGroup(surveyId) {
      const r = await q('Delete From SurveyGroup Where SurveyId = ?;', [num(surveyId)]);
      return r.affectedRows > 0;
    },
    // 群名歷史：每位管理員一份，存資料庫所以換手機不丟
    async touchGroupNames(openid, names) {
      const list = (Array.isArray(names) ? names : [names])
        .map((n) => String(n || '').trim().slice(0, 100))
        .filter(Boolean);
      for (const name of list) {
        const upd = await q(
          'Update GroupName Set UseCount = UseCount + 1, LastUsedAt = ? Where OpenId = ? And Name = ?;',
          [nowUtc(), openid, name],
        );
        if (upd.affectedRows > 0) continue;
        try {
          await q('Insert Into GroupName (OpenId, Name, UseCount, LastUsedAt) Values (?, ?, 1, ?);', [openid, name, nowUtc()]);
        } catch (e) {
          if (!isDup(e)) throw e;
          await q('Update GroupName Set UseCount = UseCount + 1, LastUsedAt = ? Where OpenId = ? And Name = ?;', [nowUtc(), openid, name]);
        }
      }
      return list.length;
    },
    async listGroupNames(openid, limit = 50) {
      const rows = await q(
        'Select * From GroupName Where OpenId = ? Order By LastUsedAt Desc, GroupNameId Desc Limit ?;',
        [openid, num(limit)],
      );
      return stampAll(rows);
    },
    async getAnswer(surveyId, openid) {
      const rows = await q('Select * From Answer Where SurveyId = ? And OpenId = ? Limit 1;', [num(surveyId), openid]);
      return stamp(rows[0]) || null;
    },
    async insertAnswer({ surveyId, openid, openGId, answersJson }) {
      try {
        const r = await q(
          'Insert Into Answer (SurveyId, OpenId, OpenGId, AnswersJson, SubmitTime) Values (?, ?, ?, ?, ?);',
          [num(surveyId), openid, openGId || null, answersJson, nowUtc()],
        );
        const rows = await q('Select AnswerId, SubmitTime From Answer Where AnswerId = ?;', [num(r.insertId)]);
        return stamp(rows[0]);
      } catch (e) {
        if (isDup(e)) throw duplicateError('此問卷已提交過');
        throw e;
      }
    },
    async saveVisit(surveyId, openid, openGId) {
      const hit = await q('Select VisitId From Visit Where SurveyId = ? And OpenId = ? Limit 1;', [num(surveyId), openid]);
      if (hit.length) return false;
      try {
        await q('Insert Into Visit (SurveyId, OpenId, OpenGId, VisitTime) Values (?, ?, ?, ?);', [num(surveyId), openid, openGId || null, nowUtc()]);
        return true;
      } catch (e) {
        if (isDup(e)) return false;   // 併發時另一方先寫入，視為已記過
        throw e;
      }
    },
    async countVisits(surveyId) {
      const rows = await q('Select Count(*) As N From Visit Where SurveyId = ?;', [num(surveyId)]);
      return num(rows[0].N);
    },
    async listAnswers(surveyId) {
      const rows = await q('Select * From Answer Where SurveyId = ? Order By AnswerId;', [num(surveyId)]);
      return stampAll(rows);
    },
    // 原始 SQL（腳本／運維用，API 不使用）。參數用 ? 位置佔位（mssql 驅動是 @Name）。
    async raw(sql, params = []) {
      const p = await pool();
      const [result] = await p.query(sql, params);
      if (Array.isArray(result)) return { rows: stampAll(result), affected: 0 };
      return { rows: [], affected: num(result.affectedRows || 0) };
    },
    async check() {
      try {
        const meta = await q('Select Version() As ver, Database() As dbname;');
        const t = await q(
          `Select Count(*) As n From information_schema.tables
           Where table_schema = Database() And table_name In ('Survey', 'Answer', 'Visit', 'SurveyGroup', 'GroupName');`,
        );
        const tables = num(t[0].n);
        const base = {
          ok: true,
          driver: 'mysql',
          detail: meta[0].dbname,
          version: String(meta[0].ver).split('-')[0],
          tables,
          tablesOk: tables === 5,
        };
        if (!base.tablesOk) return { ...base, rows: null };
        const c = await q(
          `Select (Select Count(*) From Survey) As s, (Select Count(*) From Answer) As a,
                  (Select Count(*) From Visit) As v;`,
        );
        return { ...base, rows: { Survey: num(c[0].s), Answer: num(c[0].a), Visit: num(c[0].v) } };
      } catch (e) {
        return { ok: false, driver: 'mysql', detail: e.message };
      }
    },
  };
}

function mssqlDriver() {
  let poolPromise = null;
  async function pool() {
    if (!poolPromise) {
      poolPromise = (async () => {
        const { default: sql } = await import('mssql');
        return new sql.ConnectionPool({
          server: config.db.server,
          port: config.db.port,
          user: config.db.user,
          password: config.db.password,
          database: config.db.database,
          options: { encrypt: false, trustServerCertificate: true },
          pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
        }).connect();
      })().catch((e) => { poolPromise = null; throw e; });
    }
    return poolPromise;
  }
  async function q(text, params = {}) {
    const p = await pool();
    const req = p.request();
    for (const [k, v] of Object.entries(params)) req.input(k, v);
    return req.query(text);
  }

  return {
    async createSurvey({ title, groupName, bindMode, announcement, questionsJson, creatorOpenId }) {
      const r = await q(
        `Insert Into dbo.Survey (Title, GroupName, BindMode, Announcement, QuestionsJson, CreatorOpenId)
         Output Inserted.SurveyId
         Values (@Title, @GroupName, @BindMode, @Announcement, @QuestionsJson, @CreatorOpenId);`,
        { Title: title, GroupName: groupName || null, BindMode: bindMode, Announcement: announcement || null, QuestionsJson: questionsJson, CreatorOpenId: creatorOpenId },
      );
      return r.recordset[0].SurveyId;
    },
    async getSurvey(id) {
      const r = await q('Select * From dbo.Survey Where SurveyId = @Id;', { Id: Number(id) });
      return r.recordset[0] || null;
    },
    async listSurveys(creatorOpenId) {
      const r = await q(
        `Select s.SurveyId, s.Title, s.GroupName, s.OpenGId, s.BindMode, s.IsClosed, s.CreateTime, s.UpdateTime,
                (Select Count(*) From dbo.Answer a Where a.SurveyId = s.SurveyId) As AnswerCount,
                (Select Count(*) From dbo.Visit v Where v.SurveyId = s.SurveyId) As VisitCount
         From dbo.Survey s Where s.CreatorOpenId = @CreatorOpenId Order By s.SurveyId Desc;`,
        { CreatorOpenId: creatorOpenId },
      );
      return r.recordset;
    },
    async setClosed(id, closed) {
      const r = await q('Update dbo.Survey Set IsClosed = @Closed, UpdateTime = SysUtcDateTime() Where SurveyId = @Id;', { Id: Number(id), Closed: closed ? 1 : 0 });
      return r.rowsAffected[0] > 0;
    },
    async updateSurveyQuestions(id, questionsJson) {
      const r = await q('Update dbo.Survey Set QuestionsJson = @Json, UpdateTime = SysUtcDateTime() Where SurveyId = @Id;', { Id: Number(id), Json: questionsJson });
      return r.rowsAffected[0] > 0;
    },
    async bindGroup(id, openGId) {
      const r = await q('Update dbo.Survey Set OpenGId = @OpenGId, UpdateTime = SysUtcDateTime() Where SurveyId = @Id And OpenGId Is Null;', { Id: Number(id), OpenGId: openGId });
      return r.rowsAffected[0] > 0;
    },
    async clearGroup(id) {
      const r = await q('Update dbo.Survey Set OpenGId = Null, UpdateTime = SysUtcDateTime() Where SurveyId = @Id;', { Id: Number(id) });
      return r.rowsAffected[0] > 0;
    },
    // 多群：第一次從某群進入就加入；併發下靠唯一索引（UQ_SurveyGroup_Survey_Open）擋重
    async bindSurveyGroup(surveyId, openGId) {
      try {
        await q(
          'Insert Into dbo.SurveyGroup (SurveyId, OpenGId) Values (@Sid, @Gid);',
          { Sid: Number(surveyId), Gid: openGId },
        );
        return true;
      } catch (e) {
        if (e.number === 2601 || e.number === 2627) return false;
        throw e;
      }
    },
    async listSurveyGroups(surveyId) {
      const r = await q(
        'Select * From dbo.SurveyGroup Where SurveyId = @Sid Order By SurveyGroupId;',
        { Sid: Number(surveyId) },
      );
      return r.recordset;
    },
    async clearSurveyGroup(surveyId) {
      const r = await q('Delete From dbo.SurveyGroup Where SurveyId = @Sid;', { Sid: Number(surveyId) });
      return r.rowsAffected.reduce((a, b) => a + b, 0) > 0;
    },
    // 群名歷史：寫檢視；已存在就只累計使用次數（靠唯一鍵 UQ_GroupName_Open_Name 判重複）
    async touchGroupNames(openid, names) {
      const list = (Array.isArray(names) ? names : [names])
        .map((n) => String(n || '').trim().slice(0, 100))
        .filter(Boolean);
      for (const name of list) {
        try {
          await q('Insert Into dbo.GroupName (OpenId, Name) Values (@OpenId, @Name);', { OpenId: openid, Name: name });
        } catch (e) {
          if (e.number === 2601 || e.number === 2627) {
            await q(
              'Update dbo.GroupName Set UseCount = UseCount + 1, LastUsedAt = SysUtcDateTime() Where OpenId = @OpenId And Name = @Name;',
              { OpenId: openid, Name: name },
            );
          } else throw e;
        }
      }
      return list.length;
    },
    async listGroupNames(openid, limit = 50) {
      const r = await q(
        'Select Top (@Lim) * From dbo.GroupName Where OpenId = @OpenId Order By LastUsedAt Desc, GroupNameId Desc;',
        { OpenId: openid, Lim: Number(limit) },
      );
      return r.recordset;
    },
    async getAnswer(surveyId, openid) {
      const r = await q('Select Top 1 * From dbo.Answer Where SurveyId = @Sid And OpenId = @OpenId;', { Sid: Number(surveyId), OpenId: openid });
      return r.recordset[0] || null;
    },
    async insertAnswer({ surveyId, openid, openGId, answersJson }) {
      try {
        const r = await q(
          `Insert Into dbo.Answer (SurveyId, OpenId, OpenGId, AnswersJson)
           Output Inserted.AnswerId, Inserted.SubmitTime
           Values (@Sid, @OpenId, @OpenGId, @AnswersJson);`,
          { Sid: Number(surveyId), OpenId: openid, OpenGId: openGId || null, AnswersJson: answersJson },
        );
        return r.recordset[0];
      } catch (e) {
        if (e.number === 2601 || e.number === 2627) throw duplicateError('此問卷已提交過');
        throw e;
      }
    },
    async saveVisit(surveyId, openid, openGId) {
      const r = await q(
        `If Not Exists (Select 1 From dbo.Visit Where SurveyId = @Sid And OpenId = @OpenId)
         Insert Into dbo.Visit (SurveyId, OpenId, OpenGId) Values (@Sid, @OpenId, @OpenGId);`,
        { Sid: Number(surveyId), OpenId: openid, OpenGId: openGId || null },
      );
      return r.rowsAffected[0] > 0;
    },
    async countVisits(surveyId) {
      const r = await q('Select Count(*) As N From dbo.Visit Where SurveyId = @Sid;', { Sid: Number(surveyId) });
      return r.recordset[0].N;
    },
    async listAnswers(surveyId) {
      const r = await q('Select * From dbo.Answer Where SurveyId = @Sid Order By AnswerId;', { Sid: Number(surveyId) });
      return r.recordset;
    },
    async raw(sql, params = {}) {
      const r = await q(sql, params);
      return {
        rows: r.recordset || [],
        affected: r.rowsAffected ? r.rowsAffected.reduce((a, b) => a + b, 0) : 0,
      };
    },
    async check() {
      try {
        // 刻意只依賴「檢視」：若照 03_view_only_grants.sql 對 T_ 表下 DENY，
        // 這個帳號連 sys.tables 都看不見 T_ 表（元資料可見度綁權限），
        // 用 sys.tables 數會誤判成沒建表。能經檢視查到列＝擁有權鏈正常＝結構可用。
        const r = await q(
          `Select DB_Name() As db, @@Version As ver,
                  (Select Count(*) From sys.views Where name In (N'Survey', N'Answer', N'Visit', N'SurveyGroup')) As v,
                  (Select Count(*) From dbo.Survey) As s,
                  (Select Count(*) From dbo.Answer) As a,
                  (Select Count(*) From dbo.Visit) As visit;`,
        );
        const row = r.recordset[0];
        return {
          ok: true,
          driver: 'mssql',
          detail: row.db,
          version: String(row.ver).split('(')[0].trim().replace(/\s+on .*/i, ''),
          views: row.v,
          rows: { Survey: row.s, Answer: row.a, Visit: row.visit },
          tablesOk: row.v === 4,
        };
      } catch (e) {
        return { ok: false, driver: 'mssql', detail: e.message };
      }
    },
  };
}

export const db = config.dbDriver === 'mssql' ? mssqlDriver()
  : config.dbDriver === 'mysql' ? mysqlDriver()
    : memoryDriver();

// 啟動自检與 /api/health 用（不拋錯，回傳狀況）
export const checkDb = () => db.check();
