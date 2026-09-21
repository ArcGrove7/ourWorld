// 每小時請求額度（滾動一小時）。站方訂的硬規矩是**每個帳號每小時 600 發**。
//
//   const budget = require('./lib/budget');
//   const b = budget({ perHour: 550, file: 'logs/run/arcgrove.rph' });
//   await b.take('explore');     // 額度滿就等到有位置為止
//   b.tryTake();                 // 不等，滿了回 false（取樣工具用這個，額度要留給產線）
//   b.used();                    // 這一小時已經送出幾發
//
// 滾動一小時，不是「整點歸零」：`sent` 存的是每一發的送出時間，每次取用先把一小時前的丟掉。
// 整點歸零的做法會讓 59 分與 01 分各送 600 發，兩分鐘內 1200 發，照樣被擋。
//
// **`file` 是同一顆帳號的多個行程共用同一份帳本的方法。** 這個專案同一顆帳號可能同時有產線、
// 取樣器、看盤工具在跑，各自記自己的額度就會加總超標。給同一個檔就會共用。
// 檔案壞掉、讀不到、內容不是數字一律當成「這一小時還沒送過」——額度帳本弄丟的代價是可能超標一次，
// 而為了它停掉整條產線不划算；但**絕不會反過來**把壞檔當成「已經滿了」而卡死。
//
// 重試也要佔額度：站方算的是實際送出的請求數，不是「成功幾發」。所以 take() 放在送出那一層，
// 不是放在呼叫端——呼叫端怎麼寫都不重要，送出去之前一定會先被擋下來。

const fs = require('fs');
const path = require('path');

const HOUR = 3600000;

class Budget {
  constructor({ perHour = 600, file = null, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    if (!Number.isFinite(perHour) || perHour <= 0) throw new TypeError('perHour 要是正數');
    this.perHour = perHour;
    this.file = file;
    this.now = now;
    this.sleep = sleep;
    this.sent = file ? loadFile(file) : [];
    this.appends = 0;
    this.prune();
  }

  prune() {
    const cutoff = this.now() - HOUR;
    while (this.sent.length && this.sent[0] < cutoff) this.sent.shift();
  }

  used() { this.prune(); return this.sent.length; }
  left() { return Math.max(0, this.perHour - this.used()); }

  // 還要等多久才有下一個位置（毫秒）。沒滿就是 0
  waitMs() {
    this.prune();
    if (this.sent.length < this.perHour) return 0;
    return Math.max(0, this.sent[0] + HOUR - this.now() + 250);
  }

  // 有位置就拿走一個，滿了回 false（不等）
  tryTake() {
    this.prune();
    if (this.sent.length >= this.perHour) return false;
    const t = this.now();
    this.sent.push(t);
    this.record(t);
    return true;
  }

  // 拿一個位置，滿了就等到有為止。label 只是給 onWait 記錄用的
  async take(label = '') {
    for (;;) {
      if (this.tryTake()) return;
      const wait = this.waitMs();
      if (this.onWait) this.onWait(wait, label);
      await this.sleep(wait);
    }
  }

  record(t) {
    if (!this.file) return;
    try {
      // 平常只 append 一行；每 200 發整理一次，免得檔案無限長大
      if (++this.appends % 200 === 0) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, this.sent.map(n => n + '\n').join(''));
      } else {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.appendFileSync(this.file, t + '\n');
      }
    } catch { /* 寫不進去不影響這一發，下次再試 */ }
  }
}

function loadFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
  } catch { return []; }
}

module.exports = opts => new Budget(opts);
module.exports.Budget = Budget;
module.exports.HOUR = HOUR;
