/*
 * 雲開發資料庫驅動（文檔型）。
 * 方法集與 server/src/db.js 的三個驅動完全一致，所以 router.js 不必知道底層是什麼。
 *
 * 集合（與舊 SQL 表一一對應）：
 *   survey       ← Survey        _id = 問卷編號（字串，沿用舊編號，舊連結不會失效）
 *   answer       ← Answer        _id = "<問卷編號>_<openid>"（同問卷同人只可能有一份）
 *   visit        ← Visit         _id = "<問卷編號>_<openid>"（同人同問卷只記一次開啟）
 *   survey_group ← SurveyGroup   _id = "g<問卷編號>_<openGId>"（重複綁定天然去重）
 *   group_name   ← GroupName     _id = "<openid 短雜湊>_<群名雜湊>"
 * 用固定 _id 取代唯一索引：不必手動建索引，重複寫入會被資料庫直接擋掉。
 * 時間一律存 ISO 字串（UTC，帶 Z），與自架版的輸出格式一致，不必處理時區轉換。
 */
const crypto = require('crypto');

const COLLECTIONS = ['survey', 'answer', 'visit', 'survey_group', 'group_name'];

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

function isDuplicate(e) {
  const msg = (e && (e.errMsg || e.message)) || '';
  return /duplicate key|E11000|已存在|already exists/i.test(msg);
}

function isMissing(e) {
  const msg = (e && (e.errMsg || e.message)) || '';
  return /not exist|不存在|cannot find|DATABASE_COLLECTION_NOT_EXIST/i.test(msg);
}

