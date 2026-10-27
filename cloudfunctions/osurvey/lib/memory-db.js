/*
 * 記憶體驅動（CommonJS）— 只給本機自測用（node test/local-smoke.js）。
 * 方法集與 db.js（雲開發驅動）、server/src/db.js 完全一致，
 * 所以同一套路由邏輯可以在本機先跑通，再上雲。
 * 與 server/src/db.js 的 memoryDriver 同一份語意：改一邊記得改另一邊。
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
  let seqWebUser = 0;
  let seqSeed = { surveys: 0, answers: 0, visits: 0, groups: 0, groupNames: 0 };
  const surveys = new Map();
  const answers = [];
  const visits = [];
  const groups = [];
  const groupNames = [];
  const webUsers = [];
  const webBinds = [];
  const answerArchive = [];
  const now = () => new Date().toISOString();

  return {
    async createSurvey({ title, groupName, bindMode, announcement, questionsJson, creatorOpenId, surveyId, deadline }) {
      const id = Number(surveyId) || ++seqSurvey;
      if (surveys.has(id)) throw duplicateError('問卷編號已存在');
      seqSurvey = Math.max(seqSurvey, id);
      surveys.set(id, {
        SurveyId: id, Title: title, GroupName: groupName || null, OpenGId: null,
        BindMode: bindMode, Announcement: announcement || null, QuestionsJson: questionsJson,
        CreatorOpenId: creatorOpenId, IsClosed: false, Deadline: deadline || null,
        CreateTime: now(), UpdateTime: now(),
      });
      return id;
    },
    async importSeed(seed) {
      const stat = { survey: 0, answer: 0, visit: 0, survey_group: 0, group_name: 0, skipped: 0 };
      for (const s of seed.surveys || []) {
        const id = Number(s.SurveyId);
        if (surveys.has(id)) { stat.skipped += 1; continue; }
        surveys.set(id, {
          SurveyId: id, Title: s.Title, GroupName: s.GroupName || null, OpenGId: null,
          BindMode: s.BindMode, Announcement: s.Announcement || null, QuestionsJson: s.QuestionsJson,
          CreatorOpenId: s.CreatorOpenId, IsClosed: !!s.IsClosed, Deadline: s.Deadline || null,
          CreateTime: s.CreateTime || now(), UpdateTime: s.UpdateTime || now(),
        });
        seqSurvey = Math.max(seqSurvey, id);
        stat.survey += 1;
      }
      for (const a of seed.answers || []) {
        const sid = Number(a.SurveyId);
        if (answers.some((x) => x.SurveyId === sid && x.OpenId === a.OpenId)) { stat.skipped += 1; continue; }
        answers.push({
          AnswerId: ++seqAnswer, SurveyId: sid, OpenId: a.OpenId, OpenGId: a.OpenGId || null,
          AnswersJson: a.AnswersJson, SubmitTime: a.SubmitTime || now(),
        });
        stat.answer += 1;
      }
      for (const v of seed.visits || []) {
        const sid = Number(v.SurveyId);
        if (visits.some((x) => x.SurveyId === sid && x.OpenId === v.OpenId)) { stat.skipped += 1; continue; }
        visits.push({
          VisitId: ++seqVisit, SurveyId: sid, OpenId: v.OpenId, OpenGId: v.OpenGId || null,
          VisitTime: v.VisitTime || now(),
        });
        stat.visit += 1;
      }
      for (const g of seed.surveyGroups || []) {
        const sid = Number(g.SurveyId);
        if (groups.some((x) => x.SurveyId === sid && x.OpenGId === g.OpenGId)) { stat.skipped += 1; continue; }
        groups.push({ SurveyGroupId: ++seqGroup, SurveyId: sid, OpenGId: g.OpenGId, FirstSeenAt: g.FirstSeenAt || now() });
        stat.survey_group += 1;
      }
      for (const n of seed.groupNames || []) {
        if (groupNames.some((x) => x.OpenId === n.OpenId && x.Name === n.Name)) { stat.skipped += 1; continue; }
        groupNames.push({
          GroupNameId: ++seqGroupName, OpenId: n.OpenId, Name: n.Name,
          UseCount: Number(n.UseCount) || 1, LastUsedAt: n.LastUsedAt || now(),
        });
        stat.group_name += 1;
      }
      return stat;
    },

    async maxSurveyId() {
      const ids = [...surveys.keys()].filter((n) => Number.isFinite(n));
      return ids.length ? Math.max(...ids) : 0;
    },
    async getSurvey(id) {
      const s = surveys.get(Number(id));
      return s ? { ...s } : null;
    },
    async listSurveys(creatorOpenId) {
      return [...surveys.values()]
        .filter((s) => !creatorOpenId || s.CreatorOpenId === creatorOpenId)
        .sort((a, b) => b.SurveyId - a.SurveyId)
        .map((s) => ({
          ...s,
          AnswerCount: answers.filter((a) => a.SurveyId === s.SurveyId).length,
          VisitCount: visits.filter((v) => v.SurveyId === s.SurveyId).length,
          IsExpired: !!(s.Deadline && Date.parse(s.Deadline) <= Date.now()),
        }));
    },
    async setClosed(id, closed) {
      const s = surveys.get(Number(id));
      if (!s) return false;
      s.IsClosed = !!closed;
      s.UpdateTime = now();
      return true;
    },
    async setDeadline(id, deadline) {
      const s = surveys.get(Number(id));
      if (!s) return false;
      s.Deadline = deadline || null;
      s.UpdateTime = now();
      return true;
    },

    async setBindMode(id, bindMode) {
      const s = surveys.get(Number(id));
      if (!s) return false;
      s.BindMode = bindMode === 'open' ? 'open' : 'group';
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

    // 刪除問卷連同它的答卷／開啟記錄／群綁定（不可恢復；只有建立者能呼叫）
    async deleteSurveyCascade(id) {
      const sid = Number(id);
      const removed = { survey: 0, answers: 0, visits: 0, groups: 0 };
      if (surveys.delete(sid)) removed.survey = 1;
      for (let i = answers.length - 1; i >= 0; i--) {
        if (answers[i].SurveyId === sid) { answers.splice(i, 1); removed.answers += 1; }
      }
      for (let i = visits.length - 1; i >= 0; i--) {
        if (visits[i].SurveyId === sid) { visits.splice(i, 1); removed.visits += 1; }
      }
      for (let i = groups.length - 1; i >= 0; i--) {
        if (groups[i].SurveyId === sid) { groups.splice(i, 1); removed.groups += 1; }
      }
      return removed;
    },
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
    async deleteGroupNames(openid, names) {
      const list = (Array.isArray(names) ? names : [names])
        .map((n) => String(n || '').trim().slice(0, 100))
        .filter(Boolean);
      let removed = 0;
      for (let i = groupNames.length - 1; i >= 0; i--) {
        if (groupNames[i].OpenId === openid && list.includes(groupNames[i].Name)) {
          groupNames.splice(i, 1);
          removed += 1;
        }
      }
      return removed;
    },

    async createWebUser({ userId, username, passwordHash, displayName }) {
      if (webUsers.some((u) => u.Username === username)) throw duplicateError('這個用戶名已被使用');
      const doc = {
        UserId: userId, Username: username, PasswordHash: passwordHash,
        DisplayName: displayName || username, BoundOpenId: null,
        Identity: `web:${userId}`, CreatedAt: now(), UpdatedAt: now(),
      };
      webUsers.push(doc);
      return { ...doc };
    },
    async getWebUserByUsername(username) {
      const u = webUsers.find((x) => x.Username === username);
      return u ? { ...u } : null;
    },
    async getWebUserById(userId) {
      const u = webUsers.find((x) => x.UserId === userId);
      return u ? { ...u } : null;
    },
    async getWebUserByBoundOpenId(openid) {
      const u = webUsers.find((x) => x.BoundOpenId === openid);
      return u ? { ...u } : null;
    },
    async listWebUsers() {
      return webUsers.map((u) => ({ ...u }));
    },
    async setWebUserBoundOpenId(userId, openid) {
      const u = webUsers.find((x) => x.UserId === userId);
      if (!u) return false;
      u.BoundOpenId = openid;
      u.Identity = openid;
      u.UpdatedAt = now();
      return true;
    },
    async setWebUserPassword(userId, passwordHash) {
      const u = webUsers.find((x) => x.UserId === userId);
      if (!u) return false;
      u.PasswordHash = passwordHash;
      u.UpdatedAt = now();
      return true;
    },
    async createWebBind({ token, userId, identity, webUid, expireAt }) {
      if (webBinds.some((b) => b.Token === String(token))) return false;
      webBinds.push({
        Token: String(token), UserId: userId, Identity: identity, WebUid: webUid || '',
        Status: 'pending', OpenId: null, CreatedAt: now(), ExpireAt: expireAt,
      });
      return true;
    },
    async getWebBind(token) {
      const b = webBinds.find((x) => x.Token === String(token));
      return b ? { ...b } : null;
    },
    async setWebBindStatus(token, status, openid) {
      const b = webBinds.find((x) => x.Token === String(token));
      if (!b) return false;
      b.Status = status;
      b.OpenId = openid || null;
      b.UpdatedAt = now();
      return true;
    },
    async migrateWebIdentity({ webIds, openid }) {
      const ids = [...new Set((webIds || []).filter(Boolean).map(String))];
      const out = { surveys: 0, answersMoved: 0, answersArchived: 0, visitsMoved: 0, visitsArchived: 0 };
      if (!ids.length) return out;
      for (const s of surveys.values()) {
        if (ids.includes(s.CreatorOpenId)) { s.CreatorOpenId = openid; out.surveys += 1; }
      }
      for (let i = answers.length - 1; i >= 0; i--) {
        const a = answers[i];
        if (!ids.includes(a.OpenId)) continue;
        const existing = answers.find((x) => x !== a && x.SurveyId === a.SurveyId && x.OpenId === openid);
        if (!existing) {
          answers.push({ ...a, OpenId: openid, AnswerId: ++seqAnswer });
          answers.splice(i, 1);
          out.answersMoved += 1;
          continue;
        }
        const aw = Date.parse(a.SubmitTime) || 0;
        const ao = Date.parse(existing.SubmitTime) || 0;
        if (aw < ao) {
          existing.AnswersJson = a.AnswersJson;
          existing.SubmitTime = a.SubmitTime;
          existing.OpenGId = a.OpenGId || existing.OpenGId || null;
        }
        answerArchive.push({ ...a, ArchivedAt: now(), Reason: 'web-identity-merge', MergedInto: openid });
        answers.splice(i, 1);
        out.answersArchived += 1;
      }
      for (let i = visits.length - 1; i >= 0; i--) {
        const v = visits[i];
        if (!ids.includes(v.OpenId)) continue;
        const existing = visits.find((x) => x !== v && x.SurveyId === v.SurveyId && x.OpenId === openid);
        if (!existing) {
          visits.push({ ...v, OpenId: openid, VisitId: ++seqVisit });
          visits.splice(i, 1);
          out.visitsMoved += 1;
        } else {
          visits.splice(i, 1);
          out.visitsArchived += 1;
        }
      }
      return out;
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

    // 清理超過保留期限的答卷與開啟記錄（隱私指引承諾：固定存儲期限 365 天）
    async purgeOldData(days, { creatorOpenId } = {}) {
      const cutoff = new Date(Date.now() - Number(days || 365) * 86400000).toISOString();
      const mine = new Set(
        [...surveys.values()]
          .filter((s) => !creatorOpenId || s.CreatorOpenId === creatorOpenId)
          .map((s) => s.SurveyId)
      );
      let removedAnswers = 0;
      let removedVisits = 0;
      for (let i = answers.length - 1; i >= 0; i--) {
        if (mine.has(answers[i].SurveyId) && String(answers[i].SubmitTime) < cutoff) {
          answers.splice(i, 1);
          removedAnswers += 1;
        }
      }
      for (let i = visits.length - 1; i >= 0; i--) {
        if (mine.has(visits[i].SurveyId) && String(visits[i].VisitTime) < cutoff) {
          visits.splice(i, 1);
          removedVisits += 1;
        }
      }
      return { cutoff, surveys: mine.size, answers: removedAnswers, visits: removedVisits };
    },
    async countDocs() {
      return {
        survey: surveys.size, answer: answers.length, visit: visits.length,
        survey_group: groups.length, group_name: groupNames.length,
        web_user: webUsers.length, web_bind: webBinds.length, answer_archive: answerArchive.length,
      };
    },
    async check() {
      const counts = await this.countDocs();
      return { ok: true, driver: 'memory', detail: '記憶體驅動（重啟即清空）', counts };
    },
  };
}

module.exports = { memoryDriver, duplicateError };
