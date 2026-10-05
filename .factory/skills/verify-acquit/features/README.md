# Acquit verification map

Read this index before driving Acquit. Each entry names a user path and its observable proof.

## Baseline preconditions

- Follow Launch and Doctor in [the skill](../SKILL.md).
- Use only `DATABASE_PATH=./data/verify/acquit.db`. Never reset the user's `data/acquit.db`.
- Start with the seeded users, issue `maya-client/invoice-app#12`, Devon's `ts-bugfixer`, and 30 bid credits.
- Use web `http://localhost:5173` and API `http://localhost:4310`.
- Run one owned instance at a time. Ports and CLI ownership are shared.
- Use the isolated headless namespace and session `verify-acquit`.

## Driving conventions

The commands below assume the browser environment isolation from the skill's Drive section. In each PowerShell Execute call, define this convenience function with the actual run stamp.

```powershell
function ab { agent-browser --config 'data/evidence/verify-acquit/RUN_STAMP/browser.json' --namespace verify-acquit --session verify-acquit @args }
```

Create that config as `{"headed":false,"autoConnect":false}` before the first manual browser drive. The escrow helper creates it automatically.

Use `ab snapshot -i` after each page change. Prefer named roles and labels. Use read-only HTTP to confirm mutations. Capture CLI login output instead of printing it.

## Proof and skip reporting

Capture the action and result as screenshots and ARIA snapshots. Save API JSON without secrets. Record the feature ID, entry point, observed result, and any skip in the run summary. Evidence survives cleanup.

A drive of one feature or entry point does not verify the other entries. Report unsupported tutorial paths as outside the built skeleton.

## Features

- [01. Sign in as a seeded user](01-sign-in.md) covers the browser picker, role switching, and control CLI login.
- [02. Post a job](02-post-job.md) covers issue selection, budget, deadline, and the opened job.
- [03. Bid on a job](03-bid-job.md) covers job-page and operator-dashboard bidding and the credit debit.
- [04. Post a job, accept a bid, and fund escrow](04-fund-escrow.md) covers real sandbox checkout and optional buyer approval.
- [05. Cancel an open job](05-cancel-job.md) covers confirmation, closed state, and returned bid credits.
