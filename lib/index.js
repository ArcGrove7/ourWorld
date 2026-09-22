// 工具包的總入口。單獨拿某一支也可以：require('./lib/cli') 等等。
//
//   const { cli, client, budget, jsonl, twISO, requireToken, runMain } = require('./lib');
//   const { Cooldown, decide, Tally, derived } = require('./lib');   // 自動遊玩那一半
//
// 每一支都只用 Node 內建模組，沒有任何外部相依，複製整個資料夾到別的專案就能用。
const cli = require('./cli');
const budget = require('./budget');
const jsonl = require('./jsonl');
const twTime = require('./tw-time');
const token = require('./token');
const http = require('./http');
const cooldown = require('./cooldown');
const decide = require('./decide');
const tally = require('./tally');
const derived = require('./derived');
const account = require('./account');

module.exports = {
  cli,
  budget,
  jsonl,
  ...twTime,
  ...token,
  ...http,
  ...cooldown,
  decide,
  ...tally,
  derived,
  ...account,
};
