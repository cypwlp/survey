/* ============================================================
   05 — 群名歷史存進資料庫（換手機、換人不丟）
   新增 T_GroupName(OpenId, Name, UseCount, LastUsedAt) ＋ 同名檢視 GroupName。
   每位管理員只看得到自己那份清單（app 端一律用 OpenId 過濾）。
   既有問卷的群名不搬移：由小程式首次載入時，把手機本機記住的群名推上來一次。
   目標庫：OSurveyDB；用法同 01：@DryRun=1 演練 → 確認無紅字改 0 落地。
   回條：TranCount=0；物件清單應 5 列（1 T_表 + 1 檢視 + 3 索引）。
   有無寫入：演練階段零寫入；落地只新增一個物件，不改任何既有資料列。
   有無殘留：不用暫存表、不建外部物件；回退只要 Drop 這張表與檢視（不在本腳本內）。
   tempdb：無大排序、無游標，用量可忽略。
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

Declare @hasViews int = (Select Count(*) From sys.views Where name In (N'Survey', N'Answer', N'Visit', N'SurveyGroup'));
If @hasViews <> 4
Begin
    RaisError(N'只找到檢視 %d/4 個，必須先完成 01（或 02）與 04 才能做這個。', 16, 1, @hasViews);
    Return;
End

If Object_Id(N'dbo.T_GroupName') Is Not Null Or Object_Id(N'dbo.GroupName') Is Not Null
Begin
    RaisError(N'已存在 T_GroupName 或檢視 GroupName，本腳本只跑一次，中止。', 16, 1);
    Return;
End

If @DryRun = 1
Begin
    Print N'[演練] 將建立 dbo.T_GroupName（OpenId + Name 唯一）與同名檢視 GroupName；';
    Print N'[演練] 會對 public 授與 GroupName 檢視的 Select,Insert,Update,Delete（同 03 的模式）。';
    Print N'[演練] 不搬移任何既有資料列，目前零寫入。確認後把 @DryRun 改 0 再 F5。';
    Return;
End

Set Xact_Abort On;
Begin Tran;

Create Table dbo.T_GroupName (
    GroupNameId   BigInt Identity(1,1) Not Null,
    OpenId        VarChar(64)    Not Null,      -- 哪位管理員的清單
    Name          NVarChar(100)  Not Null,
    UseCount      Int            Not Null Constraint DF_GroupName_UseCount Default(1),
    LastUsedAt    DateTime2(0)   Not Null Constraint DF_GroupName_LastUsedAt Default(SysUtcDateTime()),
    Constraint PK_GroupName Primary Key (GroupNameId),
    Constraint UQ_GroupName_Open_Name Unique (OpenId, Name)
);

Create Index IX_GroupName_Open_LastUsed On dbo.T_GroupName (OpenId) Include (Name, LastUsedAt);

Exec sp_executesql N'Create View dbo.GroupName As
  Select GroupNameId, OpenId, Name, UseCount, LastUsedAt From dbo.T_GroupName;';

Declare @g nvarchar(max);
Set @g = N'Grant Select, Insert, Update, Delete On dbo.GroupName To public;';
Exec sp_executesql @g;

Commit;

Select @@TranCount As TranCount;   -- 必須為 0
Select N'T_表' As 類別, name As 名稱 From sys.objects
Where type = N'U' And name = N'T_GroupName'
Union All
Select N'檢視', name From sys.objects Where type = N'V' And name = N'GroupName'
Union All
-- 索引住在 sys.indexes（Create Index 不進 sys.objects）
Select N'索引', i.name From sys.indexes i
Where i.name Is Not Null And i.object_id = Object_Id(N'dbo.T_GroupName')
Order By 類別, 名稱;   -- 應為 5 列（1 T_表 + 1 檢視 + 3 索引）
