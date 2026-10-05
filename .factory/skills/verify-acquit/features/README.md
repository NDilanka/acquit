# Acquit verification map

Read this index before driving Acquit. Each entry names a user path and its observable proof.

## Baseline preconditions

- Follow Launch and Doctor in [the skill](../SKILL.md).
- Set `ACQUIT_LANE=<n>` for every call. Never reset the user's `data/acquit.db`. The no-lane fallback requires `DATABASE_PATH=./data/verify/acquit.db`.
- Start with the seeded users, issue `maya-client/invoice-app#12`, Devon's `ts-bugfixer`, and 30 bid credits.
- Use the URLs from `ctl status`. Lane n uses web port `5173 + 10n` and API port `4310 + 10n`.
- Run app slots within the cap printed by `scripts/lanes.mjs start <count>`. Browser memory is measured separately; keep at most two browser sessions and respect the printed `browserCap`. App-only waves may run three or more slots.
- Use the isolated headless namespace and session `verify-acquit-lane-<n>`.

## Driving conventions

The commands below assume the browser environment isolation from the skill's Drive section. In each PowerShell Execute call, define this convenience function with the actual run stamp.

```powershell
$env:ACQUIT_LANE='1'
$status = node packages/ctl/src/main.ts status | ConvertFrom-Json
$webUrl = $status.data.urls.web
$apiUrl = $status.data.urls.api
$runDir = Split-Path $status.data.runFile
$browserSession = "verify-acquit-lane-$env:ACQUIT_LANE"
function ab { agent-browser --config 'data/evidence/verify-acquit/RUN_STAMP/browser.json' --namespace $browserSession --session $browserSession @args }
```

Create that config as `{"headed":false,"autoConnect":false}` before the first manual browser drive. The escrow helper creates it automatically.

Use `ab snapshot -i` after each page change. Prefer named roles and labels. Use read-only HTTP to confirm mutations. Capture CLI login output instead of printing it.

## Proof and skip reporting

Capture the action and result as screenshots and ARIA snapshots. Save API JSON without secrets. Record the feature ID, entry point, observed result, and any skip in the run summary. Evidence survives cleanup.

A drive of one feature or entry point does not verify the other entries. Report unsupported tutorial paths as outside the built skeleton.

## Features

- [00. Isolate lanes and control development time](00-control-lanes.md) covers process ownership, origin isolation, the clock, and sandbox card funding.
- [01. Sign in as a seeded user](01-sign-in.md) covers the browser picker, role switching, and control CLI login.
- [02. Post a job](02-post-job.md) covers issue selection, budget, deadline, and the opened job.
- [03. Bid on a job](03-bid-job.md) covers job-page and operator-dashboard bidding and the credit debit.
- [04. Post a job, accept a bid, and fund escrow](04-fund-escrow.md) covers real sandbox checkout and optional buyer approval.
- [05. Cancel an open job](05-cancel-job.md) covers confirmation, closed state, and returned bid credits.
