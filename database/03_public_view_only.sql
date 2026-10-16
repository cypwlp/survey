/* ============================================================
   03 — 只走檢視的權限模型（收掉 public 的庫層級授與 ＋ 給 public 檢視 CRUD）
   目標庫：OSurveyDB（只影響這一個庫，不碰其他庫、不碰 model）
   效果：任何能連進這個庫的帳號，都只能經 Survey/Answer/Visit 三個檢視存取資料，
        無法直接碰實體表 T_Survey/T_Answer/T_Visit；同時補上原本缺的 DELETE。
   依據（LocalDB 乾淨環境實測）：
     收權後直接查 T_Survey → 消息 229 permission denied ✅
     只給檢視 CRUD → 父表插入／FK 子表插入（REFERENCES 已撤仍生效）／更新／刪除 全部成功 ✅
   用法：整段 Ctrl+A -> F5。@DryRun=1（預設）只盤點；確認後改 0 落地。
   保留 CONNECT：撤了谁都進不了這個庫，所以絕對不動它。
   注意：落地後【連你自己】也無法用這個庫的普通帳號直接查 T_ 表；
        要直查表請改用管理登入（sa／db_owner）。
   ============================================================ */
Set Quoted_Identifier On;
Set Ansi_Nulls On;
Set ArithAbort On;
Go

Declare @DryRun int = 1;   -- 1=盤點（預設） 0=落地

Declare @WantDb sysname = N'OSurveyDB';
Declare @NowDb sysname = DB_Name();   -- RaisError 參數不能放函式呼叫
If @NowDb <> @WantDb
Begin
    RaisError(N'目前連線的庫是「%s」，不是預期的「%s」。請先切換再執行。', 16, 1, @NowDb, @WantDb);
    Return;
End

Declare @hasViews int = (Select Count(*) From sys.views Where name In (N'Survey', N'Answer', N'Visit'));
If @hasViews <> 3
Begin
    RaisError(N'只找到檢視 %d/3 個，必須先完成 01（或 02）才能做這個授權。', 16, 1, @hasViews);
    Return;
End

-- 目前 public 在「資料庫層級」持有哪些授與（要撤的就是其中五種，CONNECT 保留）
Declare @now nvarchar(400) = Isnull(Stuff((Select N',' + c.permission_name
  From sys.database_permissions c
  Where c.grantee_principal_id = User_Id(N'public') And c.class = 0 And c.state_desc = N'GRANT'
  Order By c.permission_name For Xml Path('')), 1, 1, N''), N'（無）');

If @DryRun = 1
Begin
    Print N'[盤點] 將撤銷 public 的庫層級授與：Select／Insert／Update／References／Execute／Alter';
    Print N'[盤點] 將保留：CONNECT（撤了谁都進不了這個庫）';
    Print N'[盤點] 將授與 public：三個檢視的 Select,Insert,Update,Delete';
    Print N'[盤點] 目前 public 實際持有 = ' + @now;
    Print N'[盤點] 未做任何變更。確認後把 @DryRun 改 0 再 F5。';
    Return;
End

-- 撤銷（逐項 Revoke；本來沒授與的項目 Revoke 不會報錯）
Revoke Select On Database::OSurveyDB From public;
Revoke Insert On Database::OSurveyDB From public;
Revoke Update On Database::OSurveyDB From public;
Revoke References On Database::OSurveyDB From public;
Revoke Execute On Database::OSurveyDB From public;
Revoke Alter On Database::OSurveyDB From public;

-- 只給檢視 CRUD
Declare @sql nvarchar(max);
Set @sql = N'Grant Select, Insert, Update, Delete On dbo.Survey To public;';
Exec sp_executesql @sql;
Set @sql = N'Grant Select, Insert, Update, Delete On dbo.Answer To public;';
Exec sp_executesql @sql;
Set @sql = N'Grant Select, Insert, Update, Delete On dbo.Visit To public;';
Exec sp_executesql @sql;

Print N'--- 落地後核對 ---';
Declare @after nvarchar(400) = Isnull(Stuff((Select N',' + c.permission_name
  From sys.database_permissions c
  Where c.grantee_principal_id = User_Id(N'public') And c.class = 0 And c.state_desc = N'GRANT'
  Order By c.permission_name For Xml Path('')), 1, 1, N''), N'（資料庫層級已清空）');
Print N'public 的庫層級授與 变更前 = ' + @now;
Print N'public 的庫層級授與 後    = ' + @after;

Select 物件 = o.name, 類型 = Case When o.type = N'V' Then N'檢視' Else N'表' End,
       授與 = Stuff((Select N',' + p.permission_name From sys.database_permissions p
                     Where p.major_id = o.object_id And p.grantee_principal_id = User_Id(N'public')
                     And p.state_desc = N'GRANT' Order By p.permission_name For Xml Path('')), 1, 1, N'')
From sys.objects o
Where o.name In (N'Survey', N'Answer', N'Visit', N'T_Survey', N'T_Answer', N'T_Visit')
Order By 類型 Desc, 物件;   -- 預期：三個檢視各帶 4 種 GRANT；三張 T_ 表該欄為 NULL（沒授與）

Print N'--- 下一步：重啟後端，啟動自檢應顯示「✓ 結構就緒：三個檢視可用」---';
