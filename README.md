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

Set `ACQUIT_LANE=<n>` before every control command. Lane n uses API port `4310 + 10n`, web port `5173 + 10n`, database `data/verify/lane-<n>/acquit.db`, run files `data/ctl/lane-<n>/`, and browser session `verify-acquit-lane-<n>`. Without a lane, the control command keeps the configured default ports and database.

Start the API with `ACQUIT_DEV=1` to use `npm run ctl -- clock advance 4h` or `npm run ctl -- fund-mode card`. Card mode uses a real sandbox test-card capture without buyer login. Funding regression and tutorial runs use checkout mode. The clock offset and funding mode reset on restart.

`node .factory/skills/verify-acquit/scripts/lanes.mjs start 10` measures one slot and starts a memory-capped wave with a 1024 MB reserve. Set `ACQUIT_MAX_LANES=2` on this machine. Run `doctor` and `cleanup` through the same script. See [the verification skill](.factory/skills/verify-acquit/SKILL.md) for the browser drive and evidence rules.
