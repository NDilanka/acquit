# Acquit

Cleared, then paid. A marketplace where AI-agent operators deliver verified coding work, and PayPal escrow pays them once the work is proven. The usage spec is `docs/tutorial.md`; the code map and invariants are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Hosted demo

The demo runs at https://80-225-220-230.sslip.io. It is public: the basic-auth gate that protected it during the build came down at Close, so no credential is needed. Route / opens the three-step tour, and Start my demo provisions a visitor with its own client and operator accounts and its own fork of the fixture repository. Each address can start 3 demo visitors per rolling 24 hours (`VISITORS_IP_DAY` in `packages/core/src/caps.ts`); expired visitors and their forks are removed by `ctl sweep`. Everything runs against the PayPal sandbox, so no real money moves.

## What is built

- **Escrow on the PayPal sandbox.** A client funds a job through PayPal checkout or a sandbox test card; the funds are held until the verdict. VERIFIED releases the operator's payout minus the platform fee as a referenced payout; a rejected or timed-out job refunds or reopens. Webhook deliveries are applied only after PayPal's verify-webhook-signature returns `SUCCESS` (`packages/core/src/effects.ts`).
- **A Docker verifier with hidden tests.** Each job freezes a manifest (repository, issue, frozen commit, frozen tests, and the digest of private hidden cases). The verifier judges a delivered commit against both; the hidden cases live outside every git repository (`packages/verifier/`).
- **AI scoping.** On Open job, the model drafts the acceptance contract and hidden cases; the client approves the draft before the manifest freezes (`packages/core/src/scoping.ts`).
- **The House.** The platform's own operator delivers with a real model inside the runner sandbox, through the same Submit edge any operator uses, and every delivery writes a receipt row (`packages/house/`, `packages/runner/`).
- **An MCP server for operators' agents.** A stdio server over the operator token with `list_jobs`, `get_job`, `place_bid`, `submit_attempt`, `get_receipt`, and `get_payout_status`; payout status is read through `@paypal/agent-toolkit`. The operator confirms each submit in the CLI or the web app, never through a model-set flag (`packages/mcp/`).
- **The web app.** Sign-up and sign-in, job pages with the checkout breakdown, payee, and ledger, AG Grid tables for bids, the ledger, and receipts, AG Studio dashboards for operator earnings and platform escrow, and the "Ask the ledger" agent with read-only Acquit and PayPal tools (`apps/web/`).
- **Model provider.** Every app model call (the House, scoping, and Ask the ledger) reads `ACQUIT_MODEL_PROVIDER`. The default is `droid`, which runs Factory's `droid exec -m glm-5.3-flash` with `FACTORY_API_KEY`; `openrouter` is the selectable alternative (`packages/core/src/model.ts`).
- **Deployment.** The hosted VM's Caddy, systemd, and firewall configuration is tracked as templates, with no secret in the tree. See [deploy/README.md](deploy/README.md).

## What proves each judging criterion

The hackathon weighs five criteria equally. [docs/win-plan.md](docs/win-plan.md) sections 1 to 4 carry the rules and our read of them. Each row names the screen or the file where a judge can check the claim against the code.

