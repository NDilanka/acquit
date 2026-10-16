# Acquit HTTP contract (skeleton)

The web app and the API meet only here. The API owns this file. The web app reads it and never imports from `packages/core` at runtime; it may import types from `@acquit/core` (type-only imports).

## Ports and processes

- API: `http://localhost:4310` (env `PORT`).
- Web: `http://localhost:5173` (env `WEB_PORT`). Vite proxies `/api` and `/paypal` to the API, so the browser sees one origin.
- `npm run dev` at the repo root starts both. `npm run seed` resets the SQLite file at `DATABASE_PATH` and loads the seed.
- `npm run ctl -- start` with `ACQUIT_LANE=n` selects API port `4310 + 10n`, web port `5173 + 10n`, and `data/verify/lane-n/acquit.db`. The control command passes the selected database and `WEB_ORIGIN` to the API. The API origin check and PayPal callback URLs use that origin.

## Encoding

- JSON bodies, UTF-8. Money is integer cents (`UsdCents`), never a float or a string. `42000` is 420.00.
- Times are UTC ISO-8601 strings (`Instant`).
- Shapes are the exported types in `packages/core/src/acquit.ts`: `JobView`, `BidView`, `OperatorView`, `CreditAccountView`, `CommandOutcome`, `QueryResult`, `UserCommand`, `LedgerLine`.

## Session (skeleton only)

There is no password login in the skeleton. A dev picker signs in as a seeded user and sets an httpOnly cookie `acquit_session`. The CLI uses the same session token in `Authorization: Bearer <token>`; `POST /api/session` returns it as `token`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/session` | | `{ user: { handle, role: "CLIENT" \| "OPERATOR" } \| null, visitor, mode: "public" \| "dev", fundingMode: "card" \| "checkout" }`. `mode` is the deployment's own sign-in shape, so a page draws the public one or the seeded picker without probing a second route. `fundingMode` is the deployment's default payment method for a job nobody chose for |
| POST | `/api/session` | `{ handle: "maya-client" \| "devon-ops" }` | `{ user, visitor, token }` and the cookie. Public mode refuses a seeded handle `403 { error: "SEEDED_LOGIN_DISABLED" }` and any other handle `403 { error: "SESSION_MINT_DISABLED" }`; dev mode keeps the seeded sign-in |
| DELETE | `/api/session` | | `204` |
| GET | `/api/users` | | `{ users: [{ handle, role }] }`. Dev mode: the seeded picker. Public mode: the caller's own pair only, `401` without a session |

Every other `/api` route returns `401 { error: "UNAUTHENTICATED" }` without a session.

## Judge mode (visitors)

Public mode is `ACQUIT_DEV` unset. A session resolves through the `principals` table, never through the seeded constants, and a handle whose visitor row is gone stops resolving.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/demo` | `{}` | `201 { user, visitor, token }` and the cookie. The GitHub App forks the visitor's own client repository first, then this creates its client and operator principals, its operator with one agent and the first weekly grant, and mints the client's session. `503 { error: "DEMO_NOT_CONFIGURED" }` without a demo merchant, `502 { error: "DEMO_REPOSITORY_FAILED" }` when the App refuses the fork. Without an App configured the visitor's `repository` is null and it opens jobs on the deployment's own repository, which is the only path that exists then |
| POST | `/api/demo/switch` | `{}` | `{ user, visitor, token }`: moves this session between the visitor's own two principals. `403 { error: "NOT_DEMO_VISITOR" }` for any session that is not a visitor's |
| POST | `/api/demo/scenarios/:name` | `{}` | `201 { scenarioId, jobId }` once the run's job exists. Starts one of the five judge scenarios (`verified-and-paid`, `hidden-test-fail`, `test-tamper`, `dispute-arbiter`, `deadline-refund`) on a visitor provisioned for this start, so one session can start all five. The steps continue on the server, so a closed tab does not stop the run. Each refusal is listed below the table |
| GET | `/api/demo/scenarios/:id` | | `200` with the run: `{ id, name, requesterId, visitorId, jobId, steps, state, endState }`. `state` is `RUNNING`, `DONE`, or `FAILED`. `endState` is `{ jobStatus, reason }` once the run stops. Each step is `{ name, actor, startedAt, endedAt, ms, outcome, label }`, where `ms` is `endedAt - startedAt` on the server and `label` is one of `Scripted agent (Simulated)`, `Simulated time for this job`, `Real verifier run`, `PayPal sandbox`. `404 { error: "NOT_FOUND" }` for an unknown id and for another visitor's run, which is refused the same way so a run id does not confirm that someone else's run exists |

A refused start retains no run. Each refusal answers `{ error }` with one of these codes:

