# 微信群公告 5W1H 問卷系統

管理員把群公告貼成問卷 → 分享卡片到微信群 → 成員答題（一人一份）→ 後台看回收統計、匯出 Excel／CSV。

```
Survey-System/
├─ miniprogram/          微信小程序（原生框架，含管理端＋成員端）
│  ├─ config.js          ← 後端位址、DEV_OPEN_GID 演練開關
│  ├─ images/            分享封面圖（survey-cover.jpg，5:4、<128KB）
│  ├─ utils/api.js       登入、請求封裝（自動重登、shareTicket 解析、登入失敗原因）
│  └─ pages/
│     ├─ index/          首頁
│     ├─ admin/create/   建立問卷（預設 5W 題目、填充／單選／日期三種題型）
│     ├─ admin/list/     我的問卷
│     ├─ admin/survey/   問卷詳情：分享、結束、解除群綁定
│     ├─ admin/stats/    統計：提交率、選項百分比、高頻詞雲、文字回覆、匯出 Excel／CSV
│     └─ answer/         成員端作答頁（含 <open-data> 顯示群名）
├─ server/               Node.js API（Express 5 + mssql + exceljs）
│  ├─ src/lib/           wechat（code2Session／shareTicket AES 解密）、auth、questions
│  ├─ src/routes/        auth / surveys / answers / stats
│  ├─ src/db.js          mssql 與 memory 雙驅動
│  ├─ .env               ← 真實憑證（已在 .gitignore）；.env.example 為範本
│  └─ test/smoke.js      端到端煙霧測試（46 項斷言，npm run smoke）
└─ database/
   ├─ 01_schema.sql            T_表＋同名檢視（全新庫），單段 F5＋@DryRun 閘門
   ├─ 02_t_plus_view.sql       從舊版（表名無 T_ 前綴）遷移，不刪資料
   ├─ 03_public_view_only.sql  收掉 public 的庫層級授與＋只給檢視 CRUD
   └─ 04_multi_group.sql       多群模型：T_SurveyGroup＋檢視＋舊單群綁定搬移
```

## 權限模型：只能走檢視（已實測）

`03_public_view_only.sql` 把 `OSurveyDB` 收成「檢視專屬」的形態：

- **撤銷** `public` 的庫層級 `Select/Insert/Update/References/Execute/Alter`，**保留 `CONNECT`**（撤了谁都進不了這個庫）
- **授與** `public` 三個**檢視**的 `Select,Insert,Update,Delete`
- 結果：任何能連進這個庫的帳號都只能經 `Survey/Answer/Visit` 存取，**直接查 `T_Survey` 會報 `消息 229`**；同時補上了原本缺的 `DELETE`

依據（LocalDB 乾淨沙箱實測）：擁有權鏈成立 → 只給檢視權限時，父表插入、**FK 子表插入（REFERENCES 已撤仍生效）**、更新、刪除全部成功；收權前基準線確實能直接查表、收權後被 229 擋下。

兩個必知副作用：
1. **DENY／撤權之後，該帳號在 `sys.tables` 裡看不見 `T_` 表**（元資料可見度綁權限）→ 後端啟動自檢因此**只數檢視並經檢視實查列數**，不依賴 `sys.tables`
2. 落地後**連你自己**用普通帳號也查不到 `T_` 表，要直查請用 sa／db_owner 登入

## 三種運行層級（由簡到正式）

### A. 純本機演練（不需要資料庫）

1. `cd server && npm install && npm start`（`.env` 預設 `DB_DRIVER=memory`）
2. 開發者工具 → 導入 `miniprogram/` →「詳情 → 本地設置」勾「**不校驗合法域名**」
3. 要在模擬器演練「歸群」：`miniprogram/config.js` 設 `DEV_OPEN_GID: 'gid-dev'` **且** `.env` 暫時清空 `WX_APPID/WX_SECRET`（後端才會接受假 openGId）；只測「開放作答」則不用
4. 全鏈路可用：建立 → 作答 → 統計 → 匯出（資料在記憶體，重啟即清空）
5. 回歸測試：`npm run smoke`（它會自己蓋掉憑證走 dev 模式，不受 `.env` 影響）

### B. 接你自己的 SQL Server