| Criterion | Proof on screen | Proof in the repo |
| --- | --- | --- |
| Technological Implementation | A job page (route /jobs/:id) runs PayPal escrow end to end: the funded hold, the delivered commit, and the verdict that releases or refunds it. | `packages/core/src/paypal.ts` (orders, verified webhooks, referenced payouts, refunds), `packages/core/src/effects.ts` (the apply pipeline), `packages/house/src/runner.ts` (the House agent on a real model), `packages/mcp/` (the MCP server an agent drives), `packages/verifier/judge.ts` (the Docker judge). |
| Design | Route / is the judge entry with the three-step tour and the role choice; /jobs/new posts a job; a job page carries the checkout breakdown, the payee, and the ledger; /studio holds the AG Studio dashboards over the AG Grid tables. | `apps/web/src/pages/` and `apps/web/src/studio/`. |
| Potential Impact | The operator page (route /operator) lists deliveries, receipts, and payouts; /studio shows the platform's escrow position next to the ledger it must conserve. | `packages/core/src/store.ts` (the House line counts receipt rows, and seeded rows are marked SEED), `packages/core/src/ledger.ts` with `docs/architecture/rationale.md` (payout + fee = paid). |
| Innovation | A job page's verdict timeline shows a tampered submission REJECTED and an honest fix VERIFIED. | `packages/verifier/judge.ts` (frozen plus hidden tests), `packages/core/src/fixtures.ts` (a manifest frozen per job), `packages/core/src/scoping.ts` (AI drafts the acceptance contract; the client approves before it freezes). The delivery agent never sees the hidden cases: their values live outside every git repository. |
| Presentation | The tour on route / walks a new visitor to Start my demo in public mode. | README.md (this map), `ARCHITECTURE.md`, `docs/tutorial.md`, `docs/video-script.md`. |

## Where the build log lives

Two gitignored directories carry the build's process, and a fresh clone does not have them: `scratch/` holds the prototypes, probes, and lane scripts the build ran, and `data/trail/` holds the decision log, resume notes, and evidence. They are the build log, not product code.

## Prerequisites

- Node.js 24 or newer
- Docker, running (the verifier judges in a Docker subject; the House and `acquit run` use the runner image, built with `docker build -t acquit/runner-node20 packages/runner`)
- A PayPal sandbox Platform app, a sandbox operator merchant onboarded through Partner Referrals, a sandbox merchant for the House, and a sandbox Personal buyer
- For model runs: a Factory API key for the default `droid` provider

## Configure

Create `.env` in the repo root (it is gitignored). The API, the control CLI, and `npm run dev` load it with `process.loadEnvFile`. The names below are the ones the code reads; no value belongs in this README or in any tracked file.

| Name | Needed for |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Required by the API. `PAYPAL_API_BASE` may name only the sandbox API. `PAYPAL_ENV` tells the MCP server's PayPal toolkit which environment to use. |
| `OPERATOR_DEVON_MERCHANT_ID`, `OPERATOR_HOUSE_MERCHANT_ID` | Required by `npm run seed`: the demo operator's payee and the House's own payee. The API also pays demo visitors' operators through `OPERATOR_DEVON_MERCHANT_ID`. |
| `PAYPAL_WEBHOOK_ID` | The webhook id the API verifies every PayPal delivery's signature against. |
| `PAYPAL_PARTNER_MERCHANT_ID`, `PAYPAL_PARTNER_ATTRIBUTION_ID` | The platform's partner identity on orders and payouts. |
| `ACQUIT_FIXTURES` | The fixture registry the API and the verifier boot with. With `ACQUIT_DEV=1`, they fall back to `packages/verifier/fixtures/fixtures.example.json`. |
| `ACQUIT_CLIENT_REPOSITORY` | The client repository a demo visitor's fork is made from (default `maya-client/invoice-app`). |
| `ACQUIT_GITHUB_APP_ID`, `ACQUIT_GITHUB_APP_ORG`, `ACQUIT_GITHUB_APP_PRIVATE_KEY` | The GitHub App that creates visitor forks and per-job work repos. Blank them for a lane that must not touch GitHub. |
| `ACQUIT_MODEL_PROVIDER`, `FACTORY_API_KEY` | The model provider switch (`droid` by default). The droid provider reads `FACTORY_API_KEY`, then `~/.config/acquit/factory-api-key`. |
| `ACQUIT_PLATFORM_KEY` | Mints the platform session behind the platform ledger route and dashboards. |
| `VITE_AG_STUDIO_LICENSE_KEY` | The AG Studio license for the dashboards. |
| `ACQUIT_DEV` | `1` turns on the seeded sign-in, the dev-only routes, the dev clock, and the funding-mode switch. Leave it unset for a public deployment. |
| `PORT`, `WEB_PORT`, `DATABASE_PATH`, `WEB_ORIGIN` | API port (default 4310), web port (default 5173), database path (default `./data/acquit.db`), and the web origin. |
| `ACQUIT_VERIFIER_PORT`, `ACQUIT_VERIFIER_RUN_SECRET`, `ACQUIT_VERIFIER_CALLBACK_SECRET`, `ACQUIT_VERIFIER_CALLBACK_URL` | The verifier's port and the pair the API and the verifier share. `npm run dev` and a lane generate the pair when it is absent. |
| `ACQUIT_SCOPING_DIR` | Optional: the private store for approved scoping drafts. The default sits under the profile's config directory, outside every git work tree. |
| `PLATFORM_MERCHANT_ID`, `SANDBOX_BUYER_EMAIL` | Used by the verification skill's funding driver (`.factory/skills/verify-acquit/scripts/fund-escrow.mjs`). |

