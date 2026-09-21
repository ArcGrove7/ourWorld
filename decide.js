// 事件選項怎麼選：期望值最高的，不是最穩的——但先過安全閘門。
//
// 這一支是整個工具包裡最貴的一支：裡面每一條規則都是用死掉的角色換來的。
// 跟遊戲脫鉤的做法是：**它不知道選項長什麼樣，只吃三樣東西**——
//   選項清單（`options`）、這個選項過去的統計（`stats`，由 tally.js 產生）、
//   以及「現在這隻角色多強」（`ctx.power`）。回傳要選哪一個與**為什麼**。
//
//   const { pick } = require('./decide');
//   const r = pick(event.options, stats, { power: atk * hp, level }, policy);
//   if (!r.id) { /* 全部被擋，停下來等人 */ }
//   log(r.why);
//
// 選項的形狀（自己從遊戲的回應對過來）：
//   { id, name, check: '要判定哪一維或 null', chance: 0~100（伺服器給的成功率，沒有就 null） }
// 統計的形狀（tally.js 的 `table()`）：
//   { n, successes, battles, deaths, deathPowerMax, nBelow, deathsBelow, points: {維: 累計}, unlocks: [] }
//
// 六條規則，每一條後面都有一次真實的損失：
//
// ① **致死率跟著「你有多強」走，不是選項的固定屬性。**
//    `deathPowerMax` 是這個選項害死過的最強的人；你在它以下就是危險區，看 `deathsBelow / nBelow`。
//    用全域平均會被高等樣本稀釋：某個選項全域 5%、危險區 50%，有人看著日誌上的「4%」一次歸零。
// ② **沒量過＋名字寫著要打＝不要挑。** 零樣本讓每一道資料閘門都放行（率都是 null），
//    黑名單只有死過人之後才長出那一條，所以第一個踩到的人永遠沒有保護。四次死亡形狀一模一樣。
// ③ **害死過人的一律避開，不管開打率多少。** 開打只是死亡的代理指標。解鎖角色的選項可以略過
//    開打率，但不能略過致死率。
// ④ **沒量過的期望值是 null，不是 0。** 已知的都是 0 收益時要去試沒量過的那個，
//    不然它永遠量不到（某個選項被選了 99 次、旁邊那個從來沒人碰過）。
// ⑤ **試錯挑樣本最少的，但「這一輪自己選過幾次」只進排序、不進閘門分母。**
//    統計是啟動時的快照，跑的過程中不會更新；不記這一輪的話同一個選項會被反覆選。
//    但把它加進 n 會稀釋開打率／致死率（只加分母不加分子）。
// ⑥ **樞紐事件另一套規則：優先選這顆帳號自己還沒選過的。** 那種事件的選項是各條線的入口／旗標，
//    幾乎全是 0 點，期望值邏輯永遠挑不到它們。旗標是帳號的，用帳號自己的紀錄算。

const DEFAULT_POLICY = {
  minChance: 60,           // 有判定的選項至少要這麼穩才賭
  maxBattleRate: 0.5,      // 開打率 ≥ 這個就避開（除非它解鎖角色）
  maxDeathRate: 0.1,       // 致死率（照 ① 算）≥ 這個就避開，解鎖也不例外
  blacklist: new Set(),    // 人寫的死亡黑名單（選項 id）
  // 「名字寫著要打」的判斷。換遊戲就換這兩個 RegExp；給 null 就關掉規則 ②。
  fightWords: /迎戰|迎擊|應戰|正面|硬碰|衝上去|撲上去|對狙|打倒|殺了|單挑|拔劍|開打/,
  fightIds: /_fight$|_head_on$|_charge$|_attack$|_duel$|_melee$|_snipe$/,
  allowUntriedFights: false,
  explore: false,          // 試錯模式：專挑樣本最少的
  exploreUntil: 3,         // 量到這麼多筆就不用再特地試
  hubEvent: false,         // 這個事件是樞紐（規則 ⑥）
  preferStat: null,        // 偏好某一維：同樣有得選時挑那一維期望值最高的
  avoidStats: [],          // 不要讓這幾維增加（軟性：全都有嫌疑時仍然會挑）
  forced: null,            // 人指定的選項 id：看到就選，不過任何閘門
};