**資料模型：T_ 實體表 ＋ 同名檢視**（跟 AOI 那套一致）——app 一律存取 `dbo.Survey / Answer / Visit`（檢視），
實際資料落在 `dbo.T_Survey / T_Answer / T_Visit`；将来改表结构不用动 app。

1. SQL Server 建一個空庫 `OSurveyDB`，SSMS 連上它並**把上方資料庫下拉切到該庫**
2. 整段 F5 `database/01_schema.sql`（預設 `@DryRun=1` 演練零寫入 → 無紅字後改 `0` 落地；
   回條 `TranCount=0`、清單 **12 列**＝3 T_表＋3 檢視＋6 索引）
   - 若你跑過**舊版** 01（表名沒 T_ 前綴）：改 F5 `database/02_t_plus_view.sql` 做遷移（改名＋補檢視，不刪資料）
   - 兩支腳本都內建「連線庫不對就擋下」閘門，跑錯庫不會誤建到 `master`
3. `server/.env`：`DB_DRIVER=mssql`、`DB_SERVER/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`、改 `TOKEN_SECRET`
   （**部署時**把 `DB_*` 交给服务的环境变量注入即可，`dotenv` 不會蓋掉已存在的環境變數，`.env` 只留本機開發用）
4. `npm start` — 啟動會自檢並印出「✓ 結構就緒」或明確告诉你该跑哪支腳本；`/api/health` 也回 `db.tables/views/tablesOk`

### C. 接真微信（真機體驗版）

1. `mp.weixin.qq.com` 註冊小程序（個人主體即可，不收費、不涉交易）→ 開發設定取 AppID/Secret
2. `server/.env` 填 `WX_APPID`／`WX_SECRET`（填了即切正式模式）；`miniprogram/config.js` 的 `DEV_OPEN_GID` 清空
3. `project.config.json` 的 `appid` 改成你的 AppID；後端跑在電腦上，真機要把 `API_BASE` 改成電腦區網 IP，並在開發者工具「預覽」時勾「不校驗合法域名」
4. 體驗版驗證群鏈路：管理員分享卡片到群 → **從群裡點卡片進入一次**（這一步才會綁定群並讓 `<open-data>` 顯示群名）→ 成員作答

## 群綁定機制（多群）

- 分享時開啟 `withShareTicket`（`menus: ['shareAppMessage']`）；成員從**群卡片**進入時拿到 `shareTicket`
- 前端 `wx.getShareInfo` 取 `encryptedData/iv` → 後端用該用戶 `session_key` AES-128-CBC 解密出 `openGId`
- **多群模型**：一份問卷可歸屬多個群。第一個從某群進入的人就把該群加入（`T_SurveyGroup`，唯一鍵 `SurveyId+OpenGId`），同一張卡片轉發到別的群，那個群也會自動加入
- `BindMode='group'` 只收「從群卡片進入」的人（沒帶群憑證回 422）；`BindMode='open'` 不限制
- 統計頁有「**各群提交數**」分組；管理頁可看「已加入的群」清單與時間，可「解除全部群綁定」重來
- 分享標題依設計規格：`【群名稱】問卷標題：請查收並確認`，封面為 `images/survey-cover.jpg`

## API 一覽

| Method | Path | 說明 |
|---|---|---|
| POST | /api/auth/login | code 換 openid（回 token） |
| POST/GET | /api/surveys | 建立／我的清單（帶提交數、開啟數） |
| GET | /api/surveys/:id | 詳情＋我是否已答 |
| POST | /api/surveys/:id/shareresolve | 解密 openGId、比對是否本群、**進入即綁定** |
| POST | /api/surveys/:id/visit | 記一次開啟 |
| POST | /api/surveys/:id/answer | 提交（去重 409、群不符 403、日期格式 400） |
| POST | /api/surveys/:id/close | 結束／重開 |
| POST | /api/surveys/:id/unbind | 解除群綁定 |
| GET | /api/surveys/:id/stats | 統計（選項count＋百分比、高頻詞、文字回覆） |
| GET | /api/surveys/:id/export.csv | 匯出 CSV（UTF-8 BOM、時間已轉 +8） |
| GET | /api/surveys/:id/export.xlsx | 匯出 Excel（答卷明細＋統計摘要兩個工作表） |

## 已知限制（設計時已考慮）