To list the names a local `.env` sets without printing any value, run `grep -oE '^[A-Z_]+=' .env`.

## Run

```
npm install
npm run seed
ACQUIT_DEV=1 npm run dev
```

Open http://localhost:5173 and sign in as `maya-client` (client) or `devon-ops` (operator); the seeded users have no passwords. That seeded sign-in exists only with `ACQUIT_DEV=1`. Without it the app runs in public mode, as the hosted demo does: visitors start through Start my demo, and `ACQUIT_FIXTURES` must name your own registry, because the API and the verifier refuse to boot without one.

The operator CLI is `node packages/acquit-cli/src/main.ts` (bin `acquit`), and the MCP server is `node packages/mcp/src/main.ts` (bin `acquit-mcp`).

## Control CLI

For agents and scripts. Every command prints one JSON object, and every error has a `fix` field naming what to run instead.

```
npm run -s ctl -- --help
npm run -s ctl -- start            # starts or reuses the API and web app
npm run -s ctl -- status           # read-only health check
npm run -s ctl -- seed-db --dry-run
npm run -s ctl -- login --test-user maya-client --save
npm run -s ctl -- screenshot --as maya-client --path /
npm run -s ctl -- sweep --dry-run   # expired demo visitors and their repositories
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

A lane's client repo is the repository the job's contract names, and it must exist on GitHub with the frozen commit as its default branch. `node .factory/skills/verify-acquit/scripts/lane-repo.mjs <lane> <branch> --owner <account> --create` prepares the local work directory, creates the private repo with `main` at the fixture's frozen commit, and reports whether the App installation can see it. `OpenJob` freezes the manifest of the registered fixture its command names (the registry is `ACQUIT_FIXTURES`) into the job. A lane that approves or merges should use a disposable client repo, not a shared one.

Start the API with `ACQUIT_DEV=1` to use `npm run ctl -- clock advance 4h` or `npm run ctl -- fund-mode card`. Card mode uses a real sandbox test-card capture without buyer login. Funding regression and tutorial runs use checkout mode. The clock offset and funding mode reset on restart.

`node .factory/skills/verify-acquit/scripts/lanes.mjs start 10` measures two app slots' simultaneous working sets and the separate marginal browser cost. The app cost is the larger of the first-slot and marginal cost; the reserve is measured startup transient pressure plus 64 MB (128 MB minimum). Admission uses current free physical memory, with `ACQUIT_MAX_LANES` and `ACQUIT_RESERVE_MB` optional overrides. Browsers have a separate cap, at most two by default. `lanes.mjs restart <n>` stops an owned slot before measuring free memory and admitting its replacement; do not count a restart as an additional slot. Run `doctor` and `cleanup` through the same script. See [the verification skill](.factory/skills/verify-acquit/SKILL.md) for the browser drive and evidence rules.
