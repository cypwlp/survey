// 後端位址。開發者工具勾「不校驗合法域名」後可直接用本機位址。
// 真機 / 體驗版：改成電腦區網 IP 或已備案的 https 域名。
// 2026-10-16：已部署到 213 Docker，經 48.3 IIS(ARR) 反代對外，
//   HTTPS 已用 win-acme 簽發 Let's Encrypt 憑證（2026-12-10 自動續期）。
module.exports = {
  API_BASE: 'https://interior.topmix.net/Info/System/SoftWare/ODSurvey/api',

  // dev 演練用：留空 = 正常模式；填入任意字串（如 'gid-dev'）= 模擬群標識，
  // 讓「遊客模式 + 本機後端」也能走完整條『群卡片→作答』鏈路（並允許 wx.login 失敗時改用本機假登入）。
  // 正式上線務必清空。
  DEV_OPEN_GID: '',   // 已填入正式 AppID/Secret，關閉模擬群標識；要回本機演練再填 'gid-dev'
};
