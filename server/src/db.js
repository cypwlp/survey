import { config } from './config.js';

/*
 * 兩種驅動：
 *  - mssql ：連 SQL Server（正式）。資料表由 database/01_schema.sql 建立。
 *  - memory：記憶體示範（重啟即清空），讓沒有 DB 也能跑通全鏈路。
 * 對外方法語意一致；unique 索引衝突一律丟 { code: 'DUPLICATE' }。
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
  const surveys = new Map();
  const answers = [];
  const visits = [];
  const groups = [];
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

export const db = config.dbDriver === 'mssql' ? mssqlDriver() : memoryDriver();

// 啟動自检與 /api/health 用（不拋錯，回傳狀況）
export const checkDb = () => db.check();
