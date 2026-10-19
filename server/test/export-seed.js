/*
 * 把 SQL Server 的問卷資料匯出成雲開發要用的 seed.json
 *     cd server && node test/export-seed.js
 * 只讀不寫（全部是 Select），匯出檔預設放 cloudfunctions/osurvey/seed.json，
 * 之後在雲開發控制台對雲函式 osurvey 跑一次 {"method":"POST","path":"/admin/importSeed"} 就完成搬遷。
 *
 * 匯出後 seed.json 會跟著雲函式一起上傳，裡面是**真實問卷資料**：
 *   - 已在 .gitignore 內，不會進版控
 *   - 匯入完成後建議把這個檔刪掉，再重新上傳一次雲函式（避免資料留在雲函式包裡）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { db } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const OUT = outArg >= 0 ? path.resolve(argv[outArg + 1]) : path.resolve(here, '..', '..', 'cloudfunctions', 'osurvey', 'seed.json');

const iso = (v) => (v instanceof Date ? v.toISOString() : (v === null || v === undefined ? null : String(v)));

// 有些表可能還沒在正式庫建過（例如 05_group_name.sql 還沒跑），缺表時匯出空集合就好，不要整個失敗
async function safe(label, sql) {
  try {
    return (await db.raw(sql)).rows;
  } catch (e) {
    console.warn(`  ⚠ ${label} 讀不到（${e.message}）→ 當作 0 筆`);
    return [];
  }
}

async function main() {
  if (config.dbDriver !== 'mssql') {
    console.error(`這個腳本只能對 SQL Server 跑（目前 DB_DRIVER=${config.dbDriver}）。請在 server/.env 設 DB_DRIVER=mssql。`);
    process.exit(1);
  }
  console.log(`來源：${config.db.server}/${config.db.database}（只讀）`);

  const surveys = await safe('Survey', 'Select SurveyId, Title, GroupName, BindMode, Announcement, QuestionsJson, CreatorOpenId, IsClosed, CreateTime, UpdateTime From dbo.Survey Order By SurveyId;');
  const answers = await safe('Answer', 'Select SurveyId, OpenId, OpenGId, AnswersJson, SubmitTime From dbo.Answer Order By AnswerId;');
  const visits = await safe('Visit', 'Select SurveyId, OpenId, OpenGId, VisitTime From dbo.Visit Order By VisitId;');
  const surveyGroups = await safe('SurveyGroup', 'Select SurveyId, OpenGId, FirstSeenAt From dbo.SurveyGroup Order By SurveyGroupId;');
  const groupNames = await safe('GroupName', 'Select OpenId, Name, UseCount, LastUsedAt From dbo.GroupName Order By LastUsedAt Desc;');

  const seed = {
    exportedAt: new Date().toISOString(),
    source: `mssql ${config.db.server}/${config.db.database}`,
    counts: {
      surveys: surveys.length,
      answers: answers.length,
      visits: visits.length,
      surveyGroups: surveyGroups.length,
      groupNames: groupNames.length,
    },
    surveys: surveys.map((s) => ({
      SurveyId: s.SurveyId, Title: s.Title, GroupName: s.GroupName, BindMode: s.BindMode,
      Announcement: s.Announcement, QuestionsJson: s.QuestionsJson, CreatorOpenId: s.CreatorOpenId,
      IsClosed: !!s.IsClosed, CreateTime: iso(s.CreateTime), UpdateTime: iso(s.UpdateTime),
    })),
    answers: answers.map((a) => ({
      SurveyId: a.SurveyId, OpenId: a.OpenId, OpenGId: a.OpenGId,
      AnswersJson: a.AnswersJson, SubmitTime: iso(a.SubmitTime),
    })),
    visits: visits.map((v) => ({
      SurveyId: v.SurveyId, OpenId: v.OpenId, OpenGId: v.OpenGId, VisitTime: iso(v.VisitTime),
    })),
    surveyGroups: surveyGroups.map((g) => ({
      SurveyId: g.SurveyId, OpenGId: g.OpenGId, FirstSeenAt: iso(g.FirstSeenAt),
    })),
    groupNames: groupNames.map((n) => ({
      OpenId: n.OpenId, Name: n.Name, UseCount: n.UseCount, LastUsedAt: iso(n.LastUsedAt),
    })),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(seed, null, 1), 'utf8');
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`已匯出 → ${OUT}（${kb}KB）`);
  for (const [k, v] of Object.entries(seed.counts)) console.log(`  ${k}: ${v}`);
  console.log('提醒：這個檔案含真實資料，別上傳到公開的地方；匯入完成後可刪除。');
}

main().then(() => process.exit(0)).catch((e) => { console.error('匯出失敗：', e.message); process.exit(1); });
