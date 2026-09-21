# polite-cli — 對付「有額度的 API」與自動遊玩文字遊戲的十個小模組

寫給一種很具體的情境：**你要寫一批命令列工具去打同一個 API，而那個 API 有每小時請求上限，
打爆了會被擋、打錯了會改到真實狀態。** 這個資料夾把那種工具每次都要重寫的事抽出來，加上自動遊玩一款文字遊戲時真正要守的規矩。

**拿到一款新的文字遊戲要從哪裡開始，看 [`PLAYBOOK.md`](PLAYBOOK.md)**：八個步驟、每一步用哪一支。

沒有任何外部相依（只用 Node 內建模組），一支一支獨立，複製整個資料夾就能用。
授權 MIT，見 `LICENSE`。

```js
const { cli, client, jsonl, twISO, requireToken, runMain } = require('./lib');

const args = cli();
const out   = args.str('out', 'run.jsonl');
const perHr = args.num('rph', 550);
args.done();                      // 打錯的參數在這裡就停，不會安靜地用預設值跑掉

const api = client({ base: 'https://example.com', token: requireToken(), perHour: perHr });
const rec = jsonl.writer(out);

runMain(async () => {
  const r = await api.get('/api/state');
  if (!r.ok) return;
  rec.write({ at: twISO(), state: r.json });
});
```

## 十個模組

| 模組 | 管什麼 | 相依 |
| --- | --- | --- |
| [`cli.js`](cli.js) | `--key value`／`--key=value`／`--flag` 三種寫法；`str`／`num`／`list`／`flag`／`enum`；**`done()` 會把沒人讀過的參數當成打錯字並停機** | 無 |
| [`budget.js`](budget.js) | 滾動一小時的請求額度。`take()` 滿了會等、`tryTake()` 不等。給同一個檔案就能讓同帳號的多個行程共用一份帳本 | 無 |
| [`http.js`](http.js) | HTTP 客戶端：硬性超時、有界重試、**寫入預設不重送**、401 丟 `AuthError`、每一發先過額度、token 不進任何輸出。附 `runMain()` 把錯誤對應成結束碼 | `budget`、`token` |
| [`token.js`](token.js) | token 只從環境變數讀（`MD_TOKEN` 或 `MD_TOKEN_<帳號>`）。**發現 token 寫在命令列參數就當場停**。`redact()` 給印錯誤的地方用 | 無 |
| [`jsonl.js`](jsonl.js) | 一行一筆 JSON 的紀錄檔：`writer`／`read`／`stream`／`readDir`。壞掉的行只跳過那一行 | 無 |
| [`tw-time.js`](tw-time.js) | 帶 `+08:00` 偏移量的 ISO 8601 時間戳 | 無 |
| [`cooldown.js`](cooldown.js) | **從行動的回應算下一次什麼時候能動，不打狀態查詢**（那一發會把額度花掉兩倍）。讀不到冷卻就回 `fallbackMs` 並標 `observed: false`，不猜 | 無 |
| [`decide.js`](decide.js) | 事件選項怎麼選：期望值最高的，不是最穩的，但先過安全閘門。六條規則每一條後面都有一次真實的損失（致死率跟著你多強走、沒量過＋名字寫著要打＝不挑、沒量過的期望值是 null 不是 0……） | 無 |
| [`tally.js`](tally.js) | 把「選了什麼、結果如何」累成 `decide.js` 要吃的表。**存原始總計不存平均**；`merge()` 逐欄位取大，證據只增不減 | 無 |
| [`derived.js`](derived.js) | 衍生表的兩道閘門：`shrinkGate()` 擋用不齊的紀錄重跑把證據洗掉，`stamp()`／`verify()` 擋來源改了衍生表沒重跑 | 無 |

相依只有一條線：`http` → `budget`、`token`。其他八支彼此無關，單獨拿一支走也可以。
前六支是「有額度的 API」那一半，後四支是「自動遊玩」那一半；只要前一半的專案不必碰後一半。

## 四個不太明顯、但每一條都是踩過的設計

**1. 打錯的參數要停機，不要用預設值跑。**
`const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i+1] : d; }`
這一行在本專案被抄了 32 份。抄得一樣還算好，問題是它**不檢查參數有沒有打錯**：
`--stop-levl 100` 不會有任何錯誤訊息，那一項就是靜靜地用預設值跑。
所以 `args.done()` 存在——沒被任何一次 `str`/`num`/`list`/`flag` 讀走的參數，結束碼 2。

**2. 讀可以重試，寫不可以。**
`POST` 逾時不代表沒送到——伺服器可能已經把那一發算進去了，重送就是做了兩次。
所以 `get()` 預設重試兩次，`post()` 預設 `retries: 0`，要重送得自己寫出來。

**3. 重試也佔額度。**
上游算的是實際送出的請求數，不是成功幾發。所以額度閘門放在**送出那一層**，
不是放在呼叫端——呼叫端怎麼寫都不重要，送出去之前一定會先被擋下來。

**4. token 不能出現在命令列。**
`ps` 看得到，shell history 留得住，而日誌是會被貼出來的。
`requireToken()` 會先掃一遍 `process.argv`，看到像 JWT 的東西就停——
安靜地接受它的話，寫的人永遠不會知道自己把 token 留在哪裡了。

## 測試

```
node test/test.js
```

56 項，不連線、不碰任何真實 API。上面四條規矩每一條都有對應的測試守著。

## 拿去別的專案用

整個資料夾複製過去就行，沒有相依要裝。預設的環境變數字首是 `MD_TOKEN`，
要換就改 `token.js` 的 `envNameFor()` 一個地方。

這個倉庫是從 [mydoujinHelper](https://github.com/ArcGrove7/mydoujinHelper) 的 `tools/lib/` 整份複製出來的；那邊改了就整份再複製過來，不要兩邊各改各的。
