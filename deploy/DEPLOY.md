# 部署清單（10.241.50.213 Docker ＋ 10.241.48.3 IIS 對外）

```
微信客戶端（公網）
      │  https://interior.topmix.net/<路徑>/api/…   ← 必須「受信任憑證」，自簽不行
      ▼
10.241.48.3   Server 2019 ＋ IIS（站點 interior.topmix.net）→ ARR 反向代理
      │  http://10.241.50.213:3001 （內網）
      ▼
10.241.50.213 Docker：survey-api（Node 後端，本服務）
      │  10.241.48.1:1433 （內網）
      ▼
   OSurveyDB（SQL Server 2016）
```

## 0. 已確認的環境事實（讀自 s_od_proxl 的實際配置）

| 項目 | 事實 | 影響 |
|---|---|---|
| 213 出外網能力 | ✅ **有**（`alertmanager.yml:35` 用 `smtp.qq.com:587` 發信、`alert-relay` 發企業微信） | 後端能連 `api.weixin.qq.com`，登入鏈路沒問題 |
| 213 端口佔用 | 80 nginx／8080 odapi／8088 odweb／9090 prometheus／9093 alertmanager／3100 loki／**3000 Grafana** | **本服務用 3001**（compose 已改） |
| Docker 網路 | `odapi-net`（AOI 那套的 compose project 名 `odapi`） | 本服務獨立 compose project，不干擾它 |
| 對外入口 | IIS 站點 `interior.topmix.net`＋ARR → 213 宿主機端口 | 照 ODApi 的模式加一個應用即可 |
| HTTPS 憑證 | **目前是自簽**（RUNBOOK 用 `curl -k`；`setup-https-iis.ps1` 支援 SelfSigned／EnterpriseCA／LetsEncrypt） | ⚠️ **微信不接受自簽憑證**，上正式版前必須換 |

## 1. 在 213 上部署容器

```bash
# 複製 server/ 到 213（例：D:\Deploy_Survey\server）
cd /d/Deploy_Survey/server
cp .env.production.example .env.production
vi .env.production          # 填 DB_PASSWORD、WX_SECRET、TOKEN_SECRET（新的一組）
docker compose up -d --build
docker compose logs -f --tail=30
```

驗收標準（啟動自檢）：

```
✓ 已連線：OSurveyDB｜Microsoft SQL Server 2016
✓ 結構就緒：四個檢視可用（經檢視列數 Survey=0 Answer=0 Visit=0）
```

容器外驗證：`curl -s http://127.0.0.1:3001/api/health` → `"ok":true,"views":4,"tablesOk":true`

## 2. 資料庫帳號（建議專用，別沿用 AOI 的 L5940）

在 SSMS（管理登入）跑：

```sql
Use master;
If Not Exists (Select 1 From sys.server_principals Where name = N'osurvey_app')
  Create Login [osurvey_app] With Password = N'換成強密碼', Check_Expiration_Off;
Go
Use OSurveyDB;
Go
If Not Exists (Select 1 From sys.database_principals Where name = N'osurvey_app')
  Create User [osurvey_app] For Login [osurvey_app];
Go
-- 只給檢視的 CRUD（配合 view-only 模型；不要給表權限）
Grant Select, Insert, Update, Delete On dbo.Survey To [osurvey_app];
Grant Select, Insert, Update, Delete On dbo.Answer To [osurvey_app];
Grant Select, Insert, Update, Delete On dbo.Visit To [osurvey_app];
Grant Select, Insert, Update, Delete On dbo.SurveyGroup To [osurvey_app];
Go
```

## 3. 對外入口（二選一，建議 A，跟 ODApi 同模式）

### A. IIS 加一個應用 ＋ ARR（推薦）— **2026-10-16 已在正式環境打通**

**前置：48.3 上必須安裝兩個模組**（這台原本沒裝，是 500.19 的根因）：

```powershell
# 在「提升權限」的 PowerShell 跑（見文末「權限陷阱」）
$dl = "$env:TEMP\iis-modules"; New-Item -ItemType Directory -Path $dl -Force | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest 'https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi' -OutFile "$dl\rewrite.msi"
Invoke-WebRequest 'https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi' -OutFile "$dl\arr.msi"
Start-Process msiexec.exe -ArgumentList "/i `"$dl\rewrite.msi`" /passive /norestart" -Wait
Start-Process msiexec.exe -ArgumentList "/i `"$dl\arr.msi`" /passive /norestart" -Wait
iisreset
```

**然後開啟 ARR 的反向代理（預設是關的，這步沒做會得到 404.4）**：

```powershell
Import-Module WebAdministration
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value 'True'
```

**⚠️ 權限陷阱（這次卡最久的）**：帳號叫 Administrator ≠ 有提升權限。驗證方式：

```powershell
[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

回 `False` 就是普通權限（`iisreset`、`Get-WebGlobalModule`、`Import-Module WebAdministration` 全部會失敗或靜默回空）。
在現有 PowerShell 用 `Start-Process powershell -Verb RunAs` 開一個新的（會跳 UAC）。

**錯誤碼對照（照這個順序排查）**：

| 錯誤 | 原因 | 修法 |
|---|---|---|
| `404.0`（StaticFile） | web.config 不存在 | 放到**實際物理路徑**（IIS 錯誤頁會顯示，例：`E:\Data\Info\System\SoftWare\ODSurvey\`） |
| `500.19 / 0x8007000d` | ①檔案內容壞（notepad 存檔問題）②**URL Rewrite 模組沒裝** | ①用 `Set-Content -Encoding UTF8` 寫檔 ②裝 URL Rewrite |
| `404.4 / 0x8007007b` | 模組已裝但 IIS 沒重啟（半載入）或 ARR proxy 沒開 | `iisreset` ＋ 開 ARR proxy |
| `502` | ARR proxy 沒開 | 同上 |

在 48.3 的 IIS 站點 `interior.topmix.net` 下新增應用 `ODSurvey`（實體路徑例如 `E:\Data\Info\System\SoftWare\ODSurvey`），
然後在該應用的 `web.config` 放入（ARR 需已啟用）：

```xml
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="survey-to-213" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://10.241.50.213:3001/{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </configuration>
</configuration>
```

這樣 `https://interior.topmix.net/survey/api/…` → `http://10.241.50.213:3001/api/…`（前綴被吃掉，後端不用改）。

