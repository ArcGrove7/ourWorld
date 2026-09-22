// 帳號名的封存後綴。
//
//   const { baseAccount } = require('./lib/account');
//   baseAccount('arcgrove7-20260922-1553')            // 'arcgrove7'
//   baseAccount('jun184-20260922-2021-死亡轉生前')      // 'jun184'
//   baseAccount('arcgrove7')                          // 'arcgrove7'
//
// 為什麼需要它：產線重啟或角色轉生時，舊的紀錄檔會被改名成「帳號名-YYYYMMDD-HHMM」，
// 有時後面還接一段人寫的說明。於是**同一顆帳號在資料裡會有好幾個名字**——
// 九顆帳號 2026-09-23 攤開來是 25 個字串。不還原成同一顆的後果有兩種，而且都沒有徵兆：
// 同一次遭遇在新舊名底下各存一筆（去重的鍵含帳號名，所以去不掉），
// 以及一顆帳號的歷史被切成好幾段、每一段都只有殘缺的「它選過什麼」。
//
// 這個規則原本被抄在四支工具裡，四份都只認 `-\d{8}-\d{4}$`，
// 所以「-死亡轉生前」那兩個檔四支都漏掉了。要改就改這裡。
const ARCHIVE_SUFFIX = /-\d{8}-\d{4}(?:-.*)?$/;

const baseAccount = (a) => String(a == null ? '' : a).replace(ARCHIVE_SUFFIX, '');

module.exports = { baseAccount, ARCHIVE_SUFFIX };
