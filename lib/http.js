// HTTP 客戶端：硬性超時、有界重試、每一發先過額度、401 直接停、token 不進任何輸出。
//
//   const { client, AuthError, HttpError } = require('./lib/http');
//   const api = client({ base, token, perHour: 550, rphFile: 'logs/run/x.rph' });
//   const r = await api.get('/api/characters');        // 讀：429／5xx／連線壞掉會重試
//   if (!r.ok) ...                                     // 沒過就拿不到資料
//   const w = await api.post('/api/action/explore', {});  // 寫：**預設不重試**
//
// 讀跟寫的重試規矩不一樣，這是這支存在的主因之一：
// **寫入 API 的逾時與 5xx 不自動重送**（這個 repo 的規矩）。`POST /api/action/explore` 逾時
// 不代表沒送到——伺服器可能已經把那一發行動算進去了，重送就變成兩次行動、兩次冷卻、
// 紀錄跟實際對不起來。要重送必須是呼叫端看過回應、確定沒送到才決定，所以 `post()` 預設
// `retries: 0`，要開得自己寫出來。`get()` 是純讀，重送最多就是多花額度，所以預設會重試。
//
// 401／403 一律當場停：token 過期之後每一發都會是 401，重試只是把額度燒光。
// 它丟 AuthError 而不是 process.exit——函式庫不該替呼叫端決定結束碼。
// 想要舊那種「直接停」的行為就包一層 runMain()（見下）。
//
// token 永遠不進 error.message、不進 log：錯誤訊息只帶方法、路徑、狀態碼。

const budgetOf = require('./budget');
const { redact } = require('./token');

class AuthError extends Error {
  constructor(status, path) { super(`${status}：token 過期或無效（${path}）`); this.name = 'AuthError'; this.status = status; this.exitCode = 3; }
}
class HttpError extends Error {
  constructor(status, method, path, body) {
    super(`${method} ${path} 回 ${status}${body ? '：' + redact(String(body)).slice(0, 200) : ''}`);
    this.name = 'HttpError'; this.status = status; this.exitCode = 1;
  }
}
class BudgetError extends Error {
  constructor(perHour) { super(`每小時額度 ${perHour} 發用滿了`); this.name = 'BudgetError'; this.exitCode = 0; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Client {
  constructor({
    base,
    token,
    perHour = 600,
    rphFile = null,
    budget = null,
    timeoutMs = 25000,
    retries = 2,
    waitForBudget = true,     // false = 額度滿就丟 BudgetError，不等（取樣工具用）
    log = () => {},
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!base) throw new TypeError('要給 base');
    this.base = base.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.waitForBudget = waitForBudget;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.budget = budget || budgetOf({ perHour, file: rphFile });
    this.sentCount = 0;
  }

  get(path, opts = {}) { return this.request('GET', path, undefined, opts); }

  // 寫入預設不重試，理由見檔頭
  post(path, body, opts = {}) { return this.request('POST', path, body, { retries: 0, ...opts }); }

  async request(method, path, body, { retries = this.retries, timeoutMs = this.timeoutMs, headers = {} } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      // 重試也佔額度：站方算的是實際送出的請求數
      if (this.waitForBudget) await this.budget.take(`${method} ${path}`);
      else if (!this.budget.tryTake()) throw new BudgetError(this.budget.perHour);

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        this.sentCount++;
        const res = await this.fetchImpl(this.base + path, {
          method,
          headers: {
            ...(this.token ? { authorization: 'Bearer ' + this.token } : {}),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ac.signal,
        });

        if (res.status === 401 || res.status === 403) throw new AuthError(res.status, path);

        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
          if (attempt < retries) {
            const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1);
            this.log(`${method} ${path} 回 ${res.status}，${wait}ms 後重試（第 ${attempt + 1}/${retries} 次）`);
            await sleep(wait);
            continue;
          }
          return { ok: false, status: res.status, json: null, text: await safeText(res) };
        }

        const text = await safeText(res);
        let json = null;
        if (text) { try { json = JSON.parse(text); } catch { /* 不是 JSON 就只給 text */ } }
        return { ok: res.ok, status: res.status, json, text };
      } catch (e) {
        if (e instanceof AuthError) throw e;
        lastErr = e;
        // 連線壞掉／逾時：只有還有重試次數才重來（寫入預設 retries=0，所以會直接丟出去）
        if (attempt < retries) {
          this.log(`${method} ${path} ${e.name === 'AbortError' ? '逾時' : '連線失敗'}，重試（第 ${attempt + 1}/${retries} 次）`);
          await sleep(1500 * (attempt + 1));
          continue;
        }
      } finally { clearTimeout(timer); }
    }
    const err = new Error(`${method} ${path} 失敗：${redact(lastErr && lastErr.message) || '不明'}`);
    err.exitCode = 1;
    err.cause = lastErr;
    throw err;
  }
}

async function safeText(res) { try { return await res.text(); } catch { return ''; } }

// 把整支工具包起來：錯誤印成人看得懂的一行，結束碼照這個 repo 的慣例
// （3 = 要人來看的停機，1 = 一般失敗，0 = 可以直接再跑）。
function runMain(fn) {
  Promise.resolve()
    .then(fn)
    .catch(e => {
      console.error(redact(e && e.message) || String(e));
      process.exit(Number.isInteger(e && e.exitCode) ? e.exitCode : 1);
    });
}

module.exports = { client: o => new Client(o), Client, AuthError, HttpError, BudgetError, runMain };
