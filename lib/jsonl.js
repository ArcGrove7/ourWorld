// JSONL 紀錄檔：一行一筆 JSON。這個專案所有實測紀錄都是這個格式。
//
//   const jsonl = require('./lib/jsonl');
//   const w = jsonl.writer('logs/run/arcgrove.jsonl');
//   w.write({ kind: 'action', at: twISO(), ... });
//   for (const rec of jsonl.read('logs/run/arcgrove.jsonl')) { ... }
//   for await (const rec of jsonl.stream(file)) { ... }     // 大檔用這個，不要整份讀進記憶體
//
// 為什麼是 JSONL 不是 JSON 陣列：產線是一直在跑的，而 JSON 陣列要等到寫完 `]` 才是合法檔案。
// 行程被砍掉（這個容器會照回合回收行程）的時候，JSONL 頂多是最後一行不完整，前面全部還讀得到。
// 所以 `read()` **預設會跳過讀不動的行**並回報跳了幾行，而不是整份拋錯——
// 為了最後半行而丟掉前面幾萬筆紀錄是最糟的處理方式。
//
// 大小注意：這個專案的紀錄動輒幾 MB 到幾十 MB，`read()` 會整份進記憶體。
// 只是要掃一遍就用 `stream()`。

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function writer(file, { append = true } = {}) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  if (!append) fs.writeFileSync(file, '');
  let n = 0;
  return {
    file,
    write(rec) { fs.appendFileSync(file, JSON.stringify(rec) + '\n'); n++; return n; },
    count() { return n; },
  };
}

// 整份讀進來。onBadLine 收到 (行號, 原文, 錯誤)；不給就安靜跳過
function read(file, { onBadLine = null } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); }
    catch (e) { if (onBadLine) onBadLine(i + 1, line, e); }
  }
  return out;
}

// 一行一行來，不整份進記憶體
async function* stream(file, { onBadLine = null } = {}) {
  let rl;
  try { rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity }); }
  catch { return; }
  let i = 0;
  for await (const raw of rl) {
    i++;
    const line = raw.trim();
    if (!line) continue;
    try { yield JSON.parse(line); }
    catch (e) { if (onBadLine) onBadLine(i, line, e); }
  }
}

// 一個資料夾底下所有 .jsonl 一起讀（產線是一顆帳號一個檔）
function readDir(dir, opts) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.filter(n => n.endsWith('.jsonl')).sort()) {
    out.push(...read(path.join(dir, name), opts));
  }
  return out;
}

module.exports = { writer, read, stream, readDir };
