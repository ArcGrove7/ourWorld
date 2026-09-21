# polite-cli — ten small modules for rate-limited APIs and for auto-playing text games

English edition. The Traditional Chinese [`README.md`](README.md) is the original; when the two disagree, the Chinese one wins.

Written for one very specific situation: **you are writing a batch of command-line tools that hit the same API, that API has an hourly request cap, exceeding it gets you blocked, and a wrong call changes real state.** This folder pulls out the parts such tools rewrite every time, plus the rules that actually matter when a program plays a text game on its own.

**Starting on a new text game? Read [`PLAYBOOK.md`](PLAYBOOK.md)** (Traditional Chinese): eight steps, and which module each step uses. A condensed English version is at the end of this file.

No external dependencies (Node built-ins only), every module stands alone, copy the folder and go. MIT licensed, see `LICENSE`.

```js
const { cli, client, jsonl, twISO, requireToken, runMain } = require('./lib');

const args = cli();
const out   = args.str('out', 'run.jsonl');
const perHr = args.num('rph', 550);
args.done();                      // a mistyped flag stops here instead of silently running on defaults

const api = client({ base: 'https://example.com', token: requireToken(), perHour: perHr });
const rec = jsonl.writer(out);

runMain(async () => {
  const r = await api.get('/api/state');
  if (!r.ok) return;
  rec.write({ at: twISO(), state: r.json });
});
```

## The ten modules

