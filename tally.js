// 選項統計：把「選了什麼、結果如何」的原始紀錄累成 decide.js 要吃的表。
//
// 兩條規矩，都是被藏起來的分母坑過才立的：
//
// **一律存原始總計，不存平均。** 表上寫 `points: { int: 227 }` 就是「累計拿了 227 點」，
// 不是「每次 227 點」。平均值把分母藏起來，讀的人分不出「量過 10 次」與「量過 1 次」；
// 要平均自己除，而且**正的除以成功次數、負的有判定除以失敗次數、無判定除以樣本數**——
// 混著除會把「失敗扣 10」算成「每次扣 3.3」，看起來像可以接受的成本。
//
// **證據只增不減。** `merge()` 逐欄位取大，不是整筆取代：整筆取代會把「只有舊那一列才有的事實」
// 丟掉（舊列 1 次失敗 HP −10、新列 1 次成功 攻 +1，樣本數一樣多，舊列被換掉，
// 「沒過判定就扣血」的唯一證據就此消失）。取大之後每個數字都是**下限**，寧可少算也不弄丟。
//
//   const { Tally } = require('./tally');
//   const t = new Tally();
//   t.add({ optionId, success, battle, died, power, points: { int: 1 }, unlocks: ['x'] });
//   const table = t.table();            // decide.js 的 stats
//   Tally.merge(prevTable, table);      // 逐欄位取大

class Tally {
  constructor() {
    this.rows = new Map();
  }

  row(id) {
    if (!this.rows.has(id)) {
      this.rows.set(id, { n: 0, successes: 0, battles: 0, deaths: 0, deathPowerMax: null, nBelow: 0, deathsBelow: 0, points: {}, unlocks: [] });
    }
    return this.rows.get(id);
  }

  // rec：{ optionId, success?, battle?, died?, power?, points?: {維: 數}, unlocks?: [] }
  add(rec) {
    if (!rec || !rec.optionId) throw new TypeError('add() 要有 optionId');
    const r = this.row(rec.optionId);
    r.n += 1;
    if (rec.success) r.successes += 1;
    if (rec.battle) r.battles += 1;
    if (rec.died) {
      r.deaths += 1;
      // 「害死過的最強的人」：decide.js 的危險區門檻
      if (typeof rec.power === 'number' && (r.deathPowerMax == null || rec.power > r.deathPowerMax)) r.deathPowerMax = rec.power;
    }
    for (const [k, v] of Object.entries(rec.points || {})) {
      if (typeof v === 'number' && v !== 0) r.points[k] = (r.points[k] || 0) + v;
    }
    for (const u of rec.unlocks || []) if (!r.unlocks.includes(u)) r.unlocks.push(u);
    return this;
  }

  // 危險區的分母與分子要在知道 deathPowerMax 之後才算得出來，所以放在收尾，
  // 要拿到「每一筆的強度」才算得了：把原始紀錄再餵一次。
  static dangerZone(rows, recs) {
    for (const rec of recs) {
      const r = rows[rec.optionId];
      if (!r || r.deathPowerMax == null || typeof rec.power !== 'number') continue;
      if (rec.power <= r.deathPowerMax) {
        r.nBelow += 1;
        if (rec.died) r.deathsBelow += 1;
      }
    }
    return rows;
  }

  table(recs) {
    const out = {};
    for (const [id, r] of this.rows) out[id] = { ...r, points: { ...r.points }, unlocks: [...r.unlocks] };
    return recs ? Tally.dangerZone(out, recs) : out;
  }

  // 逐欄位取大。回傳新表，不動輸入。
  static merge(prev, next) {
    const out = {};
    const ids = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
    const big = (a, b) => (Math.abs(b || 0) > Math.abs(a || 0) ? b : a);
    for (const id of ids) {
      const a = (prev && prev[id]) || {};
      const b = (next && next[id]) || {};
      const r = { n: 0, successes: 0, battles: 0, deaths: 0, deathPowerMax: null, nBelow: 0, deathsBelow: 0, points: {}, unlocks: [] };
      for (const f of ['n', 'successes', 'battles', 'deaths', 'nBelow', 'deathsBelow']) r[f] = Math.max(a[f] || 0, b[f] || 0);
      r.deathPowerMax = [a.deathPowerMax, b.deathPowerMax].filter((v) => v != null).reduce((m, v) => (m == null || v > m ? v : m), null);
      for (const k of new Set([...Object.keys(a.points || {}), ...Object.keys(b.points || {})])) {
        r.points[k] = big((a.points || {})[k], (b.points || {})[k]);
      }
      r.unlocks = [...new Set([...(a.unlocks || []), ...(b.unlocks || [])])];
      out[id] = r;
    }
    return out;
  }
}

module.exports = { Tally };