- `404 UNKNOWN_SCENARIO` for any name outside the five.
- `403 NOT_DEMO_VISITOR` for a session that is not a visitor's.
- `503 SCENARIO_FIXTURE_MISSING` when the deployment's registry does not hold the fixture named by `ACQUIT_SCENARIO_FIXTURE`.
- `503 SCENARIO_FIXTURE_MISMATCH` when that fixture is not on the repository the App forks visitors from, before any visitor is provisioned. It also answers when the fork a visitor gets opens on a different registered fixture than the scenario's, and that visitor's place is released.
- `429 SCENARIO_RUNNING_LIMIT` when the visitor already has 5 runs `RUNNING`.
- `503 SCENARIO_STORE_FULL` when the store holds 500 runs and none is finished to evict.
- `429 CAP_SCENARIOS_REQUESTER_DAY` when the requester has started 10 scenarios in 24 h, and `429 CAP_SCENARIOS_DAY` when the deployment has started 100 in 24 h. Both answer before anything is forked. A refused open answers `429` too, with the core's `CAP_*` code.
- `503 DEMO_NOT_CONFIGURED` without `OPERATOR_DEVON_MERCHANT_ID`.
- `502 DEMO_REPOSITORY_FAILED` when the App refuses the visitor's fork.
- `502 SCENARIO_OPEN_FAILED` when the job did not open.
- `409` with the core's denial reason for any other refused open.

A start that fails after its visitor is provisioned keeps that visitor until the sweep removes it. It still counts against both scenario caps, and it retains no run. A start refused before its visitor is provisioned reserves nothing.

A run is `DONE` only when it ends at its scenario's expected end state, shown here. Any other end is `FAILED`, and `endState` keeps the end the run reached.

| Scenario | `jobStatus` | `reason` |
|---|---|---|
| `verified-and-paid` | `PAID` | `CLIENT_APPROVAL` |
| `hidden-test-fail` | `IN_PROGRESS` | `TESTS_FAILED:hidden` |
| `test-tamper` | `IN_PROGRESS` | `PROTECTED_PATH_MODIFIED` |
| `dispute-arbiter` | `PAID` | `ARBITER_UPHELD` |
| `deadline-refund` | `REFUNDED` | `DELIVERY_DEADLINE` |

The scenario runs' snapshots are kept in the database (`scenario_runs`), written at every progress, so a finished run is still readable after a restart. A snapshot is for display only. Each committed run also has a cleanup journal row (`scenario_cleanup`), which records the run's job and its finish time and is never evicted with the snapshot. A run that was `RUNNING` when the store opens is marked `FAILED` with `failure: "RESTARTED"`. Its recorded steps stay as they were, its scripted steps are never resumed, and the job it opened stays in the core. The store keeps at most 10 runs per visitor and 500 in all, and a visitor may have at most 5 runs `RUNNING` at once. A full visitor or a full store evicts its oldest finished snapshot, and a `RUNNING` run is never evicted. An evicted run's repositories are still removed by the cleanup below. The limits are the constants `SCENARIO_RUNS_PER_REQUESTER`, `SCENARIO_RUNNING_PER_REQUESTER`, and `SCENARIO_RUNS_TOTAL` in `packages/core/src/scenarios.ts`. Only the visitor that started a run can read it.

Every run opens on one fixture. `ACQUIT_SCENARIO_FIXTURE` names it by its registry key, `<owner>/<repo>#<issue>`, and defaults to `maya-client/invoice-app#12`. The scripted trees are written for that fixture's frozen suite, so a deployment whose registry lacks the fixture answers `503 SCENARIO_FIXTURE_MISSING`. A scripted tree writes only the files its corpus entry names. The honest and hardcoded trees write `src/money.ts`. The `test-tamper` tree writes the frozen suite, where that overwrite is the point. The fixture's other files stay as the fixture froze them. Before the write, the workspace checks that the job's frozen suite imports the formatter the trees write, and that the cases the verifier's own extractor reads from it match the score card's visible rows by content, in order. Test names are not part of that check. A checkout that fails the check fails the run's push with `SCENARIO_FIXTURE_INCOMPATIBLE`, and the run reads `FAILED`. A visitor's fork is made from `ACQUIT_CLIENT_REPOSITORY`, and the core resolves a fork to the one registered fixture whose demo fork prefix and issue name it. A fork that two fixtures both name matches neither.

