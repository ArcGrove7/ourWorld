// 行動冷卻：**從行動自己的回應算下一次什麼時候能動，不要再打一發狀態查詢。**
//
// 為什麼要有這一支：幾乎每個文字遊戲的行動端點回應裡本來就帶了「你剛剛是什麼時候動的」
// 與「冷卻多久」。每一圈再打一發 `/status` 去問「我能動了嗎」，等於把每小時額度花掉兩倍、
// 產能砍一半——而且那一發問到的東西，上一發早就給過了。
//
// 這一支不碰網路、不碰時鐘以外的任何東西，所以測得動：`now` 可以注入。
//
//   const { Cooldown } = require('./cooldown');
//   const cd = new Cooldown({ jitterMs: [400, 1200] });
//   const res = await api.post('/api/action', { action: 'hunt' });
//   cd.observe(res);                  // 從回應學到下一次什麼時候能動
//   await cd.wait();                  // 睡到那個時候（含抖動）
//
// 讀不到冷卻資訊時**不猜**：`waitMs()` 回 `fallbackMs`，而 `observed` 會是 false，
// 呼叫端想警告就看得到。猜一個太短的值會一路撞伺服器的 429。

const DEFAULTS = {
  // 回應裡可能長什麼樣。第一個對得上的就用。順序有意義：直接給「還剩多少」的最準。
  remainingKeys: ['cooldownRemainingMs', 'remainingMs', 'retryAfterMs'],
  lastActionKeys: ['lastActionAt', 'lastActedAt', 'lastAction'],
  durationKeys: ['cooldownMs', 'cooldown', 'actionCooldownMs'],
  // 伺服器自己報的現在時刻。有的話就用它算，避免本機時鐘偏移。
  serverTimeKeys: ['serverTime', 'now'],
  fallbackMs: 10000,
  jitterMs: [0, 0],
  maxWaitMs: 15 * 60 * 1000,   // 睡超過這麼久一定是讀錯欄位，不要真的睡下去
};

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

// 冷卻資訊不一定在最外層（常見 `{ data: {...} }`、`{ status: {...} }`）。往下找一層就夠，
// 再深就會撈到不相干的欄位。
function candidates(res) {
  const out = [res];
  if (res && typeof res === 'object') {
    for (const v of Object.values(res)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v);
    }
  }
  return out;
}

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

class Cooldown {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    if (!Array.isArray(o.jitterMs) || o.jitterMs.length !== 2) {
      throw new TypeError('jitterMs 要寫成 [最少, 最多] 兩個數字');
    }
    if (o.jitterMs[0] > o.jitterMs[1]) throw new TypeError('jitterMs 的下限比上限大');
    this.opts = o;
    this.now = opts.now || (() => Date.now());
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.readyAt = null;      // 下一次能動的絕對時刻（毫秒）
    this.observed = false;    // 上一次 observe() 真的讀到冷卻了嗎
    this.source = null;       // 讀到的是哪一種寫法，給日誌用
  }

  // 從一次行動的回應學。回傳自己，方便串接。
  observe(res) {
    this.observed = false;
    this.source = null;
    for (const c of candidates(res)) {
      // ① 伺服器直接說「還剩多少毫秒」——最準，不受時鐘偏移影響
      const remain = pick(c, this.opts.remainingKeys);
      if (typeof remain === 'number' && Number.isFinite(remain) && remain >= 0) {
        this.readyAt = this.now() + remain;
        this.observed = true;
        this.source = 'remaining';
        return this;
      }
    }
    for (const c of candidates(res)) {
      // ② 「上次行動的時刻」＋「冷卻多久」
      const last = toMs(pick(c, this.opts.lastActionKeys));
      const dur = pick(c, this.opts.durationKeys);
      if (last != null && typeof dur === 'number' && Number.isFinite(dur)) {
        // 伺服器報了現在幾點就用它的錶：本機時鐘快幾秒會讓我們提早送、白吃一個 429。
        const serverNow = toMs(pick(c, this.opts.serverTimeKeys));
        const skew = serverNow != null ? this.now() - serverNow : 0;
        this.readyAt = last + dur + skew;
        this.observed = true;
        this.source = 'lastAction+duration';
        return this;
      }
    }
    return this;
  }

  // 現在到「能動」還要等多久。已經能動就是 0。
  waitMs() {
    if (this.readyAt == null) return this.opts.fallbackMs;
    const [lo, hi] = this.opts.jitterMs;
    const jitter = hi > lo ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo;
    const ms = this.readyAt - this.now() + jitter;
    if (ms <= 0) return 0;
    return Math.min(ms, this.opts.maxWaitMs);
  }

  ready() {
    return this.waitMs() === 0;
  }

  async wait() {
    const ms = this.waitMs();
    if (ms > 0) await this.sleep(ms);
    return ms;
  }
}

module.exports = { Cooldown };
