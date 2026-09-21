// 命令列參數解析。`--key value`、`--key=value`、`--flag` 三種寫法。
//
//   const cli = require('./lib/cli');
//   const args = cli();                                  // 預設吃 process.argv.slice(2)
//   const out    = args.str('out', 'logs/run.jsonl');
//   const levels = args.num('levels', 7);
//   const acts   = args.list('actions', 'hunt,fishing');
//   const dry    = args.flag('dry');
//   args.done();                                         // 沒人讀過的參數＝打錯了，當場停
//
// 為什麼要有這一支：`const opt = (k, d) => { const i = args.indexOf('--' + k); ... }` 這一行
// 在這個 repo 裡被抄了 32 份。抄得一模一樣還算好，問題是它們**都沒有檢查參數有沒有打錯**——
// `--stop-levl 100` 不會有任何錯誤訊息，那一項就是靜靜地用預設值跑。在這個專案裡那不是小事：
// `--stop-level` 打錯就是產線不會在該停的地方停，而轉生是回不去的操作。
// `done()` 就是為了這個：任何沒被任何一次 str/num/list/flag 讀走的 `--參數`，結束碼 2 停機。
//
// 它也順手擋掉「`--out` 後面沒接值」這種寫法（下一個 token 也是 `--開頭` 就當沒給值），
// 舊寫法會把下一個參數名當成值，於是 `--out --dry` 會產出一個叫 `--dry` 的檔案。

class Args {
  constructor(argv) {
    this.raw = argv.slice();
    this.map = new Map();      // key -> { value: string | true, token: string }
    this.positional = [];
    this.read = new Set();
    let i = 0;
    while (i < argv.length) {
      const a = argv[i];
      if (!a.startsWith('--')) { this.positional.push(a); i++; continue; }
      if (a === '--') { this.positional.push(...argv.slice(i + 1)); break; }
      const eq = a.indexOf('=');
      if (eq > 2) {
        this.map.set(a.slice(2, eq), { value: a.slice(eq + 1), token: a });
        i++;
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { this.map.set(key, { value: true, token: a }); i++; }
      else { this.map.set(key, { value: next, token: a }); i += 2; }
    }
  }

  // 有給這個參數嗎（不管有沒有帶值）
  has(key) { return this.map.has(key); }

  // 字串。給了 `--key` 但沒帶值＝寫法錯誤，直接停（不是回 true，那會變成 'true' 這種鬼值）
  str(key, fallback) {
    this.read.add(key);
    const e = this.map.get(key);
    if (!e) return fallback;
    if (e.value === true) fail(`--${key} 後面要接一個值`);
    return e.value;
  }

  // 數字。帶了不是數字的東西就停，不要讓 NaN 流進去（NaN 比較永遠是 false，會安靜地改變行為）
  num(key, fallback) {
    this.read.add(key);
    const e = this.map.get(key);
    if (!e) return fallback;
    if (e.value === true) fail(`--${key} 後面要接一個數字`);
    const n = Number(e.value);
    if (!Number.isFinite(n)) fail(`--${key} 要是數字，收到「${e.value}」`);
    return n;
  }

  // 逗號分隔的清單。空字串回空陣列，不是 ['']
  list(key, fallback = []) {
    this.read.add(key);
    const e = this.map.get(key);
    if (!e) return Array.isArray(fallback) ? fallback.slice() : String(fallback).split(',').filter(Boolean);
    if (e.value === true) fail(`--${key} 後面要接逗號分隔的清單`);
    return e.value.split(',').map(s => s.trim()).filter(Boolean);
  }

  // 旗標。`--dry` 與 `--dry true` 都算開，`--dry false`／`--dry 0` 算關
  flag(key) {
    this.read.add(key);
    const e = this.map.get(key);
    if (!e) return false;
    if (e.value === true) return true;
    return !['false', '0', 'no', ''].includes(String(e.value).toLowerCase());
  }

  // 只准是這幾個值其中之一（例如 --mode perlevel|peraction|ratio）
  enum(key, allowed, fallback) {
    const v = this.str(key, fallback);
    if (v !== undefined && !allowed.includes(v)) {
      fail(`--${key} 只能是 ${allowed.join('｜')}，收到「${v}」`);
    }
    return v;
  }

  // 沒被讀過的參數＝打錯字或用了已經移除的參數。結束碼 2（呼叫端的錯，不是要人看的停機）
  done() {
    const unknown = [...this.map.keys()].filter(k => !this.read.has(k));
    if (unknown.length) {
      fail(`不認得的參數：${unknown.map(k => '--' + k).join('、')}\n（打錯字的參數會被安靜忽略，所以這裡直接停）`);
    }
    return this;
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

module.exports = function cli(argv = process.argv.slice(2)) { return new Args(argv); };
module.exports.Args = Args;