Each run's job takes card funding, as the dev card mode does, so its accept step reaches `HELD` without a buyer checkout. That step is labeled `PayPal sandbox`. The scripted agent's tree is the score card's own corpus entry, committed to the job's work repo through the House's git port. The `dispute-arbiter` path runs a scenario-only arbiter verdict (`UPHOLD`) through the core's `ResolveDispute` edge, with `ACQUIT_DEV` unset. The verdict is refused with `SCENARIO_ARBITER_NOT_OWNED` unless the run is `RUNNING`, named `dispute-arbiter`, and its own committed `OpenJob` receipt names that job. A run record the store did not commit is refused by name as well. No HTTP route reaches it. A failed step records only a closed code (`FAILED <CODE>`, or `STEP_FAILED` for an error without one), never the provider's message, so a credential in that message is not stored or returned.

`visitor` is `{ id, client, operator, repository, expiresAt }`. The repository is `acquit-forks/demo-<id>` when the App forked one: the visitor's client is the only principal that may open a job on it, and `GET /api/repos` serves it in place of the deployment's own. A visitor's job freezes it into the contract, so its work repo is named after the visitor's fork and never after the deployment's repository. Every `/api/dev/*` route stays refused in public mode (`403 { error: "DEV_DISABLED" }`).

A visitor lives 24 hours. `npm run -s ctl -- sweep` removes each expired visitor's own repository through the App and then its rows; a repository the deployment cannot remove (or a missing App) keeps the visitor, so the next run retries exactly that work, and a repository that is already gone is not a failure. The sweep is safe to run as often as wanted.

The judge scenarios have their own cleanup, which the same `sweep` command runs and the API runs every 10 minutes on its own timer. A scenario visitor's fork goes once every run it started has been finished for 2 hours (`SCENARIO_SWEEP_TTL_MS` in `packages/core/src/sweep.ts`), and so does a fork that never started a run. A finished run's work repo goes once the run is 2 hours past its finish. A `RUNNING` run's repositories are never touched. The expiry sweep leaves a scenario visitor to this pass, even after a clock jump. A work repo's record is written when GitHub answers for the fork, before any ref write, and a record that lands after a pass reopens that job's cleanup. A creation still pending keeps its job until it settles. Each removal goes through the same ownership check as the visitor sweep, and a repository is removed only by the GitHub id the core recorded for it. A repository with no recorded id is kept with `GITHUB_FORK_UNRECORDED`, so a crash between a fork and its record leaves that fork for a person to remove.

