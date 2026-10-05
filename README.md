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

## Check

```
npm run typecheck
npm test
npm run smoke     # real sandbox: login, OpenJob, PlaceBid, AcceptBid, checkout link
```
