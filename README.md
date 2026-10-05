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
npm run -s acquit -- --help
npm run -s acquit -- start            # starts or reuses the API and web app
npm run -s acquit -- status           # read-only health check
npm run -s acquit -- seed-db --dry-run
npm run -s acquit -- login --test-user maya-client --save
npm run -s acquit -- screenshot --as maya-client --path /
npm run -s acquit -- stop --dry-run
```

## Check

```
npm run typecheck
npm test
npm run smoke     # real sandbox: login, OpenJob, PlaceBid, AcceptBid, checkout link
```
