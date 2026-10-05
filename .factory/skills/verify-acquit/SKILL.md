---
name: verify-acquit
description: Verify Acquit's local web UI with a headless browser and its control CLI. Use after changes to seeded sign-in, job posting, bids, cancellation, or PayPal sandbox escrow.
---

# Verify Acquit

Read [the feature map](features/README.md) before choosing a drive. This skill verifies the built Post, Bid, and Accept flows. It does not claim the tutorial's delivery, verifier, payout, or GitHub flows work.

## Hard rules

- Run from your PR worktree with Node 24 and PowerShell 7. Copy its gitignored `.env` without displaying it.
- Set `ACQUIT_LANE=<n>` for every control CLI and helper call. The lane owns `data/verify/lane-<n>/acquit.db`. Never reset `data/acquit.db`. Without a lane, set `DATABASE_PATH=./data/verify/acquit.db` explicitly.
- Lane n owns API port `4310 + 10n`, web port `5173 + 10n`, run directory `data/ctl/lane-<n>/`, and browser session `verify-acquit-lane-<n>`. Lane selection overrides the default port and database environment values.
- Refuse an existing run or occupied ports within the chosen slot. App slots and browsers have separate measured memory caps. Keep at most two browsers active; app-only waves may have more slots (lane 10 requires three).
- Use the bundled `agent-browser` CLI with the lane's headless session and namespace. Never use `--cdp`, `--auto-connect`, a saved user profile, or the user's desktop pane.
- Never print environment values, session tokens, cookie values, or buyer credentials. Capture `login --save` output in memory. Do not copy session files into evidence.
- Use real sandbox checkout for funding regression and tutorial runs. Other scenarios can use the development card mode below. Do not stub PayPal, call command APIs to perform a feature, or set job state internally.

## Launch

Dependencies must already be installed. The root `.env` needs the PayPal sandbox keys named in `README.md`. Do not display that file.

Run this preflight. A failure is a stop, not permission to kill an existing instance.

```powershell
Set-Location 'D:\dev\Apps\acquit-worktrees\YOUR_WORKTREE'
$env:ACQUIT_LANE='1'
$env:ACQUIT_DEV='1'
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
Set-Location 'D:\dev\Apps\acquit-worktrees\YOUR_WORKTREE'
$env:ACQUIT_LANE='1'
$env:ACQUIT_DEV='1'
node packages/ctl/src/main.ts start --timeout 60 | Tee-Object -FilePath 'data/evidence/verify-acquit/RUN_STAMP/launch.json'
```

Note the background PID and log path. Wait, then read `launch.json`. Require `ok:true`, `alreadyRunning:false`, the verification database path, and the expected URLs. The CLI reports ready only after both endpoints answer.

Inspect the proposed reset, then reset only this run's verification database. Seeding invalidates all development sessions. Log in only after seeding.

```powershell
Set-Location 'D:\dev\Apps\acquit-worktrees\YOUR_WORKTREE'
$env:ACQUIT_LANE='1'
$env:ACQUIT_DEV='1'
node packages/ctl/src/main.ts seed-db --dry-run
node packages/ctl/src/main.ts seed-db --yes
```

Require the dry-run's `databasePath` to end with `data\verify\lane-1\acquit.db`. `--dry-run` reads counts and skips the reset and seed subprocess. It is not a funding dry-run. Real `Accept` creates a sandbox order.

## Doctor

Run this read-only check before driving and whenever anything looks wrong.

```powershell
Set-Location 'D:\dev\Apps\acquit-worktrees\YOUR_WORKTREE'
$env:ACQUIT_LANE='1'
$env:ACQUIT_DEV='1'
node .factory/skills/verify-acquit/scripts/fund-escrow.mjs doctor RUN_STAMP
```

Require `healthy:true`. The helper compares both live PIDs to `launch.json`, checks ports and the database path, and requires seeded data and configured key names. It refuses changed ownership. The drive also verifies authenticated API reads after CLI login.

## Drive

Run feature 04 through the reusable helper.

```powershell
Set-Location 'D:\dev\Apps\acquit-worktrees\YOUR_WORKTREE'
$env:ACQUIT_LANE='1'
$env:ACQUIT_DEV='1'
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
agent-browser --config 'data/evidence/verify-acquit/RUN_STAMP/browser.json' --namespace verify-acquit-lane-1 --session verify-acquit-lane-1 open http://localhost:5183
```

Use the same config, namespace, and session on every browser command. Do not reuse snapshot refs after navigation. Wait for the named result instead of sleeping.

### Optional buyer approval

Check only whether `SANDBOX_BUYER_PASSWORD` is set. Do not search for the password. Never open the PayPal dashboard to find it.

If the password is absent, stop at checkout. Report "Buyer approval skipped because SANDBOX_BUYER_PASSWORD is not set." Do not claim HELD escrow or a completed payment.

If the password is present, run the approval helper after the checkout drive. It forces `locale.x=en_US`, uses observed structural PayPal controls before label fallbacks, sends `fill` commands through batch standard input (never eval or credential argv), and waits for HELD. Credential stdout is piped and discarded without any temporary output file. Credential commands bypass `actions.jsonl`; ordinary action rows use the evidence redactor. Never save or restore this browser session. It saves no credential fields or login snapshots. If controls are unsupported, report approval as unverified.