Two job actions are scoped to the caller's own visitor. Both read the stored job first: an unknown id is `404 { error: "NOT_FOUND" }`, and a job whose `client` is not the calling visitor's client handle is `403 { error: "NOT_VISITOR_JOB" }`.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/jobs/:id/funding` | `{ mode: "checkout" \| "card" }` | `200 { mode }`. `400` for any other mode. `409 { error: "FUNDING_BOUND" }` once the job has left `BIDDING`, because an accepted bid already bound the order's payment source |
| POST | `/api/jobs/:id/clock` | `{ advanceMs }` (positive, at most 365 days) | `200 { job, handles, now }`, the same body `GET /api/jobs/:id` serves, after the job's own instants moved and `Acquit.tick` ran. `400` for anything else. `409 { error: "JOB_CHANGED" }` if the row moved under the shift |

Advancing one job's clock moves that job's stored instants, its wake time, and its own pending effects' due times. Another job's row, deadlines, review windows, and outbox are never touched: the deployment's own clock is not moved and no other job's timer changes. A leased effect stays where it is, because that lease is another worker's hold rather than this job's timeline. The job's own view carries the total advanced so far as `job.clockShiftMs`, to that job's client alone.

### Caps

`packages/core/src/caps.ts` is the one table. Each row is a limit, the counter it reads, and the closed code that names its refusal; the counters come from committed rows and a cap check never writes. The window is one rolling day, so no timezone decides when a judge's day ends.

There is no per-address cap. Judges often share one network (a judging room, an office, a VPN exit), and a per-address limit locked them out, so the deployment-wide visitor day is the only limit on `POST /api/demo`. The request's address is still recorded on the visitor row as a digest (`ipKeyOf` in `apps/api/src/server.ts`), which keeps abuse traceable without capping it.

| Code | Limit | Counts | Where it binds |
|---|---|---|---|
| `CAP_VISITORS_DAY` | 50 | visitors created in 24 h, not counting scenario runs' visitors | `POST /api/demo` |
| `CAP_VISITOR_JOBS` | 3 | one visitor's jobs | `OpenJob` |
| `CAP_AMOUNT` | 100000 cents | one job's budget | `OpenJob` |
| `CAP_SPEND_DAY` | 200000 cents | one visitor's job budgets in 24 h | `OpenJob` |
| `CAP_MODEL_RUNS` | 10 | one visitor's verifier runs in 24 h | `Submit` |
| `CAP_MODEL_RUNS_DAY` | 1000 | verifier runs in 24 h (the free tier's day) | `Submit` |
| `CAP_SCENARIOS_DAY` | 100 | scenario starts in 24 h, deployment-wide | each scenario start |
| `CAP_SCENARIOS_REQUESTER_DAY` | 10 | one requester's scenario starts in 24 h | each scenario start |

`POST /api/demo` answers `429 { error }` with the code, and it checks the caps before it forks, so a refused visitor leaves no repository behind. A scenario start checks the two scenario caps before its run visitor forks, and it counts against those caps, never against `CAP_VISITORS_DAY`. A capped command is a `409` with the same `{ outcome: { kind: "DENIED", reason } }` shape every refusal has. The visitor caps bind a visitor's own client only: dev mode's seeded client is the operator's own, and the day-wide run cap binds the whole deployment because the free tier belongs to the key. Attempts per job stay `TERMS.maxAttempts`, which the table already enforced.

### The shared model budget

App model calls (the House runner's deliveries, Ask the ledger's turns) reserve from one deployment-wide budget before anything runs: `model-calls.jsonl` beside the database. The rolling windows admit 19 calls a minute and 999 a day, one short of the provider's own 20/min and 1000/day. A reservation is guarded by a lock file, `model-calls.jsonl.lock`, taken with an exclusive create; the holder writes its owner token into the file, and only that owner's release removes it. There is no stale takeover: a caller that cannot take the lock within its short bounded wait fails closed with `MODEL_BUDGET` (a 429 to API callers, naming the lock path and the recovery command in the detail), never calls uncounted, and never removes a lock it does not own.

Recovery is the operator's: `npm run -s ctl -- model-lock clear` removes a wedged lock once the process recorded in it is no longer alive on this host, refuses a live owner unless `--force` is passed, and prints the path and the outcome.

## Commands

One route carries every user command, matching `Acquit.execute`.

`POST /api/commands` with body `{ key: string, command: UserCommand }`.

- `key` is a client-generated request key (UUID v4). The web app makes one per user intent and reuses it on retry.
- Response `200 { outcome: CommandOutcome }` for `COMMITTED` and `REPLAY`.
- Response `409 { outcome: { kind: "DENIED", reason } }` for a domain refusal.
- Response `400 { error: "BAD_COMMAND", detail }` for a malformed body.

Commands the skeleton must support:

| Actor | `command` |
|---|---|
| CLIENT | `{ type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12, budget: 40000, deliveryEndsAt }` |
| OPERATOR | `{ type: "PlaceBid", jobId, price: 40000, eta: 48, agent, pitch }` (price must be <= budget) |
| CLIENT | `{ type: "AcceptBid", jobId, bidId }` |
| CLIENT | `{ type: "CancelJob", jobId }` |
| OPERATOR | `{ type: "Submit", jobId, sourceCommit }` |
| CLIENT | `{ type: "Approve", jobId, mergeCommit }` |
| CLIENT | `{ type: "Dispute", jobId, mergeCommit, reason }` |

`Approve` names the commit the verifier judged, which `GET /api/jobs/:id` serves as `job.mergeCommit`. A different commit is refused `ARTIFACT_CHANGED`; a job whose review window closed is refused `REVIEW_CLOSED`; the operator who did the work is refused `NOT_OWNER`. The approval selects one release and the job enters `RELEASE_PENDING`. The API drains that release inline with a short bound, so the response usually still shows `VERIFIED` with `phase: "RELEASE_PENDING"` and the job reaches `PAID` once PayPal answers. Approving twice with one request key replays the first result; a second approval is refused `REVIEW_CLOSED`.

`Dispute` names the same judged commit and is refused the same way: a moved head is `ARTIFACT_CHANGED`, a closed window is `REVIEW_CLOSED`, and a stranger is `NOT_OWNER`. It enters `DISPUTED` and stores `resolveBy = now + 48 hours`; the 72-hour review clock pauses, because the row keeps no `endsAt` in `DISPUTED` and the timer index holds `resolveBy`. The arbiter answers with `ResolveDispute` (UPHOLD selects a release with authority `ARBITER_UPHELD`, REFUND selects `ARBITER_REFUND` through the same refund effect, REWORK returns the work to `READY` while a slot and the delivery deadline remain). The skeleton has no staff session, so the arbiter's surface is the development route below.

`OpenJob` returns `PublicResult` kind `JOB`, so the new job id is `outcome.result.job.id`. The seeded House operator `house-tsfix` (agent `house-ts-fixer`) places one House bid at the budget with eta 24 right after `OpenJob` commits, so the client sees two bids once `devon-ops` bids.

A `PlaceBid` the operator cannot afford is refused `INSUFFICIENT_CREDITS`, and that `409` carries the same credit view `GET /api/me/credits` serves so the bid form can say when credits return: `{ outcome: { kind: "DENIED", reason: "INSUFFICIENT_CREDITS" }, credits: CreditAccountView }`.

## Queries

| Method | Path | Response |
|---|---|---|
| GET | `/api/repos` | `{ repos: [{ repository, issues: [{ number, title, suite: { commit, visible, hidden } }] }] }` for the post form. A visitor's own fork replaces the deployment's repository for that session |
| GET | `/api/jobs?status=OPEN` | `{ jobs: JobView[], nextCursor }` |
| GET | `/api/jobs/:id` | `{ job: JobView, handles, now }`. `job.funding` is served to the job's own client alone: the source this job's accept will use, or null when nobody chose for it and the deployment's default applies. `job.clockShiftMs` is that client's own lever too: the total its advances moved the job's instants, 0 on a job nobody advanced, null to every other viewer |
| GET | `/api/me/operator` | `{ operator: OperatorView, agents: [{ id, name, runner }] }` (operators only) |
| GET | `/api/me/credits` | `{ credits: CreditAccountView }` (operators only) |
| GET | `/api/me/escrow` | `{ escrow: [{ jobId, cents }] }`: one row per hold the operator's release will pay, at the operator's net (the price less the 10% operator fee, the amount the release pays). A job whose refund is in flight is left out (operators only) |

Clients see their own jobs and every OPEN job. A query refusal is `403` or `404` with `{ error }`.

Two fields carry a job's commit-then-reveal for its AI-drafted per-job hidden cases. A job whose approved draft froze under a seal serves `job.contract.sealedHiddenCases: { digest }` from freeze on. The digest is sha256 over the salt, a newline, and the canonical JSON of the cases, with object keys in UTF-16 code-unit order. A job that runs a fixture's curated cases alone has no `sealedHiddenCases` key. `job.hiddenReveal` is `null` until the job closes (`PAID`, `REFUNDED`, or `CLOSED`). After close it is `{ cases, salt, digest }` on a sealed job: `cases` are the approved per-job cases (`id`, `target`, `args`, `expected`, with the citation left out), `salt` is the 64-hex salt, and `digest` equals `job.contract.sealedHiddenCases.digest`. Recomputing that digest from `cases` and `salt` must give the same value. A fixture's curated cases never appear in `hiddenReveal`. The same reveal serves on `GET /api/jobs/:id`, on each `GET /api/jobs` entry, and on each operator receipt from `GET /api/me/receipts`. Core resolves it once for all three. Before close, no route serves the cases or the salt. A sealed job whose private file is unreadable, holds no salt, or does not recompute to its digest serves `hiddenReveal: null` and logs a fixed `[reveal]` line that names the job.

## Work repo credentials (operator run and submit)

`acquit run` clones the job's work repo and pushes the agent's commit there, and `acquit submit`
pushes a submitted commit there when the target is that repo, so both ask the API for the credential
rather than reading a GitHub App key on the operator's machine.

`POST /api/jobs/:id/work-repo-token` (operator session only).

- The job must be locked to the calling operator (`job.lockedTo` equals the session's operator id);
  any other caller is refused `403 { error: "NOT_OWNER" }`. A job the caller cannot read answers
  `404 { error: "NOT_FOUND" }` or its query refusal.
- The API mints one GitHub App installation token scoped to exactly the job's work repo: the mint
  names `repositories: ["<client repo name>-<job id>"]` with `contents: write` and `metadata: read`,
  the least privilege a run and submit exercise. A credential handed to one operator cannot push to
  another job's work repo. It answers `200 { repository, token }`; `repository` is the full
  `owner/name` of the job's work repo (`<organization>/<client repo name>-<job id>`), so the CLI
  builds the git URL from it and never guesses a repository. The client repo name is read from the
  repository the job's contract froze, so a visitor's work repo is named after its own fork rather
  than the deployment's repository.
- With the App unconfigured the route answers `503 { error: "GITHUB_NOT_CONFIGURED" }`. GitHub
  answers `422` to the scoped mint while the work repo does not exist yet (the window between funding
  and the outbox creating the fork), and the route answers that as
  `503 { error: "WORK_REPO_NOT_READY", detail }`, the same refusal the CLI already retries for a work
  repo that is not visible. Any other GitHub refusal answers
  `502 { error: "WORK_REPO_TOKEN_FAILED", detail }` with the token redacted.
- The token is never logged. It is a scoped App installation credential that expires within the hour.

## Funding (PayPal sandbox)

1. `AcceptBid` commits, the job enters OPEN FUNDING, and the outbox creates the order. The API drains the outbox inline after the commit, so the order usually exists before the response returns.
2. The payment source is bound per job, chosen before the accept: the job's own stored `funding` (`POST /api/jobs/:id/funding`) wins, and a job nobody chose for funds with the deployment's mode (`/api/dev/fund-mode` in dev, checkout in public). A visitor's job starts on the test card, because a judge holds no sandbox buyer account. The process holds no funding toggle that could reach another job.
3. The web app polls `GET /api/jobs/:id` about once a second until `job.approveUrl` is set, then sends the browser there.
4. The order's return URL is `<webOrigin>/paypal/return?jobId=<id>` and its cancel URL is `<webOrigin>/paypal/cancel?jobId=<id>`. Both are API routes reached through the proxy.
5. `GET /paypal/return` re-reads the order from PayPal, records `BuyerApproved`, captures, records `CaptureCompleted`, and redirects `302` to `/jobs/<id>`. It is idempotent: a second visit redirects without a second capture.
6. `GET /paypal/cancel` redirects `302` to `/jobs/<id>` and leaves the job in FUNDING until the checkout window closes.

A card order is created and captured by the API itself: the test card needs no buyer approval, so the accept usually reaches `IN_PROGRESS` before the response returns. The boundary is sandbox-only (`apiBase` is the sandbox host), which is why the card path is reachable in public mode for a visitor's own job.

When capture completes the job is `IN_PROGRESS`, `escrow: "HELD"`, and `ledger` is `[{ kind: "HELD", cents: 42000, at }]`.

Webhooks are not reachable on localhost, so the skeleton relies on the return route plus `POST /api/dev/tick` (fires `Acquit.tick`, dev only). `POST /paypal/webhook` carries the same facts for a lost answer; it is documented below.

## Webhooks

`POST /paypal/webhook` hands the raw body to `handlePayPalWebhook` unchanged, capped at 65536 bytes (`413 { error: "WEBHOOK_BODY_TOO_LARGE" }` above it). PayPal cannot reach localhost and its event list returned nothing in the probe, so a local delivery is `npm run ctl -- webhook replay --event <recorded id>`, which rebuilds the envelope the route recorded and reposts it, or `npm run ctl -- webhook replay --capture <id> [--new-event-id]`, which builds an envelope that names a real capture (a development control, `ACQUIT_DEV=1`).

The route trusts nothing past the resource id. It parses the envelope at the boundary, re-reads that resource from PayPal, and routes the fact the read carries to the edge that owns it. Nothing in the event body is used as evidence, so a locally built envelope is a real test of the guard.

| `resource_type` | `event_type` prefix | Re-read | Fact |
|---|---|---|---|
| `refund` | `PAYMENT.CAPTURE.REFUND` | `GET /v2/payments/refunds/<id>`, then the capture it names | `REFUND_COMPLETED` |
| `capture` | `PAYMENT.CAPTURE.` | `GET /v2/payments/captures/<id>`, then its order when not refunded | `CAPTURE_COMPLETED` or `REFUND_COMPLETED` |
| `referenced_payouts_item` | `PAYMENT.REFERENCED-PAYOUT` | `GET /v1/payments/referenced-payouts-items/<id>` | `RELEASE_COMPLETED` |
| `payouts_item` | `PAYMENT.PAYOUTS-ITEM` | `GET /v1/payments/payouts-item/<id>`, then its batch | `REIMBURSEMENT_COMPLETED` |

The refund family is read first because a refund event shares capture's `PAYMENT.CAPTURE.` prefix. An event family this deployment does not route is recorded and dropped with `202`.

PayPal signs a delivery with its `paypal-transmission-*` headers. The probe could not verify a signature from a local lane (Appendix A), so the route does not read them: it takes only the resource id from the envelope, and the fact it commits comes from a live read of that resource with this deployment's own credentials. A forged envelope can therefore ask the route to re-read a real fact, which the delivery key and the job state turn into a no-op, and cannot invent one.

The job state is the guard, not the event id. Each fact commits under its own delivery key (`webhook:<edge>:<jobId>:<anchor>`, the anchor being the capture, refund, order, or batch the fact settles), so a redelivery and the same fact under a new event id both reach the same no-op edge and change no version. `webhookOutcomeText` in `packages/core/src/effects.ts` is the one place these phrases are spelled.

The route answers one minimal body to every caller: `202 { received: true }` for a delivery it recorded, and `400 { received: false }` for a body it could not read at all. The answer names no job, no status, and no resource, because the route is unauthenticated and anyone can post to it; the outcome phrase belongs to the envelope row and the API log, and `npm run ctl -- webhook replay` reads it back from there. The log escapes the event id and the provider detail, so neither can carry a newline that forges a second log line. `webhookOutcomeText` in `packages/core/src/effects.ts` is the one place the phrases are spelled.

| Recorded outcome | When |
|---|---|
| `applied` | the re-read fact reached its edge; a fact the job already held is also `applied` and changes no version |
| `no-op, job already <STATUS>` | the job has already moved past this fact |
| `no-op, event type not routed` | an event family this deployment does not route |
| `no-op, no job holds this resource` | no stored job names this resource |
| `no-op, PayPal has not settled this resource` | the provider holds it in a state that is not a job fact |
| `refused, PayPal does not know this capture` | the provider holds no such resource |
| `refused, <provider reason>` | the provider refused the read |
| `refused, unreadable event` | the body is not an event envelope |
| `503 { error: "STORE_BUSY" }` | a transient store lock; PayPal's retry is safe |

Every delivery is recorded as its canonical envelope in `webhook_events` (`id`, `received_at`, `event_type`, `resource_type`, `resource_id`, `outcome`) before the answer, keyed by PayPal's event id, or by the digest of a body that names none. The row is the latest delivery under that id, and it never holds the body: a delivery's bytes can carry payer fields, so the table keeps only the fields the route itself routes on. The table is bounded on insert, to the newest 500 deliveries and to nothing older than 30 days, because the route is unauthenticated and the row must not be a place to park data. Each envelope field is capped at 200 characters; a body that carries a longer one is `400 { received: false }`, the same answer a body that is not an envelope gets. A lane whose table predates the canonical envelope drops it on the next start and keeps the envelopes its route records from then on. A replay rebuilds the envelope from the recorded fields and reposts it, so it exercises the same re-read and the same state guard; the CLI prints the recorded phrase and the event id, and `--json` adds the rebuilt delivery and its byte count.

## Settlement

`Approve` (or the review window closing, or the day-21 capture-age cutoff for verified work) selects a release. The outbox pays the operator's merchant through PayPal's referenced payouts with the deterministic effect key as `PayPal-Request-Id`, re-reads the provider when an answer was lost, and applies `ReleaseSettled` with what the payout observed. The job then shows `status: "PAID"`, `escrow: "RELEASED"`, the three-line ledger (`HELD`, `RELEASED`, `FEE`), and a `receipt` with the frozen and hidden tallies and the paid amount. `GET /api/jobs/:id` serves the receipt as `job.receipt`; the merge of the verified pull request is a separate effect and `job.phase` stays `PAID` when it lands.

A refund (delivery deadline, exhausted attempts, capture mismatch, or the cutoff on unverified work) shows `status: "REFUNDED"`, `escrow: "REFUNDED"`, and the two-line ledger (`HELD`, `REFUND`). PayPal keeps the capture's own fee, so the retained fee a refund reports must equal the fee the job recorded at capture. The retained fee is a treasury line, and the platform pays it back to the operator's merchant as a Standard Payout whose `sender_batch_id` is the effect key and whose merchant and cents must match the owed line. A retained fee, or a payout, that does not match is refused `SETTLEMENT_MISMATCH` and parked for a person instead of being applied. A settlement the provider has not confirmed at the day-21 cutoff raises `SETTLEMENT_UNCONFIRMED_AT_CUTOFF` instead of switching dispositions.

A release or refund whose inline answer was lost settles from the webhook route's re-read of the payout item or refund, so the route is the recovery path for the same edges the outbox dispatches.

The review fields: `job.reviewEndsAt` is the 72-hour deadline while `AWAITING_CLIENT` and null otherwise; `job.viewerCanDispute` is true exactly when the viewer is the owning client and the review is open; `job.dispute` is `{ reason, openedAt, resolveBy }` while `phase` reads `DISPUTED`; `job.releaseAuthority` names what selected the release while it is `RELEASE_PENDING` and on the settled `PAID` row (`CLIENT_APPROVAL`, `REVIEW_SILENCE`, `ARBITER_UPHELD`, `ARBITER_SLA_MISSED`, or `CAPTURE_CUTOFF`), and is null before any release and on a row stored before F4; `job.refundReason` names the reason the refund selected while one is pending (the row's `REFUND_PENDING` phase, or the checkout's refund while an `OPEN` job is `FUNDING`) and on the settled `REFUNDED` row (`DELIVERY_DEADLINE`, `ATTEMPTS_EXHAUSTED`, `ARBITER_REFUND`, `CAPTURE_CUTOFF`, or `CAPTURE_MISMATCH`), and is null before any refund and on a row stored before the reason was recorded. `job.arbiterNote` is the note from the arbiter's last decision (UPHOLD, REFUND, or REWORK). It is null before any arbiter decision and on a row stored before F4, and it stays on the row after the decision, so the page shows it only where that decision still stands.

The paid view carries what a lane and the page read. `job.release` is the observed release evidence: `payoutItemId` names the referenced payout item the capture paid through (`GET /v1/payments/referenced-payouts-items/<item id>`), and `captureId`, `paid`, and `at` are what that item observed. `job.merge` is the merge of the verified pull request, null until `PAID` and then `PENDING`, `MERGED` with `at` and `sha`, or `NEEDS_HUMAN` with the reason. `sha` is GitHub's merge commit, the commit that landed on the base branch, read from the merge answer or the pull's `merge_commit_sha` when the client adopts a merge that already landed; it is not `job.mergeCommit`, which names the tree the verifier judged and the client approved. A row stored before the field existed serves `sha: null`. `job.pullRequest` names the pull. `job.client` names the owning client only to that client's own session and is `null` for every other viewer, and `job.viewerCanApprove` is the API's own answer to whether this session is that client with the review awaiting its approval, so the page gates the control on ownership rather than on role (a window that has already closed is still the edge's `REVIEW_CLOSED` refusal). `job.attempts` counts what the job actually used: a settled job serves the attempts its receipt or history recorded, so a PAID job's `used` is its receipt's `attemptsUsed`.

## Review, disputes, and credits

The 72-hour review window ends with no client action: the timer releases with authority `REVIEW_SILENCE`. A dispute opened inside the window pauses the clock, and the arbiter has 48 hours. A missed arbiter deadline releases with `ARBITER_SLA_MISSED` and raises the `DISPUTE_SLA_MISSED` alert: the effect is a durable outbox row, and the deployment's alert sink receives it. The day-21 capture-age cutoff stays first in `TimerDue`, so a dispute past it releases with `CAPTURE_CUTOFF` and never reports `ARBITER_SLA_MISSED`.

`GET /api/me/credits` serves `{ credits: { available, weeklyAllowance, nextGrantAt } }` for the signed-in operator. The weekly grant runs from `tick` once per ISO week, at that week's first tick at or after Monday 00:00 UTC: allowance = `min(100, 30 + 10 per verified receipt counted when the grant is written)`, keyed `grant:<ISO week>`, with the unspent allowance expired under `expire:<ISO week>`. A Monday the process was down for is caught up by the week's next tick, and a week no tick ran in is never back-filled. A replayed tick appends nothing, and a receipt earned after the week's grant was written never grows that week's allowance. A `PENDING` bid past `bidReviewHours` (72) is returned with `NO_CLIENT_RESPONSE`; a client cancel returns it with `CLIENT_CANCEL`.

## Development controls

Every `/api/dev/` route requires `ACQUIT_DEV=1` on the API process and a development session. Without the flag, the API returns `403 { error: "DEV_DISABLED", detail: "Set ACQUIT_DEV=1 when starting the API." }`. Cross-origin requests still fail the origin check.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/dev/clock` | `{ advanceMs }`, a positive integer of at most 365 days | `{ now }`, the new UTC clock time after due work runs |
| POST | `/api/dev/fund-mode` | `{ mode: "card" \| "checkout" }` | `{ mode }` |
| POST | `/api/dev/tick` | | `{ ok: true }` after due work runs |
| POST | `/api/dev/arbiter` | `{ jobId, verdict: "UPHOLD" \| "REFUND" \| "REWORK", note }` (verdict case-insensitive) | `{ outcome }`, the same shape `/api/commands` answers; `409` for a domain refusal such as `WRONG_STATE` |

`POST /api/dev/arbiter` is the arbiter's surface for the hackathon: it sends the same `ResolveDispute` a staff console will send later, under a fixed development staff id, so the domain edge still guards the role and the `DISPUTED` phase. The client opens the dispute first through `POST /api/commands`; the route cannot create one.

`createAcquit` accepts an optional `Clock` with `now(): Instant`. Production code defaults to wall time. The API development clock adds a process-local offset. Session expiry and PayPal token expiry still use wall time. Restart resets the offset and funding mode.

`ctl clock advance <duration>` accepts `ms`, `s`, `m`, `h`, or `d`. `ctl fund-mode card` selects a sandbox card source for CREATE_ORDER. A completed create first records the order identity, then re-reads PayPal and applies the existing CaptureCompleted edge. It never writes HELD directly. The observed card processing fee can differ from the checkout fee quote.

## Errors

`{ error: string, detail?: string }` with a 4xx or 5xx status. A PayPal outage on the return route redirects to `/jobs/<id>?funding=retry` instead of showing a stack trace.
