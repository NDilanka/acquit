---
name: verify-acquit
description: Verify Acquit's local web UI with a headless browser and its control CLI. Use after changes to seeded sign-in, job posting, bids, cancellation, or PayPal sandbox escrow.
---

# Verify Acquit

Read [the feature map](features/README.md) before choosing a drive. This skill verifies the built Post, Bid, and Accept flows. It does not claim the tutorial's delivery, verifier, payout, or GitHub flows work.

## Hard rules

- Run from `D:\dev\Apps\unnamed` with Node 24 and PowerShell 7.
- Set `DATABASE_PATH=./data/verify/acquit.db` for every control CLI call. Never seed or reset `data/acquit.db`. That file contains user data.
- Keep API port `4310` and web port `5173`. The API allows only the web origin on `5173`.
- Refuse an existing run or occupied ports. The CLI ownership file and ports are shared. Two verification runs cannot run side by side.
- Use the bundled `agent-browser` CLI with the headless session and namespace `verify-acquit`. Never use `--cdp`, `--auto-connect`, a saved user profile, or the user's desktop pane.
- Never print environment values, session tokens, cookie values, or buyer credentials. Capture `login --save` output in memory. Do not copy session files into evidence.
- Use real sandbox checkout. Do not stub PayPal, call command APIs to perform the feature, or set app state internally.

## Launch

Dependencies must already be installed. The root `.env` needs the PayPal sandbox keys named in `README.md`. Do not display that file.

Run this preflight. A failure is a stop, not permission to kill an existing instance.

```powershell
Set-Location 'D:\dev\Apps\unnamed'
$env:DATABASE_PATH='./data/verify/acquit.db'
$env:PORT='4310'
$env:WEB_PORT='5173'
$status = node packages/ctl/src/main.ts status | ConvertFrom-Json
if (!$status.ok -or $status.data.run -or $status.data.ports.api.open -or $status.data.ports.web.open) { throw 'Refuse a shared or occupied instance.' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$evidence = "data/evidence/verify-acquit/$stamp"
New-Item -ItemType Directory -Path $evidence -ErrorAction Stop | Out-Null
Write-Output $stamp
```

Use the printed stamp in every later command. Shell variables do not survive separate Droid Execute calls. Replace `RUN_STAMP` below with that value.

Run this command through Droid Execute with `fireAndForget:true`. Do not launch through a foreground Execute call. On Windows that call can terminate the detached app when it exits.

```powershell
Set-Location 'D:\dev\Apps\unnamed'
$env:DATABASE_PATH='./data/verify/acquit.db'
$env:PORT='4310'
$env:WEB_PORT='5173'
node packages/ctl/src/main.ts start --timeout 60 | Tee-Object -FilePath 'data/evidence/verify-acquit/RUN_STAMP/launch.json'
```

Note the background PID and log path. Wait, then read `launch.json`. Require `ok:true`, `alreadyRunning:false`, the verification database path, and the expected URLs. The CLI reports ready only after both endpoints answer.

Inspect the proposed reset, then reset only this run's verification database. Seeding invalidates all development sessions. Log in only after seeding.

```powershell
Set-Location 'D:\dev\Apps\unnamed'
$env:DATABASE_PATH='./data/verify/acquit.db'
$env:PORT='4310'
$env:WEB_PORT='5173'
node packages/ctl/src/main.ts seed-db --dry-run
node packages/ctl/src/main.ts seed-db --yes
```

Require the dry-run's `databasePath` to end with `data\verify\acquit.db`. `--dry-run` reads counts and skips the reset and seed subprocess. It is not a funding dry-run. Real `Accept` creates a sandbox order.

## Doctor

Run this read-only check before driving and whenever anything looks wrong.

```powershell
Set-Location 'D:\dev\Apps\unnamed'
$env:DATABASE_PATH='./data/verify/acquit.db'
node .factory/skills/verify-acquit/scripts/fund-escrow.mjs doctor RUN_STAMP
```

Require `healthy:true`. The helper compares both live PIDs to `launch.json`, checks ports and the database path, and requires seeded data and configured key names. It refuses changed ownership. The drive also verifies authenticated API reads after CLI login.

## Drive

Run feature 04 through the reusable helper.

```powershell
Set-Location 'D:\dev\Apps\unnamed'
$env:DATABASE_PATH='./data/verify/acquit.db'
node .factory/skills/verify-acquit/scripts/fund-escrow.mjs drive RUN_STAMP
```

The helper signs in through the picker as `maya-client`. It posts issue `#12` for `400` USD and seven days. It switches to `devon-ops`, bids `400` USD with `ts-bugfixer` and an ETA of two days, then switches back. It chooses Devon's `Accept` button and confirms `Accept and pay with PayPal`.

Require `passed:true` in `summary.json`. The browser must redirect to `https://www.sandbox.paypal.com/checkoutnow`. API reads must show an `OPEN` job in `FUNDING`. Read-only stored funding checks must show `AWAITING_APPROVAL`, total `42000`, platform fee `4485`, operator net `36000`, and a matching Devon payee. The helper compares the payee in process and saves only a boolean. `JobView` does not expose the fee quote or checkout substate.

The helper stops at checkout and leaves the browser open for the optional step below. On a failed drive, it attempts cleanup and saves a failed summary. Run Cleanup yourself after every failed attempt too.

For other features, use the exact commands in their map files. Before manual browser commands, remove inherited browser attachment settings in that Execute call.

```powershell
Get-ChildItem Env:AGENT_BROWSER_* | Remove-Item
Remove-Item Env:FACTORY_DESKTOP_CDP_PORT -ErrorAction SilentlyContinue
$env:AGENT_BROWSER_HEADED='false'
agent-browser --config 'data/evidence/verify-acquit/RUN_STAMP/browser.json' --namespace verify-acquit --session verify-acquit open http://localhost:5173
```

