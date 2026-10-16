/* ============================================================
   02 — 改成「T_ 實體表 ＋ 同名視圖」模型（Survey → T_Survey ＋ 檢視 Survey）
   目標庫：OSurveyDB（已用 01_schema.sql 建好三張表）
   用法：整段 Ctrl+A -> F5。@DryRun=1（預設）演練零寫入；
        看到只有 Print、無紅字後改成 0 再 F5 落地。
   三道閘門：庫不對→擋；已遷移過→擋；舊表不完整→擋。
   回條：TranCount 必須 0；清單應 12 列（3 張 T_ 表 + 3 檢視 + 6 索引）。
   有無寫入：演練零寫入；落地＝改名＋建視圖，全程在一個交易內，失敗自動回滾。
   有無殘留：不刪資料、不動索引名稱（索引跟著 T_ 表走）。
   備註：Create View 必須是批次第一個陳述式，所以在交易內用 sp_executesql 建立。
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

Declare @oldNow int = (Select Count(*) From sys.tables Where name In (N'Survey', N'Answer', N'Visit'));
Declare @tNow int = (Select Count(*) From sys.tables Where name In (N'T_Survey', N'T_Answer', N'T_Visit'));
Declare @viewNow int = (Select Count(*) From sys.views Where name In (N'Survey', N'Answer', N'Visit'));

If @tNow > 0 Or @viewNow > 0
Begin
    RaisError(N'偵測到已遷移過的跡象（T_ 表 %d 張、同名檢視 %d 個）。本腳本只跑一次，中止。', 16, 1, @tNow, @viewNow);
    Return;
End
If @oldNow <> 3
Begin
    RaisError(N'只找到舊表 %d/3 張，不是一組完整的 01 版結構，中止（不乱改）。', 16, 1, @oldNow);
    Return;
End

Declare @cntS int = (Select Count(*) From dbo.Survey);
Declare @cntA int = (Select Count(*) From dbo.Answer);
Declare @cntV int = (Select Count(*) From dbo.Visit);

If @DryRun = 1
Begin
    Print N'[演練] 將做：sp_Rename 三張表 → T_Survey / T_Answer / T_Visit，再建立同名檢視 Survey / Answer / Visit。';
    Print N'[演練] 現有資料列數：Survey=' + Cast(@cntS As varchar(20))
        + N'，Answer=' + Cast(@cntA As varchar(20))
        + N'，Visit=' + Cast(@cntV As varchar(20)) + N'（新庫為 0 屬正常）。';
    Print N'[演練] 目前零寫入。確認無紅字後把 @DryRun 改 0 再整段 F5 落地。';
    Return;
End

Set Xact_Abort On;
Begin Tran;

Exec sp_Rename N'dbo.Survey', N'T_Survey';
Exec sp_Rename N'dbo.Answer', N'T_Answer';
Exec sp_Rename N'dbo.Visit', N'T_Visit';

Exec sp_executesql N'Create View dbo.Survey As
  Select SurveyId, Title, GroupName, OpenGId, BindMode, Announcement, QuestionsJson,
         CreatorOpenId, IsClosed, CreateTime, UpdateTime From dbo.T_Survey;';
Exec sp_executesql N'Create View dbo.Answer As
  Select AnswerId, SurveyId, OpenId, OpenGId, AnswersJson, SubmitTime From dbo.T_Answer;';
Exec sp_executesql N'Create View dbo.Visit As
  Select VisitId, SurveyId, OpenId, OpenGId, VisitTime From dbo.T_Visit;';

Commit;

Select @@TranCount As TranCount;   -- 必須為 0（若不是 0 代表交易沒結，立刻告訴我）
Select N'T_表' As 類別, name As 名稱 From sys.objects
Where type = N'U' And name In (N'T_Survey', N'T_Answer', N'T_Visit')
Union All
Select N'檢視', name From sys.objects
Where type = N'V' And name In (N'Survey', N'Answer', N'Visit')
Union All
-- 索引住在 sys.indexes（Create Index 不進 sys.objects；PK 在 sys.objects 是 type PK）
Select N'索引', i.name From sys.indexes i
Where i.name Is Not Null
  And i.object_id In (Object_Id(N'dbo.T_Survey'), Object_Id(N'dbo.T_Answer'), Object_Id(N'dbo.T_Visit'))
Order By 類別, 名稱;   -- 應為 12 列（3 T_表 + 3 檢視 + 6 索引：3 PK + 3 自建）
