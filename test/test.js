#!/usr/bin/env node
// polite-cli 工具包的回歸測試。不連線、不碰遊戲 API，純函式。
//
//   node test/test.js
//
// 這些模組是所有工具共用的底層，改壞一行會同時壞掉三十幾支工具，所以守得比別處緊：
// 每一條「規矩」（寫入不重試、重試也佔額度、token 不落地、打錯參數要停）都有一項對應的測試。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', 'lib');
const cli = require(path.join(root, 'cli'));
const budget = require(path.join(root, 'budget'));
const jsonl = require(path.join(root, 'jsonl'));
const tok = require(path.join(root, 'token'));
const { client, AuthError, BudgetError } = require(path.join(root, 'http'));

let pass = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lib-'));
function ok(name, fn) {
  try { fn(); console.log('✔ ' + name); pass++; }
  catch (e) { console.error('✘ ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log('✔ ' + name); pass++; }
  catch (e) { console.error('✘ ' + name + '\n  ' + e.message); process.exitCode = 1; }
}

// 在子行程裡跑一小段程式，回 { code, out }。用來測 process.exit 的那幾條
function runNode(src, { env = {}, argv = [] } = {}) {
  const f = path.join(tmp, 'snippet-' + Math.random().toString(36).slice(2) + '.js');
  fs.writeFileSync(f, src);
  try {
    const out = execFileSync(process.execPath, [f, ...argv], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

(async () => {
  // ───────────────────────── cli
  ok('cli：--key value、--key=value、--flag 三種寫法都吃', () => {
    const a = cli(['--out', 'x', '--mode=ratio', '--dry']);
    assert.equal(a.str('out'), 'x');
    assert.equal(a.str('mode'), 'ratio');
    assert.equal(a.flag('dry'), true);
  });
  ok('cli：沒給就用預設值', () => {
    const a = cli([]);
    assert.equal(a.str('out', '預設'), '預設');
    assert.equal(a.num('n', 7), 7);
    assert.deepEqual(a.list('acts', []), []);
    assert.equal(a.flag('dry'), false);
  });
  ok('cli：list 會 trim 並丟掉空項，空字串回空陣列', () => {
    assert.deepEqual(cli(['--a', 'x, y ,,z']).list('a'), ['x', 'y', 'z']);
    assert.deepEqual(cli(['--a', '']).list('a'), []);
  });
  ok('cli：--flag false／0 算關', () => {
    assert.equal(cli(['--dry', 'false']).flag('dry'), false);
    assert.equal(cli(['--dry', '0']).flag('dry'), false);
    assert.equal(cli(['--dry', 'true']).flag('dry'), true);
  });
  ok('cli：--out 後面接另一個參數時，不會把參數名當成值', () => {
    const a = cli(['--out', '--dry']);
    assert.equal(a.has('out'), true);
    assert.equal(a.flag('dry'), true);          // --dry 仍然是旗標
  });
  ok('cli：--out 沒帶值時 str() 結束碼 2', () => {
    const r = runNode(`require(${JSON.stringify(path.join(root, 'cli'))})(['--out']).str('out');`);
    assert.equal(r.code, 2, '應該以結束碼 2 停');
  });
  ok('cli：--n 帶了非數字就停，不讓 NaN 流進去', () => {
    const r = runNode(`require(${JSON.stringify(path.join(root, 'cli'))})(['--n','abc']).num('n',1);`);
    assert.equal(r.code, 2);
    assert.match(r.out, /要是數字/);
  });
  ok('cli：打錯字的參數 done() 會抓到並停（--stop-levl）', () => {
    const p = JSON.stringify(path.join(root, 'cli'));
    const r = runNode(`const a=require(${p})(['--stop-levl','100']);a.num('stop-level',0);a.done();`);
    assert.equal(r.code, 2);
    assert.match(r.out, /--stop-levl/);
  });
  ok('cli：參數都讀過時 done() 不吵', () => {
    const p = JSON.stringify(path.join(root, 'cli'));
    const r = runNode(`const a=require(${p})(['--stop-level','100']);a.num('stop-level',0);a.done();console.log('ok');`);
    assert.equal(r.code, 0);
  });
  ok('cli：enum 擋掉不在清單裡的值', () => {
    const p = JSON.stringify(path.join(root, 'cli'));
    assert.equal(runNode(`require(${p})(['--mode','ratio']).enum('mode',['perlevel','ratio'],'ratio');`).code, 0);
    assert.equal(runNode(`require(${p})(['--mode','nope']).enum('mode',['perlevel','ratio'],'ratio');`).code, 2);
  });

  // ───────────────────────── budget
  ok('budget：滾動一小時，不是整點歸零', () => {
    let t = 1e9;
    const b = budget({ perHour: 3, now: () => t });
    assert.equal(b.tryTake(), true); assert.equal(b.tryTake(), true); assert.equal(b.tryTake(), true);
    assert.equal(b.tryTake(), false, '滿了就不能再拿');
    t += 3600001;
    assert.equal(b.used(), 0, '一小時之後舊的要滾掉');
    assert.equal(b.tryTake(), true);
  });
  ok('budget：used／left／waitMs 對得上', () => {
    let t = 1e9;
    const b = budget({ perHour: 2, now: () => t });
    b.tryTake();
    assert.equal(b.used(), 1); assert.equal(b.left(), 1); assert.equal(b.waitMs(), 0);
    b.tryTake();
    assert.equal(b.left(), 0);
    assert.ok(b.waitMs() > 0, '滿了要回一個等待時間');
  });
  await okAsync('budget：take() 會等到有位置', async () => {
    let t = 1e9;
    let slept = 0;
    const b = budget({ perHour: 1, now: () => t, sleep: async ms => { slept += ms; t += ms; } });
    await b.take();
    await b.take();                       // 這一發要等
    assert.ok(slept >= 3600000, `應該等滿一小時，實際等了 ${slept}`);
  });
  ok('budget：同一個檔案的兩個行程共用同一份帳本', () => {
    const f = path.join(tmp, 'shared.rph');
    const a = budget({ perHour: 3, file: f });
    a.tryTake(); a.tryTake();
    const b = budget({ perHour: 3, file: f });   // 另一個「行程」
    assert.equal(b.used(), 2, '要看得到前一個行程送過的');
    assert.equal(b.tryTake(), true);
    assert.equal(budget({ perHour: 3, file: f }).tryTake(), false, '三發之後就滿了');
  });
  ok('budget：帳本檔壞掉時當成「還沒送過」，不卡死', () => {
    const f = path.join(tmp, 'broken.rph');
    fs.writeFileSync(f, 'not-a-number\n\nNaN\n');
    const b = budget({ perHour: 2, file: f });
    assert.equal(b.used(), 0);
    assert.equal(b.tryTake(), true, '壞檔不能讓工具卡死');
  });
  ok('budget：perHour 不是正數就丟錯', () => {
    assert.throws(() => budget({ perHour: 0 }), TypeError);
  });

  // ───────────────────────── token
  ok('token：帳號名轉環境變數名', () => {
    assert.equal(tok.envNameFor('arcgrove7'), 'MD_TOKEN_ARCGROVE7');
    assert.equal(tok.envNameFor('jy03-work'), 'MD_TOKEN_JY03WORK');
  });
  ok('token：有帳號專屬的就用它，沒有才退回 MD_TOKEN', () => {
    assert.equal(tok.tokenFor('arcgrove7', { MD_TOKEN_ARCGROVE7: 'A', MD_TOKEN: 'B' }), 'A');
    assert.equal(tok.tokenFor('nobody', { MD_TOKEN: 'B' }), 'B');
    assert.equal(tok.tokenFor(null, {}), null);
  });
  ok('token：redact 把 JWT 換掉', () => {
    const out = tok.redact('authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig');
    assert.ok(!out.includes('eyJ'), 'redact 之後不能還看得到 token');
    assert.match(out, /<redacted>/);
  });
  ok('token：沒有環境變數時結束碼 3', () => {
    const p = JSON.stringify(path.join(root, 'token'));
    const r = runNode(`require(${p}).requireToken();`, { env: { MD_TOKEN: '' } });
    assert.equal(r.code, 3);
  });
  ok('token：token 寫在命令列參數就當場停', () => {
    const p = JSON.stringify(path.join(root, 'token'));
    const r = runNode(`require(${p}).requireToken();`,
      { env: { MD_TOKEN: 'ok' }, argv: ['--token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'] });
    assert.equal(r.code, 3, 'token 出現在 argv 就要停');
    assert.match(r.out, /環境變數/);
  });

  // ───────────────────────── http
  function fakeFetch(plan) {
    const calls = [];
    const impl = async (url, o) => {
      calls.push({ url, method: o.method, headers: o.headers, body: o.body });
      const r = plan(url, calls.length);
      if (r instanceof Error) throw r;
      return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: k => (r.headers || {})[k] || null }, text: async () => r.text ?? '' };
    };
    return { impl, calls };
  }
  const mk = (f, extra = {}) => client({ base: 'http://x', token: 'eyJa.eyJb.c', fetchImpl: f, log: () => {}, ...extra });

  await okAsync('http：200 回 { ok, status, json }', async () => {
    const f = fakeFetch(() => ({ status: 200, text: '{"hi":1}' }));
    const r = await mk(f.impl).get('/a');
    assert.deepEqual(r.json, { hi: 1 });
    assert.equal(r.ok, true);
  });
  await okAsync('http：帶上 Bearer，而且 token 不出現在錯誤訊息裡', async () => {
    const f = fakeFetch(() => ({ status: 500, text: 'boom' }));
    const c = mk(f.impl, { retries: 0 });
    const r = await c.get('/a');
    assert.match(f.calls[0].headers.authorization, /^Bearer /);
    assert.ok(!JSON.stringify(r).includes('eyJa'), '回傳裡不能有 token');
  });
  await okAsync('http：GET 對 5xx 有界重試', async () => {
    const f = fakeFetch(() => ({ status: 503 }));
    const r = await mk(f.impl, { retries: 2 }).get('/a');
    assert.equal(f.calls.length, 3, '1 次加 2 次重試');
    assert.equal(r.status, 503);
  });
  await okAsync('http：GET 重試成功就回成功', async () => {
    const f = fakeFetch((u, n) => (n === 1 ? { status: 503 } : { status: 200, text: '{"ok":1}' }));
    const r = await mk(f.impl, { retries: 2 }).get('/a');
    assert.equal(r.ok, true);
    assert.equal(f.calls.length, 2);
  });
  await okAsync('http：**POST 預設不重送**（寫入逾時／5xx 不自動重試）', async () => {
    const f = fakeFetch(() => ({ status: 503 }));
    const r = await mk(f.impl, { retries: 5 }).post('/api/action/explore', {});
    assert.equal(f.calls.length, 1, `寫入只能送一次，實際送了 ${f.calls.length}`);
    assert.equal(r.status, 503);
  });
  await okAsync('http：POST 逾時也只送一次', async () => {
    const f = fakeFetch(() => Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await assert.rejects(() => mk(f.impl, { retries: 5 }).post('/api/action/explore', {}));
    assert.equal(f.calls.length, 1);
  });
  await okAsync('http：401 直接丟 AuthError，不重試', async () => {
    const f = fakeFetch(() => ({ status: 401 }));
    await assert.rejects(() => mk(f.impl, { retries: 3 }).get('/a'), e => e instanceof AuthError && e.exitCode === 3);
    assert.equal(f.calls.length, 1, '401 不該重試，那只是把額度燒光');
  });
  await okAsync('http：重試也佔額度', async () => {
    const f = fakeFetch(() => ({ status: 503 }));
    let t = 1e9;
    const b = budget({ perHour: 10, now: () => t });
    await mk(f.impl, { retries: 2, budget: b }).get('/a');
    assert.equal(b.used(), 3, `送了 3 發就要扣 3 個額度，實際 ${b.used()}`);
  });
  await okAsync('http：waitForBudget=false 時額度滿了丟 BudgetError', async () => {
    const f = fakeFetch(() => ({ status: 200, text: '{}' }));
    let t = 1e9;
    const b = budget({ perHour: 1, now: () => t });
    const c = mk(f.impl, { budget: b, waitForBudget: false });
    await c.get('/a');
    await assert.rejects(() => c.get('/b'), e => e instanceof BudgetError);
  });
  await okAsync('http：429 照 Retry-After 等', async () => {
    const f = fakeFetch((u, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '0' } } : { status: 200, text: '{}' }));
    const r = await mk(f.impl, { retries: 1 }).get('/a');
    assert.equal(r.ok, true);
    assert.equal(f.calls.length, 2);
  });

  // ───────────────────────── jsonl
  ok('jsonl：寫進去讀得回來', () => {
    const f = path.join(tmp, 'a.jsonl');
    const w = jsonl.writer(f, { append: false });
    w.write({ a: 1 }); w.write({ b: 2 });
    assert.deepEqual(jsonl.read(f), [{ a: 1 }, { b: 2 }]);
    assert.equal(w.count(), 2);
  });
  ok('jsonl：行程被砍留下的半行只跳過那一行，前面照樣讀得到', () => {
    const f = path.join(tmp, 'b.jsonl');
    const w = jsonl.writer(f, { append: false });
    w.write({ a: 1 }); w.write({ b: 2 });
    fs.appendFileSync(f, '{"半行');
    const bad = [];
    assert.equal(jsonl.read(f, { onBadLine: (n) => bad.push(n) }).length, 2);
    assert.deepEqual(bad, [3]);
  });
  ok('jsonl：檔案不存在回空陣列，不丟錯', () => {
    assert.deepEqual(jsonl.read(path.join(tmp, '沒有這個檔.jsonl')), []);
  });
  await okAsync('jsonl：stream 一行一行來', async () => {
    const f = path.join(tmp, 'c.jsonl');
    const w = jsonl.writer(f, { append: false });
    for (let i = 0; i < 5; i++) w.write({ i });
    const got = [];
    for await (const r of jsonl.stream(f)) got.push(r.i);
    assert.deepEqual(got, [0, 1, 2, 3, 4]);
  });
  ok('jsonl：readDir 把一個資料夾的 .jsonl 全部讀進來', () => {
    const d = path.join(tmp, 'dir');
    jsonl.writer(path.join(d, 'a.jsonl'), { append: false }).write({ n: 1 });
    jsonl.writer(path.join(d, 'b.jsonl'), { append: false }).write({ n: 2 });
    fs.writeFileSync(path.join(d, '不是.txt'), 'x');
    assert.deepEqual(jsonl.readDir(d).map(r => r.n), [1, 2]);
  });

  // ───────────────────────── cooldown：從行動回應算冷卻，不打狀態查詢
  {
    const { Cooldown } = require(path.join(root, 'cooldown'));
    ok('cooldown：伺服器直接給「還剩多少毫秒」時照用', () => {
      let t = 1000;
      const cd = new Cooldown({ now: () => t });
      cd.observe({ cooldownRemainingMs: 5000 });
      assert.equal(cd.observed, true);
      assert.equal(cd.source, 'remaining');
      assert.equal(cd.waitMs(), 5000);
      t = 6000;
      assert.equal(cd.waitMs(), 0);
      assert.equal(cd.ready(), true);
    });
    ok('cooldown：lastActionAt + cooldownMs 也算得出來，而且用伺服器的錶修正時鐘偏移', () => {
      // 本機比伺服器快 3 秒：serverTime 是 10000，本機 now 是 13000
      const cd = new Cooldown({ now: () => 13000 });
      cd.observe({ data: { lastActionAt: new Date(10000).toISOString(), cooldownMs: 10000, serverTime: new Date(10000).toISOString() } });
      assert.equal(cd.source, 'lastAction+duration');
      // 伺服器的錶：10000 + 10000 = 20000 能動；本機快 3 秒，所以本機要等到 23000，現在 13000 → 等 10000
      assert.equal(cd.waitMs(), 10000);
    });
    ok('cooldown：讀不到冷卻不猜，回 fallbackMs 並標 observed=false', () => {
      const cd = new Cooldown({ fallbackMs: 4321 });
      cd.observe({ ok: true });
      assert.equal(cd.observed, false);
      assert.equal(cd.waitMs(), 4321);
    });
    ok('cooldown：抖動只加不減，而且不會睡超過 maxWaitMs', () => {
      const cd = new Cooldown({ now: () => 0, jitterMs: [100, 100], maxWaitMs: 2000 });
      cd.observe({ cooldownRemainingMs: 500 });
      assert.equal(cd.waitMs(), 600);
      cd.observe({ cooldownRemainingMs: 99999999 });
      assert.equal(cd.waitMs(), 2000, '讀錯欄位不能真的睡下去');
    });
    ok('cooldown：jitterMs 寫錯就拒絕建立', () => {
      assert.throws(() => new Cooldown({ jitterMs: [5, 1] }), TypeError);
      assert.throws(() => new Cooldown({ jitterMs: 3 }), TypeError);
    });
    await okAsync('cooldown：wait() 真的睡到能動', async () => {
      let t = 0; const slept = [];
      const cd = new Cooldown({ now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
      cd.observe({ cooldownRemainingMs: 700 });
      const ms = await cd.wait();
      assert.equal(ms, 700);
      assert.deepEqual(slept, [700]);
      assert.equal(cd.ready(), true);
    });
  }

  // ───────────────────────── tally：存原始總計、證據只增不減
  {
    const { Tally } = require(path.join(root, 'tally'));
    ok('tally：累計是總計不是平均，死亡記下最強的那個', () => {
      const t = new Tally();
      t.add({ optionId: 'a', success: true, points: { int: 1 } });
      t.add({ optionId: 'a', success: true, points: { int: 1 } });
      t.add({ optionId: 'a', success: false, battle: true, died: true, power: 500 });
      t.add({ optionId: 'a', success: false, battle: true, died: true, power: 300 });
      const r = t.table().a;
      assert.equal(r.n, 4); assert.equal(r.successes, 2); assert.equal(r.battles, 2); assert.equal(r.deaths, 2);
      assert.equal(r.points.int, 2, '要是總計 2，不是平均 0.5');
      assert.equal(r.deathPowerMax, 500);
    });
    ok('tally：危險區的分母只算「不比害死過的最強的人強」的樣本', () => {
      const recs = [
        { optionId: 'a', died: true, power: 100 },
        { optionId: 'a', power: 80 },
        { optionId: 'a', power: 900 },   // 比 100 強，不進危險區分母
      ];
      const t = new Tally(); recs.forEach((r) => t.add(r));
      const r = t.table(recs).a;
      assert.equal(r.nBelow, 2); assert.equal(r.deathsBelow, 1);
    });
    ok('tally：merge 逐欄位取大，正的獎勵與負的扣點可以並存', () => {
      const prev = { a: { n: 1, successes: 0, deaths: 0, points: { hp: -10 }, unlocks: [] } };
      const next = { a: { n: 1, successes: 1, deaths: 0, points: { atk: 1 }, unlocks: ['x'] }, b: { n: 2, points: {} } };
      const m = Tally.merge(prev, next);
      assert.equal(m.a.points.hp, -10, '舊列獨有的扣點不能被整筆換掉');
      assert.equal(m.a.points.atk, 1);
      assert.deepEqual(m.a.unlocks, ['x']);
      assert.equal(m.b.n, 2);
      assert.equal(prev.a.points.atk, undefined, '不能動到輸入');
    });
  }

  // ───────────────────────── decide：六條規則每一條一項
  {
    const { pick, deathRiskFor } = require(path.join(root, 'decide'));
    const opt = (id, name, check = null, chance = null) => ({ id, name, check, chance });
    ok('decide：① 致死率跟著自己多強走——危險區看 deathsBelow/nBelow，不是全域平均', () => {
      const r = { n: 100, deaths: 5, deathPowerMax: 222000, nBelow: 10, deathsBelow: 5 };
      assert.equal(deathRiskFor(r, 100000).rate, 0.5);
      assert.equal(deathRiskFor(r, 100000).zone, 'danger');
      assert.equal(deathRiskFor(r, 999999).rate, 0.05);
      assert.equal(deathRiskFor(r, 999999).zone, 'above-record');
      // 同一個選項：弱的被擋、強的放行
      const opts = [opt('snipe', '對狙'), opt('walk', '走開')];
      const stats = { snipe: { ...r, points: { int: 100 } }, walk: { n: 50, points: {} } };
      assert.equal(pick(opts, stats, { power: 100000 }).id, 'walk');
      assert.equal(pick(opts, stats, { power: 999999 }).id, 'snipe');
    });
    ok('decide：② 沒量過＋名字寫著要打＝不挑；全被擋就回 null 不硬選', () => {
      const opts = [opt('x_fight', '正面迎戰'), opt('y', '躲起來', 'agi', 80)];
      const r = pick(opts, {}, {});
      assert.equal(r.id, 'y');
      assert.equal(r.blocked[0].by, 'untried-fight');
      const all = pick([opt('x_fight', '正面迎戰')], {}, {});
      assert.equal(all.id, null); assert.equal(all.reason, 'all-blocked');
      // 關掉規則 ② 就會選
      assert.equal(pick([opt('x_fight', '正面迎戰')], {}, {}, { allowUntriedFights: true }).id, 'x_fight');
    });
    ok('decide：③ 害死過人的一律避開；解鎖只能略過開打率不能略過致死率', () => {
      const opts = [opt('u', '解鎖'), opt('w', '走開')];
      // 開打率 100% 但零死亡、有解鎖 → 放行
      assert.equal(pick(opts, { u: { n: 6, battles: 6, deaths: 0, unlocks: ['c'], points: { int: 6 } }, w: { n: 9, points: {} } }, {}).id, 'u');
      // 有死亡 → 擋，而且標成人工
      const r = pick(opts, { u: { n: 6, battles: 6, deaths: 3, unlocks: ['c'], points: { int: 6 } }, w: { n: 9, points: {} } }, {});
      assert.equal(r.id, 'w');
      assert.equal(r.manual.length, 1); assert.equal(r.manual[0].id, 'u'); assert.equal(r.manual[0].by, 'death');
    });
    ok('decide：④ 沒量過的期望值是 null 不是 0——已知全是 0 收益就去試沒量過的', () => {
      const opts = [opt('known', '問路'), opt('never', '摸摸看')];
      const r = pick(opts, { known: { n: 99, successes: 99, points: {} } }, {});
      assert.equal(r.id, 'never'); assert.equal(r.reason, 'try-unknown');
      // 一旦量到有收益，就挑期望值最高的
      const r2 = pick(opts, { known: { n: 99, points: {} }, never: { n: 1, points: { int: 1 } } }, {});
      assert.equal(r2.id, 'never'); assert.equal(r2.reason, 'best-ev');
    });
    ok('decide：⑤ 試錯挑樣本最少的，這一輪選過幾次只進排序、不進閘門', () => {
      const opts = [opt('a', 'A'), opt('b', 'B'), opt('c', 'C')];
      const stats = { a: { n: 89, points: {} } };
      const session = new Map();
      const first = pick(opts, stats, { sessionPicks: session }, { explore: true });
      assert.equal(first.reason, 'explore');
      session.set(first.id, 1);
      const second = pick(opts, stats, { sessionPicks: session }, { explore: true });
      assert.notEqual(second.id, first.id, '同一輪選過的要讓位給還沒選過的');
      // 這一輪選過 3 次不能把「開打率 = battles/n」稀釋掉：battles 2 / n 2 = 100% 仍然要擋
      const s2 = new Map([['f', 3]]);
      const r = pick([opt('f', 'F'), opt('g', 'G')], { f: { n: 2, battles: 2, points: { int: 5 } }, g: { n: 5, points: {} } }, { sessionPicks: s2 }, { explore: true });
      assert.equal(r.id, 'g');
    });
    ok('decide：⑥ 樞紐事件優先選這顆帳號還沒選過的，用帳號自己的紀錄', () => {
      const opts = [opt('n1', '看公告 A'), opt('n2', '看公告 B'), opt('n3', '看公告 C', 'int', 30)];
      const r = pick(opts, { n1: { n: 40, points: {} }, n2: { n: 40, points: {} } }, { myPicks: new Set(['n1']) }, { hubEvent: true });
      assert.equal(r.id, 'n2'); assert.equal(r.reason, 'hub-fresh');
      // 全選過了就退回一般規則
      const r2 = pick(opts, { n1: { n: 40, points: {} }, n2: { n: 40, points: {} } }, { myPicks: new Set(['n1', 'n2', 'n3']) }, { hubEvent: true });
      assert.notEqual(r2.reason, 'hub-fresh');
    });
    ok('decide：人指定的選項不過任何閘門；黑名單擋得住量過的', () => {
      const opts = [opt('bad', '對狙'), opt('ok', '走開')];
      assert.equal(pick(opts, { bad: { n: 9, deaths: 9, points: {} } }, {}, { forced: 'bad' }).id, 'bad');
      const r = pick(opts, { bad: { n: 9, points: { int: 9 } }, ok: { n: 9, points: {} } }, {}, { blacklist: new Set(['bad']) });
      assert.equal(r.id, 'ok'); assert.equal(r.blocked[0].by, 'blacklist');
    });
    ok('decide：有判定的不夠穩就走沒判定的；偏好某一維時挑那一維最高的', () => {
      const opts = [opt('g', '賭', 'int', 40), opt('s', '穩')];
      assert.equal(pick(opts, {}, {}).id, 's');
      const opts2 = [opt('i', '智', 'int', 90), opt('t', '技', 'tec', 90)];
      const stats = { i: { n: 10, points: { int: 10 } }, t: { n: 10, points: { tec: 10 } } };
      assert.equal(pick(opts2, stats, {}, { preferStat: 'tec' }).id, 't');
    });
  }

  // ───────────────────────── derived：縮水閘門與來源印章
  {
    const derived = require(path.join(root, 'derived'));
    ok('derived：縮水閘門擋總和變少、單列變少、整列消失', () => {
      const prev = { a: { n: 10, deaths: 3 }, b: { n: 5, deaths: 0 } };
      assert.deepEqual(derived.shrinkGate(prev, { a: { n: 12, deaths: 3 }, b: { n: 5, deaths: 0 } }), []);
      const p1 = derived.shrinkGate(prev, { a: { n: 12, deaths: 1 }, b: { n: 5 } });
      assert.ok(p1.some((m) => m.includes('deaths')), p1.join('\n'));
      const p2 = derived.shrinkGate(prev, { a: { n: 10, deaths: 3 } });
      assert.ok(p2.some((m) => m.includes('整筆消失')), p2.join('\n'));
      assert.deepEqual(derived.shrinkGate(null, {}), [], '第一次建表沒有舊表可比');
    });
    ok('derived：stamp 記相對路徑與 sha256，verify 在來源變了之後擋下來', () => {
      const src = path.join(tmp, 'src.jsonl');
      fs.writeFileSync(src, '{"a":1}\n');
      const doc = { source: derived.stamp(src, tmp) };
      assert.equal(doc.source.file, 'src.jsonl');
      assert.deepEqual(derived.verify(doc, tmp), []);
      fs.writeFileSync(src, '{"a":2}\n');
      const problems = derived.verify(doc, tmp);
      assert.equal(problems.length, 1);
      assert.ok(problems[0].includes('src.jsonl'));
      // 來源不在磁碟上（只留了雜湊）不算失敗
      assert.deepEqual(derived.verify({ sources: { har: { file: 'nope.har', sha256: 'x' } } }, tmp), []);
    });
  }

  // ───────────────────────── 整包
  ok('index：總入口把每一支都掛出來', () => {
    const lib = require(path.join(root, '.'));
    for (const k of ['cli', 'budget', 'jsonl', 'client', 'twISO', 'requireToken', 'runMain', 'redact']) {
      assert.ok(lib[k], `少了 ${k}`);
    }
  });
  ok('工具包沒有任何外部相依（只用 Node 內建模組）', () => {
    const builtin = new Set(require('module').builtinModules);
    for (const f of fs.readdirSync(path.join(root, '.')).filter(n => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(root, '.', f), 'utf8');
      for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
        const dep = m[1];
        if (dep.startsWith('.')) continue;
        assert.ok(builtin.has(dep) || builtin.has(dep.replace(/^node:/, '')), `${f} 依賴了外部套件 ${dep}`);
      }
    }
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  if (process.exitCode) { console.error(`\n有項目沒過（通過 ${pass} 項）`); return; }
  console.log(`\n${pass}/${pass} 通過`);
})();
