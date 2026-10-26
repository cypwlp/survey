/*
 * Web SDK 未登錄模式授權函數。
 * Web 端 new cloud.Cloud({ identityless: true, resourceAppid, resourceEnv }) 後
 * await init() 時，雲開發會呼叫這個環境裡的 cloudbase_auth 函數。
 *
 * 回傳 { errCode: 0 } 代表允許未登錄的 Web 訪客使用本環境已授權的資源。
 * auth 會序列化成安全規則裡的 auth.custom，供雲函數/資料庫規則判斷。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  return {
    errCode: 0,
    errMsg: '',
    auth: JSON.stringify({ role: 'web-guest' }),
  };
};