function cloudDriver(cloud, { log = () => {} } = {}) {
  const db = cloud.database();
  const _ = db.command;
  const nowIso = () => new Date().toISOString();

  // 一律用 where + limit(1) 取單筆：collection.where().get() 一定回陣列，
  // 不會踩到「doc().get() 回物件還是陣列」的版本差異。
  async function findOne(name, cond) {
    try {
      const res = await db.collection(name).where(cond).limit(1).get();
      return (res.data && res.data[0]) || null;
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  // 取全部（自動翻頁；雲函式端單次上限 1000 筆）
  async function findAll(name, cond, { order, limit = 1000 } = {}) {
    const out = [];
    for (let skip = 0; skip < 100000; skip += 1000) {
      let q = db.collection(name).where(cond);
      if (order) q = q.orderBy(order[0], order[1]);
      const res = await q.skip(skip).limit(1000).get();
      out.push(...(res.data || []));
      if (!res.data || res.data.length < 1000 || out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  // 新增；_id 撞號（重複）時回 false，不丟錯
  async function addIfAbsent(name, doc) {
    try {
      await db.collection(name).add({ data: doc });
      return true;
    } catch (e) {
      if (isDuplicate(e)) return false;
      throw e;
    }
  }

  async function patch(name, cond, data) {
    const res = await db.collection(name).where(cond).update({ data });
    return (res.stats && res.stats.updated) || 0;
  }

  return {
    async ensureCollections() {
      for (const name of COLLECTIONS) {
        try { await db.createCollection(name); log('[cloud-db] 建立集合 ' + name); }
        catch (e) { if (!/already exist|已存在|DATABASE_COLLECTION_EXIST|duplicate/i.test((e && (e.errMsg || e.message)) || '')) { /* 併發建立時忽略 */ } }
      }
    },

    async createSurvey({ title, groupName, bindMode, announcement, questionsJson, creatorOpenId, surveyId }) {
      let id = Number(surveyId) || 0;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!id) {
          const last = await findAll('survey', {}, { order: ['SurveyId', 'desc'], limit: 1 });
          id = (last[0] ? Number(last[0].SurveyId) : 0) + 1;
        }
        const doc = {
          _id: String(id), SurveyId: id, Title: title, GroupName: groupName || null, OpenGId: null,
          BindMode: bindMode, Announcement: announcement || null, QuestionsJson: questionsJson,
          CreatorOpenId: creatorOpenId, IsClosed: false, CreateTime: nowIso(), UpdateTime: nowIso(),
        };
        if (await addIfAbsent('survey', doc)) return id;
        id = 0;   // 撞號（有人同時建立）→ 重新取最大號再試
      }
      throw new Error('問卷編號分配失敗，請重試');
    },

    // 一次性搬遷：把 seed.json 灌進雲資料庫。_id 已存在的一律跳過（幂等、不刪任何資料）。
    async importSeed(seed) {
      const stat = { survey: 0, answer: 0, visit: 0, survey_group: 0, group_name: 0, skipped: 0 };
      const bump = async (name, doc) => { if (await addIfAbsent(name, doc)) stat[name] += 1; else stat.skipped += 1; };
      for (const s of seed.surveys || []) {
        await bump('survey', {
          _id: String(s.SurveyId), SurveyId: Number(s.SurveyId), Title: s.Title, GroupName: s.GroupName || null,
          OpenGId: null, BindMode: s.BindMode, Announcement: s.Announcement || null,
          QuestionsJson: s.QuestionsJson, CreatorOpenId: s.CreatorOpenId, IsClosed: !!s.IsClosed,
          CreateTime: s.CreateTime || nowIso(), UpdateTime: s.UpdateTime || nowIso(),
        });
      }
      for (const a of seed.answers || []) {
        await bump('answer', {
          _id: `${Number(a.SurveyId)}_${a.OpenId}`, SurveyId: Number(a.SurveyId), OpenId: a.OpenId,
          OpenGId: a.OpenGId || null, AnswersJson: a.AnswersJson, SubmitTime: a.SubmitTime || nowIso(),
        });
      }
      for (const v of seed.visits || []) {
        await bump('visit', {
          _id: `${Number(v.SurveyId)}_${v.OpenId}`, SurveyId: Number(v.SurveyId), OpenId: v.OpenId,
          OpenGId: v.OpenGId || null, VisitTime: v.VisitTime || nowIso(),
        });
      }
      for (const g of seed.surveyGroups || []) {
        await bump('survey_group', {
          _id: `g${Number(g.SurveyId)}_${g.OpenGId}`, SurveyId: Number(g.SurveyId),
          OpenGId: g.OpenGId, FirstSeenAt: g.FirstSeenAt || nowIso(),
        });
      }
      for (const n of seed.groupNames || []) {
        await bump('group_name', {
          _id: `n_${shortHash(n.OpenId)}_${shortHash(n.Name)}`, OpenId: n.OpenId, Name: n.Name,
          UseCount: Number(n.UseCount) || 1, LastUsedAt: n.LastUsedAt || nowIso(),
        });
      }
      return stat;
    },

    async maxSurveyId() {
      const last = await findAll('survey', {}, { order: ['SurveyId', 'desc'], limit: 1 });
      return last[0] ? Number(last[0].SurveyId) : 0;
    },

    async getSurvey(id) {
      return findOne('survey', { SurveyId: Number(id) });
    },

    async listSurveys(creatorOpenId) {
      const cond = creatorOpenId ? { CreatorOpenId: creatorOpenId } : {};
      const rows = await findAll('survey', cond, { order: ['SurveyId', 'desc'], limit: 200 });
      const out = [];
      for (const s of rows) {
        const answers = await db.collection('answer').where({ SurveyId: s.SurveyId }).count();
        const visits = await db.collection('visit').where({ SurveyId: s.SurveyId }).count();
        out.push({ ...s, AnswerCount: answers.total, VisitCount: visits.total });
      }
      return out;
    },

    async setClosed(id, closed) {
      const n = await patch('survey', { SurveyId: Number(id) }, { IsClosed: !!closed, UpdateTime: nowIso() });
      return n > 0;
    },

    async updateSurveyQuestions(id, questionsJson) {
      const n = await patch('survey', { SurveyId: Number(id) }, { QuestionsJson: questionsJson, UpdateTime: nowIso() });
      return n > 0;
    },

    async bindSurveyGroup(surveyId, openGId) {
      const sid = Number(surveyId);
      return addIfAbsent('survey_group', {
        _id: `g${sid}_${openGId}`, SurveyId: sid, OpenGId: openGId, FirstSeenAt: nowIso(),
      });
    },

    async listSurveyGroups(surveyId) {
      return findAll('survey_group', { SurveyId: Number(surveyId) }, { order: ['FirstSeenAt', 'asc'], limit: 200 });
    },

    async clearSurveyGroup(surveyId) {
      const res = await db.collection('survey_group').where({ SurveyId: Number(surveyId) }).remove();
      return ((res.stats && res.stats.removed) || 0) > 0;
    },

    // 刪除問卷連同它的答卷／開啟記錄／群綁定（不可恢復；只有建立者能呼叫）
    async deleteSurveyCascade(id) {
      const sid = Number(id);
      const s = await db.collection('survey').where({ SurveyId: sid }).remove();
      const a = await db.collection('answer').where({ SurveyId: sid }).remove();
      const v = await db.collection('visit').where({ SurveyId: sid }).remove();
      const g = await db.collection('survey_group').where({ SurveyId: sid }).remove();
      return {
        survey: (s.stats && s.stats.removed) || 0,
        answers: (a.stats && a.stats.removed) || 0,
        visits: (v.stats && v.stats.removed) || 0,
        groups: (g.stats && g.stats.removed) || 0,
      };
    },

    // 清理超過保留期限的答卷與開啟記錄（隱私指引承諾：固定存儲期限 365 天）
    async purgeOldData(days, { creatorOpenId } = {}) {
      const cutoff = new Date(Date.now() - Number(days || 365) * 86400000).toISOString();
      const cond = creatorOpenId ? { CreatorOpenId: creatorOpenId } : {};
      const surveys = await findAll('survey', cond, { limit: 1000 });
      let answers = 0;
      let visits = 0;
      for (const s of surveys) {
        const a = await db.collection('answer').where({ SurveyId: s.SurveyId, SubmitTime: _.lt(cutoff) }).remove();
        answers += (a.stats && a.stats.removed) || 0;
        const v = await db.collection('visit').where({ SurveyId: s.SurveyId, VisitTime: _.lt(cutoff) }).remove();
        visits += (v.stats && v.stats.removed) || 0;
      }
      return { cutoff, surveys: surveys.length, answers, visits };
    },

    async touchGroupNames(openid, names) {
      const list = (Array.isArray(names) ? names : [names])
        .map((n) => String(n || '').trim().slice(0, 100))
        .filter(Boolean);
      for (const name of list) {
        const id = `n_${shortHash(openid)}_${shortHash(name)}`;
        const hit = await findOne('group_name', { _id: id });
        if (hit) {
          await patch('group_name', { _id: id }, { UseCount: _.inc(1), LastUsedAt: nowIso() });
        } else {
          await addIfAbsent('group_name', { _id: id, OpenId: openid, Name: name, UseCount: 1, LastUsedAt: nowIso() });
        }
      }
      return list.length;
    },

    async listGroupNames(openid, limit = 50) {
      return findAll('group_name', { OpenId: openid }, { order: ['LastUsedAt', 'desc'], limit });
    },

    async getAnswer(surveyId, openid) {
      return findOne('answer', { _id: `${Number(surveyId)}_${openid}` });
    },

    async insertAnswer({ surveyId, openid, openGId, answersJson }) {
      const doc = {
        _id: `${Number(surveyId)}_${openid}`, SurveyId: Number(surveyId), OpenId: openid,
        OpenGId: openGId || null, AnswersJson: answersJson, SubmitTime: nowIso(),
      };
      try {
        await db.collection('answer').add({ data: doc });
      } catch (e) {
        if (isDuplicate(e)) {
          const err = new Error('此問卷已提交過');
          err.code = 'DUPLICATE';
          throw err;
        }
        throw e;
      }
      return doc;
    },

    async saveVisit(surveyId, openid, openGId) {
      return addIfAbsent('visit', {
        _id: `${Number(surveyId)}_${openid}`, SurveyId: Number(surveyId), OpenId: openid,
        OpenGId: openGId || null, VisitTime: nowIso(),
      });
    },

    async countVisits(surveyId) {
      const res = await db.collection('visit').where({ SurveyId: Number(surveyId) }).count();
      return res.total;
    },

    async listAnswers(surveyId) {
      return findAll('answer', { SurveyId: Number(surveyId) }, { order: ['SubmitTime', 'asc'], limit: 5000 });
    },

    async countDocs() {
      const out = {};
      for (const name of COLLECTIONS) {
        try { out[name] = (await db.collection(name).count()).total; } catch (e) { out[name] = -1; }
      }
      return out;
    },

    async check() {
      const counts = await this.countDocs();
      const missing = Object.entries(counts).filter(([, n]) => n < 0).map(([k]) => k);
      return { ok: missing.length === 0, driver: 'cloud', detail: missing.length ? '缺集合：' + missing.join(',') : '雲開發資料庫正常', counts };
    },
  };
}

module.exports = { cloudDriver, COLLECTIONS, shortHash };