### B. 走 213 既有 nginx（需改 s_od_proxl 的 repo）

在 `ODApi/deploy/docker/nginx/nginx-docker.conf` 的 `server { listen 80; }` 內加：

```nginx
    location /survey-api/ {
        proxy_pass http://survey-api:3000/;      # 結尾斜線會吃掉前綴
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
    }
```

並把本服務的 compose 改成「不發布端口、加入 external network `odapi-net`」：

```yaml
networks:
  odapi-net:
    external: true
```

## 4. ⚠️ 憑證與 443（微信的硬門檻，實測現況如下）

**2026-10-16 實測（手機 4G 從公網）：**
- ✅ `http://interior.topmix.net/Info/System/SoftWare/ODProxl/…` **可以訪問** → DNS、NAT、80 埠、IIS 都正常
- ❌ `https://interior.topmix.net` **訪問不了** → 443 未對公網開放
- 憑證現況：CT 日誌查詢**從未有公信 CA 簽發記錄** → 目前是自簽（`setup-https-iis.ps1` 的 LetsEncrypt 分支只是「提示」沒有實作）
- 微信**強制 HTTPS 且不接受自簽** → 這兩件事不解決，正式版／體驗版都連不上

### 第一步：開 443（網路層）
1. NAT／防火牆把 **443 轉到 10.241.48.3**（跟 80 同一條規則照抄）
2. 48.3 的 Windows 防火牆放行入站 443：`New-NetFirewallRule -DisplayName "HTTPS 443" -Direction Inbound -LocalPort 443 -Protocol TCP -Action Allow`
3. 驗證：手機 4G 開 `https://interior.topmix.net` → 這時應該會出現**憑證警告**（自簽的正常現象），能按「繼續」就代表 **443 通了**

### 第二步：簽真憑證（win-acme，走 HTTP-01）
80 埠已對公網開放 → HTTP-01 驗證可行，這是最省事的路：

```powershell
# 在 48.3 上（管理員 PowerShell）
# 1) 下載 win-acme：https://github.com/win-acme/win-acme/releases
#    取 win-acme.v2.*.*.x64.pluggable.zip，解壓到 C:\tools\win-acme
cd C:\tools\win-acme
.\wacs.exe --target iis --host interior.topmix.net --installation iis --store certificatestore
```

它會自動：用 `http://interior.topmix.net/.well-known/acme-challenge/...` 完成驗證 → 簽發 Let's Encrypt 憑證 →
在 IIS 站點建立 443 綁定 → 建立自動續期排程（LE 憑證 90 天到期）。

### 第三步：驗證（這步過了微信才可能通）

```powershell
# 從 48.3 打自己的公網域名（不要用 -k，要驗憑證鏈）
curl.exe https://interior.topmix.net/Info/System/SoftWare/ODApi/health
# 手機 4G 再開一次 https://interior.topmix.net → 應該「無憑證警告」
```

`curl` 若有憑證錯誤 → 回第二步檢查；無錯誤但手機仍開不了 → 查 443 的 NAT／防火牆。

## 5. 微信後台

`mp.weixin.qq.com` → 開發管理 → 開發設定 → 伺服器域名：
- request 合法域名：`https://interior.topmix.net`（若走 A 方案，域名是站點根，路徑不影響白名單）
- downloadFile 合法域名：同上（「匯出 Excel」要用）

## 6. 小程序端

`miniprogram/config.js`：`API_BASE` 改成 `https://interior.topmix.net/survey/api`（A 方案）或
`https://interior.topmix.net/survey-api/api`（B 方案），確認 `DEV_OPEN_GID` 為空，重新上傳。

## 7. 上線後自查

| 檢查 | 指令／方式 | 期望 |
|---|---|---|
| 容器活著 | `docker ps`（213） | `survey-api` Up |
| 健康檢查 | `curl -s https://interior.topmix.net/survey/api/health` | `ok:true, views:4, tablesOk:true` |
| 憑證受信任 | 瀏覽器打開上面的網址 | **無憑證警告**（有警告＝微信也會拒） |
| 登入鏈路 | 手機進小程序首頁 | 顯示 `o` 開頭真 openid |
| 資料落地 | 建問卷 → 作答 → 看統計 | 提交數 +1，`OSurveyDB` 有列 |
| 群綁定 | 從群卡片進入 | 管理頁「已加入的群」出現該群 |

## 8. 維運

```bash
docker compose logs -f survey-api     # 即時日誌（10MB × 3）
docker compose restart survey-api     # 重啟
docker compose up -d --build          # 改版重新部署
```

- 後端**無狀態**（session_key 在記憶體）：重啟後使用者自動重登，資料不受影響
- 資料全在 `OSurveyDB`：備份沿用 10.241.48.1 那台的既有機制
- `.env.production` 含密碼：`chmod 600`，不進版控、不進共享目錄
