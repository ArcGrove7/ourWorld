// Token 只從環境變數讀，而且要能證明它沒有從別的地方進來。
//
//   const { tokenFor, requireToken, redact } = require('./lib/token');
//   const tok = requireToken();              // MD_TOKEN
//   const tok = requireToken('arcgrove7');   // MD_TOKEN_ARCGROVE7，沒有就退回 MD_TOKEN
//   redact(errorText)                        // 把看起來像 JWT 的字串換成 <redacted>
//
// 規矩（這個 repo 一直都這樣，這支只是把它變成擋得住的程式碼）：
// - **token 不寫進檔案、不寫進參數、不進輸出。** 寫進參數的話 `ps` 看得到、shell history 留得住，
//   而這個專案的日誌是會被貼出來給人看的。
// - 所以 `requireToken()` 會**先掃一遍 process.argv**：只要有哪個參數長得像 JWT 就當場停。
//   那比「安靜地接受它」好——安靜接受的話，寫的人永遠不知道自己把 token 留在 shell history 裡了。
// - `redact()` 給所有會印錯誤的地方用。第三方的錯誤訊息有時候會把整個 request header 回吐出來。

const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.?[A-Za-z0-9_-]*/g;

// 帳號名 -> 環境變數名。arcgrove7 -> MD_TOKEN_ARCGROVE7
function envNameFor(account) {
  return 'MD_TOKEN_' + String(account).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function tokenFor(account, env = process.env) {
  if (account) {
    const named = env[envNameFor(account)];
    if (named) return named;
  }
  return env.MD_TOKEN || null;
}

function requireToken(account, { env = process.env, argv = process.argv } = {}) {
  const leaked = argv.filter(a => JWT_LIKE.test(a));
  JWT_LIKE.lastIndex = 0;
  if (leaked.length) {
    console.error('參數裡出現了看起來像 token 的東西。token 只能從環境變數帶，不能寫在命令列'
      + '（`ps` 看得到、shell history 留得住）。停。');
    process.exit(3);
  }
  const tok = tokenFor(account, env);
  if (!tok) {
    const want = account ? `${envNameFor(account)} 或 MD_TOKEN` : 'MD_TOKEN';
    console.error(`缺 ${want} 環境變數（token 只從環境變數讀）`);
    process.exit(3);
  }
  return tok;
}

function redact(text) {
  if (text == null) return text;
  return String(text).replace(JWT_LIKE, '<redacted>');
}

module.exports = { tokenFor, requireToken, envNameFor, redact };
