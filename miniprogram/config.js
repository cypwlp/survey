// 後端連法三選一（由上而下優先）：
//
//   A. 微信雲開發（推薦）：填 CLOUD_FUNCTION（本專案：osurvey）
//      請求走 wx.cloud.callFunction → 微信自家內網，不必備案域名、不必對外開 443、
//      不必開公網、也不必管伺服器。計費為固定月費（見 deploy/CLOUDDEV.md）。
//      CLOUD_ENV 可一起填（雲開發控制台右上角的環境 ID，形如 cloud1-9gxxxxxxxx），
//      只有一個環境時可以留空（用預設環境）。
//
//   B. 微信雲托管：填 CLOUD_ENV + CLOUD_SERVICE，請求走 wx.cloud.callContainer 內網鏈路。
//
//   C. 自架 https：A/B 都留空，走 API_BASE。
//
// 開發者工具勾「不校驗合法域名」時，C 的 API_BASE 也可以直接填本機位址。
module.exports = {
  // 自架版才需要填；目前走雲開發（CLOUD_FUNCTION），留空即可。
  API_BASE: '',

  // ── A. 微信雲開發（目前採用的方案）──
  CLOUD_ENV: 'cloud1-d2g83jh3td8664c67',  // 雲開發控制台右上角的環境 ID
  CLOUD_FUNCTION: 'osurvey',              // 啟用雲開發鏈路

  // ── B. 微信雲托管（備援，A 有填就不會走這裡）──
  CLOUD_SERVICE: '',

  // dev 演練用：留空 = 正常模式；填入任意字串（如 'gid-dev'）= 模擬群標識，
  // 讓「遊客模式 + 本機後端」也能走完整條『群卡片→作答』鏈路。
  // 用雲開發時，正式群標識由微信的 CloudID 自動解出，不需要也不能靠這個。
  DEV_OPEN_GID: '',   // 已填入正式 AppID/Secret，關閉模擬群標識；要回本機演練再填 'gid-dev'
};