// ① 這個選項對「現在這隻角色」的致死率。
function deathRiskFor(r, power) {
  if (!r || !r.n) return { rate: null, zone: 'unmeasured' };
  const base = r.deaths ? r.deaths / r.n : 0;
  if (r.deathPowerMax == null || power == null) return { rate: base, zone: 'global' };
  if (power <= r.deathPowerMax) {
    const below = r.nBelow ? (r.deathsBelow || 0) / r.nBelow : base;
    return { rate: below, zone: 'danger' };
  }
  // 比「害死過的最強的人」還強：這個區間一次都沒死過。不是保證安全，但拿危險區的數字擋它
  // 只會讓強角色白白放掉收益。
  return { rate: base, zone: 'above-record' };
}

// 期望值：每次成功平均拿幾點 × 成功率。沒量過就是 null（規則 ④）。
function expectedValue(r, chance, hasCheck) {
  if (!r || !r.n) return null;
  const total = Object.values(r.points || {}).reduce((a, b) => a + b, 0);
  const per = total / r.n;
  return per * (hasCheck ? chance / 100 : 1);
}

function statExpectedValue(r, chance, hasCheck, stat) {
  if (!stat || !r || !r.n || !r.points) return null;
  const got = r.points[stat];
  if (!got) return null;
  return (got / r.n) * (hasCheck ? chance / 100 : 1);
}