Use the same config, namespace, and session on every browser command. Do not reuse snapshot refs after navigation. Wait for the named result instead of sleeping.

### Optional buyer approval

Check only whether `SANDBOX_BUYER_PASSWORD` is set. Do not search for the password. Never open the PayPal dashboard to find it.

If the password is absent, stop at checkout. Report "Buyer approval skipped because SANDBOX_BUYER_PASSWORD is not set." Do not claim HELD escrow or a completed payment.

If the password is present, sign in as `SANDBOX_BUYER_EMAIL` and complete the sandbox purchase. Use the fresh checkout snapshot to identify the email, password, login, and final purchase controls. PayPal's labels can change. Pass credentials through standard input, not command-line arguments or a printed script. This Node pattern fills an observed selector without exposing its value in tool output.

```powershell
Set-Location 'D:\dev\Apps\unnamed'
$env:DATABASE_PATH='./data/verify/acquit.db'
@'
const { spawnSync } = require("node:child_process");
process.loadEnvFile(".env");
const stamp = process.argv[2];
const selector = process.argv[3];
const key = process.argv[4];
if (!["SANDBOX_BUYER_EMAIL", "SANDBOX_BUYER_PASSWORD"].includes(key) || !process.env[key]) process.exit(1);
const script = `const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error("Login field missing"); e.focus(); const p = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"); p.set.call(e, ${JSON.stringify(process.env[key])}); e.dispatchEvent(new Event("input", {bubbles:true})); e.dispatchEvent(new Event("change", {bubbles:true})); "Credential field filled";`;
const env = {...process.env};
for (const name of Object.keys(env)) if (name.startsWith("AGENT_BROWSER_") || name === "FACTORY_DESKTOP_CDP_PORT" || /PAYPAL|SANDBOX|PASSWORD|SECRET|TOKEN|API_KEY|MERCHANT_ID/.test(name)) delete env[name];
env.AGENT_BROWSER_HEADED = "false";
const result = spawnSync("agent-browser", ["--config", `data/evidence/verify-acquit/${stamp}/browser.json`, "--namespace", "verify-acquit", "--session", "verify-acquit", "eval", "--stdin"], {input:script, env, stdio:["pipe","ignore","ignore"]});
process.exit(result.status ?? 1);
'@ | node - RUN_STAMP OBSERVED_SELECTOR SANDBOX_BUYER_EMAIL
```

Repeat with the observed password selector and `SANDBOX_BUYER_PASSWORD`. Click the real PayPal login and purchase controls through `agent-browser`. Do not capture credential fields or save a login snapshot with the email visible.

After the return redirect, require the job page to show `Escrow: HELD, locked to devon-ops`. Require the Ledger to show `HELD` and `420.00 USD`. Save a screenshot and a sanitized `GET /api/jobs/:id` response. Require `status:IN_PROGRESS`, `escrow:HELD`, `lockedTo:devon-ops`, and a ledger line with `kind:HELD` and `cents:42000`. Update `summary.json` with the approval result. If login, approval, or return fails, report that step as unverified.

## Evidence

Keep evidence in `data/evidence/verify-acquit/<run-stamp>/`. The directory is under gitignored `data/`.

- Keep `launch.json` to prove instance ownership.
- Keep the before-action and after-action screenshots and ARIA snapshots. The helper saves sign-in, posting, bidding, acceptance confirmation, and checkout.
- Keep `job-opened.json`, `job-funding.json`, both credit responses, `funding-checks.json`, `actions.jsonl`, and `summary.json`.
- Keep `cleanup.json` to prove that ports closed without removing evidence.
- Open key screenshots with Read. Confirm the screenshot matches the claimed action or result.
- Redact approval URL query strings and any environment values in JSON or snapshots. Never record auth headers, tokens, cookies, or raw database rows.
- Prove mutations through user actions and a separate read of the stored result. A screenshot alone does not prove the credit debit or funding quote.
- Report the specific entry point driven. The helper covers job-page bidding, not the operator dashboard's inline Bid form. Do not mark an undriven entry point as verified.

## Cleanup

Always run cleanup, even after failure. The helper stops only the PIDs recorded by this run. It refuses changed ownership.

```powershell
Set-Location 'D:\dev\Apps\unnamed'
$env:DATABASE_PATH='./data/verify/acquit.db'
node .factory/skills/verify-acquit/scripts/fund-escrow.mjs cleanup RUN_STAMP
Get-ChildItem -LiteralPath 'data/evidence/verify-acquit/RUN_STAMP' | Select-Object Name,Length
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in 4310,5173
```

Require `stopped:true`, `portsClosed:[4310,5173]`, an evidence file listing, and no listening ports. Close only `verify-acquit`, never all browser sessions. Never kill processes by name.

If Launch failed before `launch.json` appeared, run `status` with the verification database env. Stop only if its recorded database and PIDs match the failed start's output. Otherwise report the ownership gap. Check the background PID and stop that exact launcher if it is still alive.

Retain the verification database and evidence for inspection. Do not delete session files in the shared `data/ctl/sessions` directory. Do not reset a funded sandbox run just to tidy it.

## Helpers

`scripts/fund-escrow.mjs` uses Node built-ins and the bundled `agent-browser` CLI. Invoke it through `node` as shown above. It has three modes.

- `doctor` checks the owned instance without browser actions or app mutations.
- `drive` runs the real Post, Bid, and Accept checkout path and saves sanitized evidence.
- `cleanup` closes the named browser and stops the owned app. It preserves all proof artifacts.

Use `/maintain-verification-skill` when routes, labels, CLI commands, or supported features change. Keep the feature map's entry points and proof rules aligned with the app.
