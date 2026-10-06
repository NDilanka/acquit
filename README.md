# Acquit

Cleared, then paid. A marketplace where AI-agent operators deliver verified coding work, and PayPal escrow pays them once the work is proven. The usage spec is `docs/tutorial.md`.

## Prerequisites

- Node.js 24 or newer
- A PayPal sandbox Platform app, a sandbox operator merchant onboarded through Partner Referrals, and a sandbox Personal buyer

## Configure

Create `.env` in the repo root (it is gitignored):

```
PAYPAL_ENV=sandbox
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
OPERATOR_DEVON_MERCHANT_ID=...
PLATFORM_MERCHANT_ID=...
SANDBOX_BUYER_EMAIL=...
PORT=4310
WEB_PORT=5173
DATABASE_PATH=./data/acquit.db
# Optional: the verifier's port and the pair the API and the verifier must share.
# npm run dev and a lane generate the pair when they are absent.
ACQUIT_VERIFIER_PORT=4311
ACQUIT_VERIFIER_RUN_SECRET=...
ACQUIT_VERIFIER_CALLBACK_SECRET=...
```

## Run

```
npm install
npm run seed
npm run dev
```

Open http://localhost:5173 and sign in as `maya-client` (client) or `devon-ops` (operator). There are no passwords in the skeleton.

## Control CLI

For agents and scripts. Every command prints one JSON object, and every error has a `fix` field naming what to run instead.

```
npm run -s ctl -- --help
npm run -s ctl -- start            # starts or reuses the API and web app
npm run -s ctl -- status           # read-only health check
npm run -s ctl -- seed-db --dry-run
npm run -s ctl -- login --test-user maya-client --save
npm run -s ctl -- screenshot --as maya-client --path /
npm run -s ctl -- stop --dry-run
```

## Check

```
npm run typecheck
npm test
npm run smoke     # real sandbox: login, OpenJob, PlaceBid, AcceptBid, checkout link
```

## Verification lanes

Set `ACQUIT_LANE=<n>` before every control command. Lane n uses API port `4310 + 10n`, web port `5173 + 10n`, verifier port `4311 + 10n`, database `data/verify/lane-<n>/acquit.db`, run files `data/ctl/lane-<n>/`, and browser session `verify-acquit-lane-<n>`. Without a lane, the control command keeps the configured default ports and database. `npm run ctl -- start` owns all three services: it records each one's PID, port, and ownership channel in the run file, probes `/api/users`, `/`, and the verifier's `/healthz`, and `stop` proves ownership of each before it kills anything.

The verifier needs a run secret, a callback secret, and the API's callback URL. A lane generates the pair per start and hands the same values to the API and the verifier; neither the run file nor a log line carries a secret. Set `ACQUIT_VERIFIER_RUN_SECRET`, `ACQUIT_VERIFIER_CALLBACK_SECRET`, and `ACQUIT_VERIFIER_CALLBACK_URL` in `.env` to keep them stable, and `ACQUIT_VERIFIER_PORT` outside a lane. The verifier judges with the Docker subject by default; `ACQUIT_VERIFIER_SUBJECT=child` with `ACQUIT_DEV=1` is the test/dev path and is refused otherwise.

A lane's client repo is the repository the job's contract names, and it must exist on GitHub with the frozen commit as its default branch. `node .factory/skills/verify-acquit/scripts/lane-repo.mjs <lane> <branch> --owner <account> --create` prepares the local work directory, creates the private repo with `main` at the fixture's frozen commit, and reports whether the App installation can see it. The live lane repo is `NDilanka/invoice-app` (private, `main` = `a3b6ead`). The API still names `maya-client/invoice-app` for every job, so a lane cannot open a job against its own repo yet; `OpenJob` answers `DENIED NOT_FOUND` for any other repository.

Start the API with `ACQUIT_DEV=1` to use `npm run ctl -- clock advance 4h` or `npm run ctl -- fund-mode card`. Card mode uses a real sandbox test-card capture without buyer login. Funding regression and tutorial runs use checkout mode. The clock offset and funding mode reset on restart.

`node .factory/skills/verify-acquit/scripts/lanes.mjs start 10` measures two app slots' simultaneous working sets and the separate marginal browser cost. The app cost is the larger of the first-slot and marginal cost; the reserve is measured startup transient pressure plus 64 MB (128 MB minimum). Admission uses current free physical memory, with `ACQUIT_MAX_LANES` and `ACQUIT_RESERVE_MB` optional overrides. Browsers have a separate cap, at most two by default. `lanes.mjs restart <n>` stops an owned slot before measuring free memory and admitting its replacement; do not count a restart as an additional slot. Run `doctor` and `cleanup` through the same script. See [the verification skill](.factory/skills/verify-acquit/SKILL.md) for the browser drive and evidence rules.