function pick(options, stats, ctx = {}, policy = {}) {
  const P = { ...DEFAULT_POLICY, ...policy };
  const all = Array.isArray(options) ? options : [];
  if (!all.length) return { id: null, why: '這個事件沒有選項', reason: 'no-options', blocked: [] };
  const S = stats || {};
  const power = typeof ctx.power === 'number' ? ctx.power : null;
  const sessionPicks = ctx.sessionPicks instanceof Map ? ctx.sessionPicks : new Map();
  const myPicks = ctx.myPicks instanceof Set ? ctx.myPicks : new Set();
  const name = (o) => o.name || o.id;
  const chanceOf = (o) => (o.check ? (typeof o.chance === 'number' ? o.chance : 0) : 100);

  // 人指定的優先於一切，不過閘門。
  if (P.forced) {
    const f = all.find((o) => o.id === P.forced);
    if (f) return { id: f.id, why: `人指定：一律選「${name(f)}」（安全閘門不適用）`, reason: 'forced', blocked: [] };
  }

  const untriedFight = (o) => {
    const r = S[o.id];
    if (r && r.n) return false;
    if (P.allowUntriedFights) return false;
    return !!((P.fightWords && P.fightWords.test(o.name || '')) || (P.fightIds && P.fightIds.test(o.id || '')));
  };
  const risky = (o) => {
    if (P.blacklist.has(o.id)) return 'blacklist';
    const r = S[o.id];
    if (!r || !r.n) return untriedFight(o) ? 'untried-fight' : null;
    if (r.deaths && (deathRiskFor(r, power).rate ?? 0) >= P.maxDeathRate) return 'death';
    if (r.unlocks && r.unlocks.length) return null;   // 解鎖只能略過開打率，不能略過死亡
    if (r.battles && r.battles / r.n >= P.maxBattleRate) return 'battle';
    return null;
  };
  const givesAvoided = (o) => {
    if (!P.avoidStats.length) return false;
    const r = S[o.id];
    if (!r || !r.n) return true;          // 沒量過的也算有嫌疑（軟性）
    if (!r.points) return false;
    return P.avoidStats.some((k) => (r.points[k] || 0) > 0);
  };

  const blocked = all.map((o) => ({ o, by: risky(o) })).filter((x) => x.by);
  const hardOk = all.filter((o) => !risky(o));
  const statOk = hardOk.filter((o) => !givesAvoided(o));
  const opts = statOk.length ? statOk : hardOk;
  const tag = blocked.length
    ? `（避開 ${blocked.length} 個：${blocked.map((x) => `「${name(x.o)}」`).join('、')}）` : '';
  // 被擋掉的裡面有解鎖角色的：那是人要自己決定的取捨，標出來。
  const manual = blocked
    .filter((x) => S[x.o.id] && (S[x.o.id].unlocks || []).length)
    .map((x) => ({ id: x.o.id, name: name(x.o), by: x.by, risk: deathRiskFor(S[x.o.id], power) }));

  if (!opts.length) {
    return { id: null, why: '所有選項都被安全規則擋住；停下來等人決定', reason: 'all-blocked', blocked, manual };
  }

  const scored = opts.map((o) => ({ o, chance: chanceOf(o) }));
  const pct = (x) => (x.o.check ? `${x.chance}%` : '無判定');

  // ⑥ 樞紐事件
  if (P.hubEvent) {
    const fresh = scored.filter((x) => !myPicks.has(x.o.id) && !(sessionPicks.get(x.o.id) > 0));
    if (fresh.length) {
      const sorted = fresh.slice().sort((a, b) => b.chance - a.chance);
      const hit = sorted.find((x) => !x.o.check) || sorted.find((x) => x.chance >= P.minChance);
      if (hit) {
        return { id: hit.o.id, why: `樞紐事件：這顆帳號還沒選過的「${name(hit.o)}」（${pct(hit)}；還有 ${fresh.length - 1} 個沒選過）${tag}`, reason: 'hub-fresh', blocked, manual };
      }
    }
  }

  const withCheck = scored.filter((x) => x.o.check).sort((a, b) => b.chance - a.chance);
  const noCheck = scored.filter((x) => !x.o.check);
  // 有東西被擋掉時優先走沒判定的——那種事件擺明會開打
  if (blocked.length && noCheck.length) {
    const last = noCheck[noCheck.length - 1];
    return { id: last.o.id, why: `沒有判定的選項${tag}`, reason: 'safe-after-block', blocked, manual };
  }
  const viable = scored.filter((x) => x.chance >= P.minChance);

  // ⑤ 試錯
  if (P.explore && viable.length) {
    const n = (o) => ((S[o.id] || {}).n || 0) + (sessionPicks.get(o.id) || 0);
    const sorted = viable.slice().sort((a, b) => (n(a.o) - n(b.o)) || (b.chance - a.chance));
    const c = sorted[0];
    if (n(c.o) < P.exploreUntil) {
      const seen = n(c.o);
      const mine = sessionPicks.get(c.o.id) || 0;
      const how = seen === 0 ? '從沒選過' : `只有 ${seen} 筆${mine ? `（其中這一輪 ${mine} 次）` : ''}`;
      return { id: c.o.id, why: `試錯：樣本最少的（${how}、${pct(c)}）${tag}`, reason: 'explore', blocked, manual };
    }
  }

  // 偏好某一維
  if (P.preferStat && viable.length) {
    const w = viable
      .map((x) => ({ ...x, sev: statExpectedValue(S[x.o.id], x.chance, !!x.o.check, P.preferStat) }))
      .filter((x) => x.sev != null && x.sev > 0)
      .sort((a, b) => b.sev - a.sev);
    if (w.length) {
      const b = w[0];
      return { id: b.o.id, why: `偏好 ${P.preferStat}：每次約 +${b.sev.toFixed(2)}（${pct(b)}）${tag}`, reason: 'prefer-stat', blocked, manual };
    }
  }

  // ④ 期望值最高；已知全是 0 就試沒量過的
  if (viable.length) {
    const ev = viable.map((x) => ({ ...x, ev: expectedValue(S[x.o.id], x.chance, !!x.o.check) }));
    const valued = ev.filter((x) => x.ev != null).sort((a, b) => b.ev - a.ev);
    const unknown = ev.filter((x) => x.ev == null).sort((a, b) => b.chance - a.chance);
    if (valued.length && valued[0].ev > 0) {
      const b = valued[0];
      return { id: b.o.id, why: `期望值最高 ${b.ev.toFixed(2)} 點（${pct(b)}）${tag}`, reason: 'best-ev', blocked, manual };
    }
    if (unknown.length) {
      const u = unknown[0];
      return { id: u.o.id, why: `已知的都是 0 收益，改試沒量過的（${pct(u)}）${tag}`, reason: 'try-unknown', blocked, manual };
    }
  }

  // 後備：夠穩就賭，不夠穩走沒判定的，真的沒得選才硬上最高的
  if (withCheck.length && withCheck[0].chance >= P.minChance) {
    const b = withCheck[0];
    return { id: b.o.id, why: `賭 ${b.o.check} 判定，${b.chance}% ≥ ${P.minChance}%${tag}`, reason: 'gamble', blocked, manual };
  }
  if (noCheck.length) {
    const b = noCheck[noCheck.length - 1];
    const note = withCheck.length ? `最穩的判定只有 ${withCheck[0].chance}% < ${P.minChance}%，改走沒判定的` : '沒有判定的選項';
    return { id: b.o.id, why: note + tag, reason: 'safe', blocked, manual };
  }
  const b = withCheck[0];
  return { id: b.o.id, why: `每個選項都要判定，挑最高的 ${b.chance}%${tag}`, reason: 'least-bad', blocked, manual };
}

module.exports = { pick, deathRiskFor, expectedValue, statExpectedValue, DEFAULT_POLICY };
