// 衍生表的兩道閘門：縮水閘門與來源印章。
//
// 原始紀錄（jsonl）是證據，衍生表（收益表、成長矩陣、路線圖）是從證據算出來的。
// 兩件事最常出錯：
//
// **① 用不齊的紀錄重跑，把證據洗掉。** 原始紀錄常常不進版控（太大、或含別人的資料），
// 容器換掉就沒了；在新機器上重跑衍生表，讀到的只有一小部分紀錄，寫下去就是把
// 「害死過三個人的選項」變成「4 次 0 死、看起來完全安全」。`shrinkGate()` 擋這件事：
// 總樣本、死亡數、任何只增不減的計數只要變少就拒寫。看到它擋就是紀錄不齊，
// 去補紀錄，不要用 `allowShrink` 硬推。
//
// **② 來源改了、衍生表沒重跑。** 檔案還在、格式還對、讀得出來，只是數字是上一版的。
// `stamp()` 把來源的 sha256 寫進產出檔，`verify()` 重新算一次對不對得上。
//
//   const { shrinkGate, stamp, verify } = require('./derived');
//   const bad = shrinkGate(prevTable, nextTable, { counters: ['n', 'deaths'] });
//   if (bad.length) { console.error(bad.join('\n')); process.exit(3); }
//   out.source = stamp('logs/data/raw.jsonl');
//   const problems = verify(out);      // [] 表示同步

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// prev／next 是「id → 列」的表。counters 是每一列裡只增不減的欄位。
// 另外也擋「整列消失」與「總列數變少」。回傳問題清單，空陣列表示沒縮水。
function shrinkGate(prev, next, opts = {}) {
  const counters = opts.counters || ['n', 'deaths'];
  const label = opts.label || '衍生表';
  const problems = [];
  if (!prev) return problems;
  const pIds = Object.keys(prev);
  const nIds = new Set(Object.keys(next || {}));
  const gone = pIds.filter((id) => !nIds.has(id));
  if (gone.length) problems.push(`${label}：${gone.length} 列整筆消失（例：${gone.slice(0, 3).join('、')}）`);
  for (const f of counters) {
    const before = pIds.reduce((s, id) => s + (prev[id][f] || 0), 0);
    const after = [...nIds].reduce((s, id) => s + ((next[id] || {})[f] || 0), 0);
    if (after < before) problems.push(`${label}：${f} 總和 ${before} → ${after}，變少了`);
    for (const id of pIds) {
      if (!nIds.has(id)) continue;
      const a = prev[id][f] || 0;
      const b = (next[id] || {})[f] || 0;
      if (b < a) problems.push(`${label}：${id} 的 ${f} ${a} → ${b}`);
    }
  }
  return problems;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 給產出檔用的來源印章。`file` 寫相對於 repo 根的路徑，這樣換機器也對得上。
function stamp(file, root = process.cwd()) {
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  return { file: path.relative(root, abs).split(path.sep).join('/'), sha256: sha256(abs) };
}

// 讀產出檔裡的 `source`（單筆）或 `sources`（多筆），重新算來源的 sha256。
// 來源不在磁碟上（只留了雜湊的 HAR、bundle）就跳過，不算失敗。回傳問題清單。
function verify(doc, root = process.cwd()) {
  const refs = [];
  const push = (o) => { if (o && typeof o.file === 'string' && typeof o.sha256 === 'string') refs.push(o); };
  push(doc && doc.source);
  if (doc && doc.sources && typeof doc.sources === 'object') for (const v of Object.values(doc.sources)) push(v);
  const problems = [];
  for (const ref of refs) {
    const abs = path.join(root, ref.file);
    if (!fs.existsSync(abs)) continue;
    const now = sha256(abs);
    if (now !== ref.sha256) problems.push(`來源 ${ref.file} 的 sha256 已經不一樣（記著 ${ref.sha256.slice(0, 12)}…，現在 ${now.slice(0, 12)}…）：來源改過，衍生表沒重跑`);
  }
  return problems;
}

module.exports = { shrinkGate, stamp, verify, sha256 };
