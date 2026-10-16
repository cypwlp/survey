/* ============================================================
   微信群公告 5W1H 問卷 — 資料表建立腳本 (Schema v2：T_ 表 ＋ 同名檢視)
   目標庫：OSurveyDB（SSMS 上方資料庫下拉要先切到它）
   模型：實體表 T_Survey / T_Answer / T_Visit；app 只存取同名檢視
        Survey / Answer / Visit（換表結構不用改 app）
   用法：整段 Ctrl+A -> F5。@DryRun=1（預設）演練零寫入；
        看到只有 Print、無紅字後把第 22 行改 0 再 F5 落地。
   三道閘門：庫不對→擋；物件已存在（防重跑）→擋；@DryRun=1→不寫入。
   回條：TranCount 必須 0；清單應 12 列（3 T_表 + 3 檢視 + 6 索引）。
   有無寫入：演練零寫入；落地在交易內，失敗自動回滾。
   有無殘留：無暫存表、不改任何既有物件；本腳本只跑一次。
   備註：Create View 必須是批次第一個陳述式，故在交易內用 sp_executesql 建立。
   ============================================================ */
Set Quoted_Identifier On;
Set Ansi_Nulls On;
Set Ansi_Padding On;
Set Ansi_Warnings On;
Set ArithAbort On;
Set Concat_Null_Yields_Null On;
Set Numeric_RoundAbort Off;
Go

Declare @DryRun int = 1;   -- 1=演練（預設） 0=落地

Declare @WantDb sysname = N'OSurveyDB';
Declare @NowDb sysname = DB_Name();   -- RaisError 參數不能放函式呼叫，先指派進變數
If @NowDb <> @WantDb
Begin
    RaisError(N'目前連線的庫是「%s」，不是預期的「%s」。請先用 SSMS 上方資料庫下拉切到目標庫再執行。', 16, 1, @NowDb, @WantDb);
    Return;
End

Declare @exists int = (Select Count(*) From sys.objects
  Where name In (N'T_Survey', N'T_Answer', N'T_Visit', N'Survey', N'Answer', N'Visit'));
If @exists > 0
Begin
    RaisError(N'偵測到目標物件已存在 %d/6 個（T_ 表或同名檢視）。本腳本僅允許在空 schema 上跑一次；若是跑過 01 舊版想升級成 T_＋檢視模型，請改執行 02_t_plus_view.sql。', 16, 1, @exists);
    Return;
End

If @DryRun = 1
Begin
    Print N'[演練] 將建立：T_Survey / T_Answer / T_Visit 三張表，加上同名檢視 Survey / Answer / Visit（共 12 個物件）。';
    Print N'[演練] 目前零寫入。確認無紅字後把 @DryRun 改 0 再整段 F5 落地。';
    Return;
End

Set Xact_Abort On;
Begin Tran;

Create Table dbo.T_Survey (
    SurveyId        Int Identity(1,1) Not Null,
    Title           NVarchar(100)  Not Null,
    GroupName       NVarchar(100)  Null,          -- 管理員手動輸入（微信不開放讀取群名）
    OpenGId         VarChar(64)    Null,          -- 首個從群裡進入者綁定；'group' 模式下鎖定
    BindMode        VarChar(10)    Not Null Constraint DF_Survey_BindMode Default('group'),  -- group|open
    Announcement    NVarchar(Max)  Null,          -- 管理員貼上的公告原文
    QuestionsJson   NVarchar(Max)  Not Null,      -- [{k,type,title,options?,required}]
    CreatorOpenId   VarChar(64)    Not Null,
    IsClosed        Bit            Not Null Constraint DF_Survey_IsClosed Default(0),
    CreateTime      DateTime2(0)   Not Null Constraint DF_Survey_CreateTime Default(SysUtcDateTime()),
    UpdateTime      DateTime2(0)   Not Null Constraint DF_Survey_UpdateTime Default(SysUtcDateTime()),
    Constraint PK_Survey Primary Key (SurveyId)
);

Create Table dbo.T_Answer (
    AnswerId        BigInt Identity(1,1) Not Null,
    SurveyId        Int            Not Null,
    OpenId          VarChar(64)    Not Null,      -- 去重維度：同問卷同 openid 只收一份
    OpenGId         VarChar(64)    Null,
    AnswersJson     NVarchar(Max)  Not Null,      -- [{k,value}]
    SubmitTime      DateTime2(0)   Not Null Constraint DF_Answer_SubmitTime Default(SysUtcDateTime()),
    Constraint PK_Answer Primary Key (AnswerId),
    Constraint FK_Answer_Survey Foreign Key (SurveyId) References dbo.T_Survey(SurveyId)
);

Create Table dbo.T_Visit (
    VisitId         BigInt Identity(1,1) Not Null,
    SurveyId        Int            Not Null,
    OpenId          VarChar(64)    Not Null,
    OpenGId         VarChar(64)    Null,
    VisitTime       DateTime2(0)   Not Null Constraint DF_Visit_VisitTime Default(SysUtcDateTime()),
    Constraint PK_Visit Primary Key (VisitId),
    Constraint FK_Visit_Survey Foreign Key (SurveyId) References dbo.T_Survey(SurveyId)
);

Create Index IX_Survey_Creator On dbo.T_Survey (CreatorOpenId) Include (Title, CreateTime);
Create Unique Index UQ_Answer_Survey_Open On dbo.T_Answer (SurveyId, OpenId);
Create Unique Index UQ_Visit_Survey_Open On dbo.T_Visit (SurveyId, OpenId);

Exec sp_executesql N'Create View dbo.Survey As
  Select SurveyId, Title, GroupName, OpenGId, BindMode, Announcement, QuestionsJson,
         CreatorOpenId, IsClosed, CreateTime, UpdateTime From dbo.T_Survey;';
Exec sp_executesql N'Create View dbo.Answer As
  Select AnswerId, SurveyId, OpenId, OpenGId, AnswersJson, SubmitTime From dbo.T_Answer;';
Exec sp_executesql N'Create View dbo.Visit As
  Select VisitId, SurveyId, OpenId, OpenGId, VisitTime From dbo.T_Visit;';
Commit;

Select @@TranCount As TranCount;   -- 必須為 0
Select N'T_表' As 類別, name As 名稱 From sys.objects Where type = N'U' And name In (N'T_Survey', N'T_Answer', N'T_Visit')
Union All
Select N'檢視', name From sys.objects Where type = N'V' And name In (N'Survey', N'Answer', N'Visit')
Union All
-- 索引住在 sys.indexes（Create Index 不進 sys.objects）
Select N'索引', i.name From sys.indexes i Where i.name Is Not Null
  And i.object_id In (Object_Id(N'dbo.T_Survey'), Object_Id(N'dbo.T_Answer'), Object_Id(N'dbo.T_Visit'))
Order By 類別, 名稱;   -- 應為 12 列（3 T_表 + 3 檢視 + 6 索引）
