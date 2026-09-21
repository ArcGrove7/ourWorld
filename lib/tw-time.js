// 台灣時間（UTC+8）的時間戳。人 2026-09-20 下的令：**所有紀錄一律以台灣時間為準**。
//
//   const { twISO, twDate } = require('./lib/tw-time');
//   twISO()   // 2026-09-20T13:39:44.275+08:00
//   twDate()  // 2026-09-20（台灣的那一天）
//
// 為什麼帶 `+08:00` 而不是直接砍掉時區：
// - 它仍然是合法的 ISO 8601，`new Date()` 解得回**同一個瞬間**，不會讓舊紀錄跟新紀錄對不起來。
// - 前綴 `YYYY-MM-DDTHH:MM:SS` 的長度跟 UTC 版一模一樣，所以既有那些用
//   `slice(0, 10)` 分日、`slice(11, 19)` 取時分秒的程式照樣能用，而且分出來的是台灣的日期。
// - 全部紀錄同一個偏移量，字串排序仍然等於時間順序。
//
// **不要改用 toLocaleString**：它的輸出跟語系與執行環境有關，排序與解析都不可靠。
const OFFSET_MINUTES = 8 * 60;

function twISO(d = new Date()) {
  const t = new Date(d.getTime() + OFFSET_MINUTES * 60000);
  return t.toISOString().replace('Z', '+08:00');
}

function twDate(d = new Date()) {
  return twISO(d).slice(0, 10);
}

module.exports = { twISO, twDate, OFFSET_MINUTES };