**No dashboard or stream client may be attached during approval.** A synthetic experiment against agent-browser 0.37.1 confirmed that both batch `fill` and `auth save --password-stdin` emit the password in stream activity parameters. The auth vault is therefore not a clean alternative. Approval refuses if dashboard port 4848, `AGENT_BROWSER_DASHBOARD_PORT`, or a discovered custom Windows dashboard listener is open, and rechecks before every credential fill. Before any credential command, approval runs `stream disable` on its own session and refuses if `~/.agent-browser/namespaces/<session>/run/<session>.stream` remains. A synthetic experiment confirmed that command closes the session stream port and removes the file. This does not detect a stream client that attaches after that check: the operator must ensure none attaches during approval. Do not stop a dashboard owned by someone else; report BLOCKED instead. The experiment used only synthetic credentials; its activity evidence is at `data/evidence/h0-r3/secret-probe/experiment.json` in the verification evidence workspace.

```powershell
$env:ACQUIT_LANE='1'
node .factory/skills/verify-acquit/scripts/fund-escrow.mjs approve RUN_STAMP
```

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
Set-Location 'D:\dev\Apps\acquit-worktrees\YOUR_WORKTREE'
$env:ACQUIT_LANE='1'
$env:ACQUIT_DEV='1'
node .factory/skills/verify-acquit/scripts/fund-escrow.mjs cleanup RUN_STAMP
Get-ChildItem -LiteralPath 'data/evidence/verify-acquit/RUN_STAMP' | Select-Object Name,Length
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in 4320,5183
```

Require `stopped:true`, `portsClosed:[4320,5183]`, an evidence file listing, and no listening ports. Close only the chosen lane browser, never all browser sessions. Never kill processes by name.

If Launch failed before `launch.json` appeared, run `status` with the verification database env. Stop only if its recorded database and PIDs match the failed start's output. Otherwise report the ownership gap. Check the background PID and stop that exact launcher if it is still alive.

Retain the verification database and evidence for inspection. Do not delete session files in the lane's `data/ctl/lane-<n>/sessions` directory. Do not reset a funded sandbox run just to tidy it.

## Helpers

`scripts/fund-escrow.mjs` uses Node built-ins and the bundled `agent-browser` CLI. Invoke it through `node` as shown above. It has four modes.

- `doctor` checks the owned instance without browser actions or app mutations.
- `drive` runs the real Post, Bid, and Accept checkout path and saves sanitized evidence.
- `approve` completes real buyer approval, or reports BLOCKED when the password is absent.
- `cleanup` closes the named browser and stops the owned app. It preserves all proof artifacts.

Use `/maintain-verification-skill` when routes, labels, CLI commands, or supported features change. Keep the feature map's entry points and proof rules aligned with the app.

## Development controls and lane waves

Start the API with `ACQUIT_DEV=1` to enable `npm run ctl -- clock advance 4h` and `npm run ctl -- fund-mode card`. Without that flag, both controls refuse the call with a configuration hint. Card mode still creates a real DELAYED sandbox capture and feeds the normal CaptureCompleted edge. Set `ACQUIT_FUND_MODE=card` for the helper drive after you select card mode. Require HELD and 42000 cents instead of the checkout redirect. Return to checkout mode with `npm run ctl -- fund-mode checkout`. Both the clock offset and funding mode reset when the API restarts.

`node .factory/skills/verify-acquit/scripts/lanes.mjs start 10` starts an app-only wave. The measurement starts two isolated API + Vite slots and records their marginal simultaneous current working-set delta, then adds a headless browser and measures that separately. It never sums process peaks. The app cost uses the larger of first-slot and marginal cost. The reserve is measured startup transient pressure plus 64 MB, with a 128 MB minimum; `ACQUIT_RESERVE_MB` overrides it. The printed cap is `floor((freeMB - reserveMB) / perLaneMB)`, limited by `ACQUIT_MAX_LANES` only when explicitly set. A zero cap exits nonzero, with needed/available MB and the configured limits.

Use `start --lanes 6,7,8` for explicit lane numbers in later waves, including lane 10's three-app cleanup isolation proof. `start 2 --browsers` includes browser memory in the admission cost and limits sessions by `ACQUIT_MAX_BROWSERS` (default two). For manual drives respect the printed `browserCap`, or clean unused apps before opening a browser. Apps do not need a browser for origin, PID, or cleanup checks. Never reset occupied slots. Run `doctor` and `cleanup` after every wave; `cleanup <n>` closes only the named owned slot. Databases and evidence survive.

For a development-flag restart (lane 8), run `lanes.mjs restart <n>`. It stops the owned slot, then measures free memory, then admits the replacement through the same cap and reserve as `start`. A `planWave` call always prices additional slots against current free memory; pricing a replacement while its old slot still runs double-counts it. This is not permission to subtract estimated memory, lower the reserve, or reuse occupied slots.

The versioned measurement lives in `data/ctl/lanes/memory.json`, including app/browser marginal MB, paired samples, physical free-memory deltas, transient pressure, and the reserve. Run `lanes.mjs measure` to refresh it. `ACQUIT_EVIDENCE_DIR` selects the evidence root; wave starts save `lane-<n>/launch.json` there for the escrow helper.
