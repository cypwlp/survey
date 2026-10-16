/* ============================================================
   04 — 多群模型：一份問卷可以歸屬多個群
   新增 T_SurveyGroup(SurveyId, OpenGId) ＋ 同名檢視 SurveyGroup，
   並把舊的 T_Survey.OpenGId 單一綁定整批搬過去。
   舊欄位 OpenGId 保留不刪（避免動到既有資料），但 app 之後以 SurveyGroup 為準。
   另外要對 public 授與新檢視的 CRUD（03 已把 public 的庫層級權限收光）。
   目標庫：OSurveyDB；用法同 01：@DryRun=1 演練 → 確認無紅字改 0 落地。
   回條：TranCount=0；物件清單應 16 列（4 T_表 + 4 檢視 + 8 索引）。
   有無殘留：不動任何既有資料列；不用暫存表。
   ============================================================ */
Set Quoted_Identifier On;
Set Ansi_Nulls On;
Set ArithAbort On;
Go

Declare @DryRun int = 1;   -- 1=演練（預設） 0=落地

Declare @WantDb sysname = N'OSurveyDB';
Declare @NowDb sysname = DB_Name();   -- RaisError 參數不能放函式呼叫，先指派進變數
If @NowDb <> @WantDb
Begin
    RaisError(N'目前連線的庫是「%s」，不是預期的「%s」。請先切換再執行。', 16, 1, @NowDb, @WantDb);
    Return;
End

Declare @hasViews int = (Select Count(*) From sys.views Where name In (N'Survey', N'Answer', N'Visit'));
If @hasViews <> 3
Begin
    RaisError(N'只找到檢視 %d/3 個，必須先完成 01（或 02）才能做這個。', 16, 1, @hasViews);
    Return;
End

If Object_Id(N'dbo.T_SurveyGroup') Is Not Null Or Object_Id(N'dbo.SurveyGroup') Is Not Null
Begin
    RaisError(N'已存在 T_SurveyGroup 或檢視 SurveyGroup，本腳本只跑一次，中止。', 16, 1);
    Return;
End

-- 舊資料盤點：有多少問卷目前已被綁定單一群
Declare @legacy int = (Select Count(*) From dbo.T_Survey Where OpenGId Is Not Null);

If @DryRun = 1
Begin
    Print N'[演練] 將建立 T_SurveyGroup(SurveyId, OpenGId) 與同名檢視；';
    Print N'[演練] 並把舊的 T_Survey.OpenGId 搬進去（目前 ' + Cast(@legacy As varchar(10)) + N' 筆會被搬移）。';
    Print N'[演練] 會對 public 授與 SurveyGroup 檢視的 Select,Insert,Update,Delete。';
    Print N'[演練] 目前零寫入。確認後把 @DryRun 改 0 再 F5。';
    Return;
End

Set Xact_Abort On;
Begin Tran;

Create Table dbo.T_SurveyGroup (
    SurveyGroupId  BigInt Identity(1,1) Not Null,
    SurveyId       Int            Not Null,
    OpenGId        VarChar(64)    Not Null,   -- 從群卡片進來時解密得到的群標識
    FirstSeenAt    DateTime2(0)   Not Null Constraint DF_SurveyGroup_FirstSeenAt Default(SysUtcDateTime()),
    Constraint PK_SurveyGroup Primary Key (SurveyGroupId),
    Constraint FK_SurveyGroup_Survey Foreign Key (SurveyId) References dbo.T_Survey(SurveyId),
    Constraint UQ_SurveyGroup_Survey_Open Unique (SurveyId, OpenGId)
);

-- 舊單一綁定搬進多群表
Insert Into dbo.T_SurveyGroup (SurveyId, OpenGId)
Select SurveyId, OpenGId From dbo.T_Survey Where OpenGId Is Not Null;

Exec sp_executesql N'Create View dbo.SurveyGroup As
  Select SurveyGroupId, SurveyId, OpenGId, FirstSeenAt From dbo.T_SurveyGroup;';

Declare @g nvarchar(max);
Set @g = N'Grant Select, Insert, Update, Delete On dbo.SurveyGroup To public;';
Exec sp_executesql @g;

Commit;

Select @@TranCount As TranCount;   -- 必須為 0
Select N'T_表' As 類別, name As 名稱 From sys.objects
Where type = N'U' And name In (N'T_Survey', N'T_Answer', N'T_Visit', N'T_SurveyGroup')
Union All
Select N'檢視', name From sys.objects
Where type = N'V' And name In (N'Survey', N'Answer', N'Visit', N'SurveyGroup')
Union All
-- 索引住在 sys.indexes（Create Index 不進 sys.objects）
Select N'索引', i.name From sys.indexes i
Where i.name Is Not Null And i.object_id In (Object_Id(N'dbo.T_Survey'), Object_Id(N'dbo.T_Answer'),
                                             Object_Id(N'dbo.T_Visit'), Object_Id(N'dbo.T_SurveyGroup'))
Order By 類別, 名稱;   -- 應為 16 列（4 T_表 + 4 檢視 + 8 索引）
Print N'--- 舊欄位 T_Survey.OpenGId 已保留未刪；app 之後改以 SurveyGroup 為準 ---';
