/* ============================================================
   06 — MySQL 版建表腳本（微信雲托管 MySQL／自架 MySQL 5.7・8.0）
   目標庫：OSurveyDB（可自訂，但要和 .env 的 DB_NAME 一致）
   用途：DB_DRIVER=mysql 時跑一次，之後 server 就能讀寫真 MySQL。
   與 SQL Server 版（01_schema.sql）的差異：
     * 不用「T_ 表 ＋ 同名檢視」那套：雲托管 MySQL 是專用庫、帳號就是自己的，
       不需要再借檢視隔離寫入權限；表名直接叫 Survey / Answer / Visit / ...
     * 時間欄位存 UTC 牆上時間，由程式寫入（不依賴資料庫時區），
       讀出時 server/src/db.js 會轉成 ISO（帶 Z）再回給小程序。
   用法：貼進雲托管控制台「MySQL → 資料庫管理」的 SQL 視窗執行；
        自架的話：mysql -h<主機> -u<帳號> -p < database/06_mysql_schema.sql
   特性：全部 Create Table If Not Exists → 可重複執行，不會刪改任何既有資料。
   回條：最後一段查詢應回 5 列（Survey / Answer / Visit / SurveyGroup / GroupName）。
   備註：MySQL 8.0 開通時會問「大小寫敏感」，選哪個都行——
        本專案一律用同樣大小寫（PascalCase）存取，不會踩到大小寫坑。
   ============================================================ */

Set Names utf8mb4;

Create Table If Not Exists Survey (
    SurveyId        Int Auto_Increment Not Null,
    Title           Varchar(100)  Not Null,
    GroupName       Varchar(100)  Null,
    OpenGId         Varchar(64)   Null,
    BindMode        Varchar(10)   Not Null Default 'group',
    Announcement    MediumText    Null,
    QuestionsJson   MediumText    Not Null,
    CreatorOpenId   Varchar(64)   Not Null,
    IsClosed        TinyInt(1)    Not Null Default 0,
    CreateTime      DateTime      Not Null Default Current_Timestamp,
    UpdateTime      DateTime      Not Null Default Current_Timestamp,
    Primary Key (SurveyId),
    Key IX_Survey_Creator (CreatorOpenId)
) Engine = InnoDB Default Charset = utf8mb4 Collate = utf8mb4_unicode_ci;

Create Table If Not Exists Answer (
    AnswerId        BigInt Auto_Increment Not Null,
    SurveyId        Int           Not Null,
    OpenId          Varchar(64)   Not Null,
    OpenGId         Varchar(64)   Null,
    AnswersJson     MediumText    Not Null,
    SubmitTime      DateTime      Not Null Default Current_Timestamp,
    Primary Key (AnswerId),
    Unique Key UQ_Answer_Survey_Open (SurveyId, OpenId),
    Constraint FK_Answer_Survey Foreign Key (SurveyId) References Survey (SurveyId)
) Engine = InnoDB Default Charset = utf8mb4 Collate = utf8mb4_unicode_ci;

Create Table If Not Exists Visit (
    VisitId         BigInt Auto_Increment Not Null,
    SurveyId        Int           Not Null,
    OpenId          Varchar(64)   Not Null,
    OpenGId         Varchar(64)   Null,
    VisitTime       DateTime      Not Null Default Current_Timestamp,
    Primary Key (VisitId),
    Unique Key UQ_Visit_Survey_Open (SurveyId, OpenId),
    Constraint FK_Visit_Survey Foreign Key (SurveyId) References Survey (SurveyId)
) Engine = InnoDB Default Charset = utf8mb4 Collate = utf8mb4_unicode_ci;

Create Table If Not Exists SurveyGroup (
    SurveyGroupId   BigInt Auto_Increment Not Null,
    SurveyId        Int           Not Null,
    OpenGId         Varchar(64)   Not Null,
    FirstSeenAt     DateTime      Not Null Default Current_Timestamp,
    Primary Key (SurveyGroupId),
    Unique Key UQ_SurveyGroup_Survey_Open (SurveyId, OpenGId),
    Constraint FK_SurveyGroup_Survey Foreign Key (SurveyId) References Survey (SurveyId)
) Engine = InnoDB Default Charset = utf8mb4 Collate = utf8mb4_unicode_ci;

Create Table If Not Exists GroupName (
    GroupNameId     BigInt Auto_Increment Not Null,
    OpenId          Varchar(64)   Not Null,
    Name            Varchar(100)  Not Null,
    UseCount        Int           Not Null Default 1,
    LastUsedAt      DateTime      Not Null Default Current_Timestamp,
    Primary Key (GroupNameId),
    Unique Key UQ_GroupName_Open_Name (OpenId, Name),
    Key IX_GroupName_Open_LastUsed (OpenId, LastUsedAt)
) Engine = InnoDB Default Charset = utf8mb4 Collate = utf8mb4_unicode_ci;

Select Table_Name As 表, Table_Rows As 估計筆數 From information_schema.Tables
Where Table_Schema = Database()
  And Table_Name In ('Survey', 'Answer', 'Visit', 'SurveyGroup', 'GroupName')
Order By Table_Name;   -- 應為 5 列