- 微信**不開放**讀取群名與群公告 → 群名由管理員輸入、公告手動貼上、群名靠 `<open-data>` 只顯示給成員本人看
- `shareTicket`／解密資料有效期短 → 成員當下答完最順；過期重進會被提示重新從群卡片進入
- 「提交/開啟」是誤導最小的回收率：微信不提供群成員總數，算不了對全群的回收率
- 本系統擋「別群的人」與「沒帶群憑證的人」，但群內成員自行轉發卡片給外部人無法完全阻止（微信生態通病）
- **高頻詞不是分詞**：中文走 2 字詞組統計＋虛詞過濾，定位是「看趨勢」，不是語意分析
- **模擬器常無法開啟 Excel**（`wx.openDocument` 支援度問題），畫面會提示改用 CSV；真機要下載 Excel 需先在後台配好 `downloadFile` 域名

## 上線前代辦

1. 域名＋HTTPS：開發／體驗版不需要；正式版 request 域名必須 HTTPS。伺服器在大陸要備案（2–3 週），在境外可用未備案域名（慢一點）
2. 提審定位寫「信息收集工具」，避免被判互動類
3. `server/.env` 的 `TOKEN_SECRET`、DB 密碼不要外流；`.env` 不進版控

## 驗證狀態

| 項目 | 狀態 |
|---|---|
| 後端邏輯 | `cd server && npm run smoke` — **46 項斷言全過**（權限、去重、群邊界、**多群加入與分群統計**、日期題型、統計百分比、高頻詞、CSV／XLSX、結束／重開、解除綁定） |
| SQL 腳本 | `01_schema.sql`（v2）與 `02_t_plus_view.sql` 均在本機 LocalDB 實測：跑錯庫被擋／演練零寫入（事後查 `sys.tables=3 views=0`）／落地 `TranCount=0` 與 12 列／重跑被閘門擋下 |
| **檢視可寫性** | 經檢視跑過 app 的實際語法：`Insert … Output Inserted.SurveyId` 取回 Identity、`Update … Where OpenGId Is Null`、重複提交被唯一索引擋下（**2601**）、防重訪連跑兩次只 1 列、`T_` 表與檢視讀數一致、測資已清（殘留 0/0/0） |
| 真實 SQL Server | 已連線 `10.241.48.1/OSurveyDB`（Microsoft SQL Server 2016）；環境變數注入優先於 `.env` 已實測 |
| **落庫對账（真庫）** | `cd server && node test/db-live.js` — **26 項全過**：一份問卷同時歸屬 A/B 兩群、兩群各交一份、分群統計正確、唯一索引擋重複 409、中文與三種題型原樣、語義化 key、日期值、CSV(+8)、XLSX、**直接查實體表被擋**、清理後三檢視歸零 |
| view-only 權限模型 | `03_public_view_only.sql` 已在真庫落地：`public` 庫層級由 7 種收為只剩 `CONNECT`，四個檢視（含 SurveyGroup）各帶 4 種 GRANT，四張 `T_` 表無任何授與 |
| API 送的 SQL | 11 組語句逐條在 LocalDB 跑過（含重複鍵預期 2601、防重訪只 1 列） |
| 微信憑證 | 實測有效：`/cgi-bin/token` 取得 access_token；假 code 打 `/api/auth/login` 得微信 `40029`（＝AppID/Secret 被接受、出口 IP 沒被白名單擋） |
| **登入鏈路（真機代碼）** | **已實測打通**：開發者工具編譯後首頁顯示真實 openid，後端 `POST /api/auth/login → 200`（220–690ms 為真打 `api.weixin.qq.com` 的延遲） |
| 小程序靜態 | 全 JS `node --check` 通過、JSON 全可解析；6 支頁面 WXML↔JS 交叉檢查（事件常式、模板欄位、標籤閉合、無 wxs） |
| 小程序執行面 | **部分驗證**：首頁渲染與登入已實測；建立／作答／統計／匯出四頁與 `<open-data>` 群名**仍待你在模擬器走一遍**；`shareTicket → openGId` 真解密只能真機進群驗證 |

### 想讓 CLI 自動化跑 UI（選擇性）

開發者工具 → 設置 → 安全設置 → 開啟「服務端口」，並先登入 IDE，然後：

```
"D:\微信web开发者工具\cli.bat" auto --project D:\WORK\Survey-System\miniprogram --auto-port 9420
```

再用 `miniprogram-automator` 連 `ws://localhost:9420` 即可驅動頁面與截圖。