| Module | What it does | Depends on |
| --- | --- | --- |
| `cli.js` | `--key value` / `--key=value` / `--flag`; `str` / `num` / `list` / `flag` / `enum`; **`done()` treats any flag nobody read as a typo and exits** | — |
| `budget.js` | Rolling one-hour request budget. `take()` waits when full, `tryTake()` does not. Point several processes at the same file and they share one ledger per account | — |
| `http.js` | HTTP client: hard timeout, bounded retries, **writes are never retried by default**, 401 throws `AuthError`, every request passes the budget first, the token never appears in any output. `runMain()` maps errors to exit codes | `budget`, `token` |
| `token.js` | Reads the token from environment variables only (`MD_TOKEN` or `MD_TOKEN_<ACCOUNT>`). **Stops on the spot if a token shows up in argv.** `redact()` for error output | — |
| `jsonl.js` | One JSON record per line: `writer` / `read` / `stream` / `readDir`. A broken line skips only that line | — |
| `tw-time.js` | ISO 8601 timestamps with an explicit `+08:00` offset (change one constant for another zone) | — |
| `cooldown.js` | **Computes when the next action is allowed from the action response itself, instead of polling a status endpoint** (that extra call doubles your budget use). Returns `fallbackMs` with `observed: false` when nothing usable is in the response; it does not fill in a number on its own | — |
| `decide.js` | Picks an event option: highest expected value, not the safest, but only after the safety gates. Six rules, each one paid for by a real loss (death rate follows how strong *you* are; untried + a name that says "fight" = skip; an unmeasured option's EV is `null`, not 0, …) | — |
| `tally.js` | Turns "what was picked, what happened" records into the table `decide.js` consumes. **Stores raw totals, never averages**; `merge()` takes the field-wise maximum so evidence only grows | — |
| `derived.js` | Two gates for generated tables: `shrinkGate()` refuses a rebuild that would shrink the evidence (incomplete source records), `stamp()` / `verify()` catch "source changed, table not regenerated" | — |

The only dependency edge is `http` → `budget`, `token`. The other eight are independent; take a single file if that is all you need.
The first six are the "rate-limited API" half, the last four the "auto-play" half; a project that only needs the first half never has to touch the second.

## Four rules that are not obvious, and each of which cost something once

**1. A mistyped flag must stop the program, not run on a default.**
`const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i+1] : d; }`
This one-liner had been copied 32 times in the original project. Copying is fine; the problem is that it **never checks whether a flag was spelled right**: `--stop-levl 100` produces no message at all, that option quietly runs on its default. Hence `args.done()`: any flag not consumed by a `str` / `num` / `list` / `flag` call is exit code 2.

**2. Reads may retry, writes may not.**
A `POST` that times out has not necessarily failed; the server may already have counted it, and resending means doing it twice. So `get()` retries twice by default and `post()` has `retries: 0`; if you want a resend you write it out explicitly.

**3. Retries count against the budget too.**
The server counts requests actually sent, not requests that succeeded. So the budget gate lives in the **send layer**, not in the caller; however the caller is written, nothing leaves without passing it.

**4. A token must never appear on the command line.**
`ps` shows it, shell history keeps it, and logs get pasted. `requireToken()` scans `process.argv` first and stops when it sees something shaped like a JWT; accepting it silently means the author never learns where the token leaked.

## Tests

Standalone repository (ourWorld layout): `node test/test.js`.
Inside mydoujinHelper: `node tools/harness/test-lib.js` (same tests plus two repository-specific gates).

Nothing connects to a network or touches a real API. Each of the four rules above has a test guarding it.

## Using it elsewhere

Copy the folder; there is nothing to install. The default environment-variable prefix is `MD_TOKEN`; change `envNameFor()` in `token.js` to rename it, and the offset constant in `tw-time.js` for another time zone.

## Where the code lives

The modules are developed in the private [mydoujinHelper](https://github.com/ArcGrove7/mydoujinHelper) repository under `tools/lib/` and mirrored to [ourWorld](https://github.com/ArcGrove7/ourWorld) by `node tools/sync-ourworld.js <path-to-ourWorld>`. In ourWorld the modules sit in `lib/`, the documents at the root and the tests in `test/`. Do not edit the mirror by hand; change `tools/lib/` and run the sync.

## The playbook in brief

The full text is [`PLAYBOOK.md`](PLAYBOOK.md). The whole method in one sentence: **first measure the game as a rate-limited API, then let the program decide from the measured numbers.** Not from character lore, not from in-game flavour text, not from "everyone says".

| Step | Do | Module |
| --- | --- | --- |
| 0 | Answer three questions before automating anything: how many requests per hour, which operations are irreversible (those stay off by default and need an explicit order), and can a timed-out write have succeeded (yes, so never auto-resend writes) | `budget.js`, `http.js` |
| 1 | Find the API and the front-end bundle: record ten minutes of play as a HAR, locate `index-<hash>.js`, and for every rule you cite keep the HAR entry or bundle byte range plus the file's sha256. Rules without a source do not go into the mechanics document. Tokens come from environment variables only | `token.js` |
| 2 | List actions and cooldowns: send each action once, note what the response carries, and compute the next allowed time from that response rather than polling. Send two in a row to learn the server's "on cooldown" error, so the line can tell it from a real failure | `cooldown.js` |
| 3 | Events and options: record first with the most conservative policy (event id, every option's id / name / check / server-given success chance, what you picked, what happened, and how strong you were at the time), append-only. Then build the stats table from raw totals, and only then hand decisions to the picker. When every option is blocked, stop and wait for a person | `jsonl.js`, `tally.js`, `decide.js` |
| 4 | Measure growth with clean samples only: one variable at a time (one action per level, one level per sample, one run). Look for an invariant; once you have one, any cell that breaks it is a measurement error or a silent server change. Compare "what the server said it gave" with "what actually changed" on every review | (method, not a module) |
| 5 | Parse battle logs hit by hit: group by event type, regress each against both sides' stats. "Not detected" is not "does not exist" when the game's own text says otherwise | (method) |
| 6 | Safety gates and the death blacklist: generate the blacklist from records, never by hand; "it was fine before" means the earlier player was stronger, not that the option is safer; deaths only ever increase, a rebuild that shows fewer is missing records | `derived.js` |
| 7 | Multi-account lines and a watchdog: one process per account, budget per account, an idempotent watchdog every two minutes, and background processes die with the session, so use whatever background mechanism your environment actually tracks, then come back and check the log timestamps | `budget.js` |
| 8 | Raw records are append-only evidence; every derived table is generated, stamped with its sources, verified in CI, and refuses to shrink | `derived.js` |
