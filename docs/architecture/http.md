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
| GET | `/api/session` | | `{ user: { handle, role: "CLIENT" \| "OPERATOR" } \| null }` |
| POST | `/api/session` | `{ handle: "maya-client" \| "devon-ops" }` | `{ user, token }` and the cookie |
| DELETE | `/api/session` | | `204` |
| GET | `/api/users` | | `{ users: [{ handle, role }] }` for the picker |

Every other `/api` route returns `401 { error: "UNAUTHENTICATED" }` without a session.

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

`Approve` names the commit the verifier judged, which `GET /api/jobs/:id` serves as `job.mergeCommit`. A different commit is refused `ARTIFACT_CHANGED`; a job whose review window closed is refused `REVIEW_CLOSED`; the operator who did the work is refused `NOT_OWNER`. The approval selects one release and the job enters `RELEASE_PENDING`. The API drains that release inline with a short bound, so the response usually still shows `VERIFIED` with `phase: "RELEASE_PENDING"` and the job reaches `PAID` once PayPal answers. Approving twice with one request key replays the first result; a second approval is refused `REVIEW_CLOSED`.

`OpenJob` returns `PublicResult` kind `JOB`, so the new job id is `outcome.result.job.id`. The seeded House operator `house-tsfix` (agent `house-ts-fixer`) places one House bid at the budget with eta 24 right after `OpenJob` commits, so the client sees two bids once `devon-ops` bids.

## Queries

| Method | Path | Response |
|---|---|---|
| GET | `/api/repos` | `{ repos: [{ repository, issues: [{ number, title, suite: { commit, visible, hidden } }] }] }` for the post form |
| GET | `/api/jobs?status=OPEN` | `{ jobs: JobView[], nextCursor }` |
| GET | `/api/jobs/:id` | `{ job: JobView }` |
| GET | `/api/me/operator` | `{ operator: OperatorView, agents: [{ id, name, runner }] }` (operators only) |
| GET | `/api/me/credits` | `{ credits: CreditAccountView }` (operators only) |

Clients see their own jobs and every OPEN job. A query refusal is `403` or `404` with `{ error }`.

## Funding (PayPal sandbox)

1. `AcceptBid` commits, the job enters OPEN FUNDING, and the outbox creates the order. The API drains the outbox inline after the commit, so the order usually exists before the response returns.
2. The web app polls `GET /api/jobs/:id` about once a second until `job.approveUrl` is set, then sends the browser there.
3. The order's return URL is `<webOrigin>/paypal/return?jobId=<id>` and its cancel URL is `<webOrigin>/paypal/cancel?jobId=<id>`. Both are API routes reached through the proxy.
4. `GET /paypal/return` re-reads the order from PayPal, records `BuyerApproved`, captures, records `CaptureCompleted`, and redirects `302` to `/jobs/<id>`. It is idempotent: a second visit redirects without a second capture.
5. `GET /paypal/cancel` redirects `302` to `/jobs/<id>` and leaves the job in FUNDING until the checkout window closes.

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

The route answers one minimal body to every caller: `202 { received: true }` for a delivery it recorded, and `400 { received: false }` for a body it could not read at all. The answer names no job, no status, and no resource, because the route is unauthenticated and anyone can post to it; the outcome phrase belongs to the envelope row and the API log, and `npm run ctl -- webhook replay` reads it back from there. `webhookOutcomeText` in `packages/core/src/effects.ts` is the one place the phrases are spelled.

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

Every delivery is recorded as its canonical envelope in `webhook_events` (`id`, `received_at`, `event_type`, `resource_type`, `resource_id`, `outcome`) before the answer, keyed by PayPal's event id, or by the digest of a body that names none. The row is the latest delivery under that id, and it never holds the body: a delivery's bytes can carry payer fields, so the table keeps only the fields the route itself routes on. The table is bounded on insert, to the newest 500 deliveries and to nothing older than 30 days, because the route is unauthenticated and the row must not be a place to park data. A lane whose table predates the canonical envelope drops it on the next start and keeps the envelopes its route records from then on. A replay rebuilds the envelope from the recorded fields and reposts it, so it exercises the same re-read and the same state guard; the CLI prints the recorded phrase and the event id, and `--json` adds the rebuilt delivery and its byte count.

## Settlement

`Approve` (or the review window closing, or the day-21 capture-age cutoff for verified work) selects a release. The outbox pays the operator's merchant through PayPal's referenced payouts with the deterministic effect key as `PayPal-Request-Id`, re-reads the provider when an answer was lost, and applies `ReleaseSettled` with what the payout observed. The job then shows `status: "PAID"`, `escrow: "RELEASED"`, the three-line ledger (`HELD`, `RELEASED`, `FEE`), and a `receipt` with the frozen and hidden tallies and the paid amount. `GET /api/jobs/:id` serves the receipt as `job.receipt`; the merge of the verified pull request is a separate effect and `job.phase` stays `PAID` when it lands.

A refund (delivery deadline, exhausted attempts, capture mismatch, or the cutoff on unverified work) shows `status: "REFUNDED"`, `escrow: "REFUNDED"`, and the two-line ledger (`HELD`, `REFUND`). The retained PayPal fee is a treasury line, and the platform pays it back to the operator's merchant as a Standard Payout whose `sender_batch_id` is the effect key. A settlement the provider has not confirmed at the day-21 cutoff raises `SETTLEMENT_UNCONFIRMED_AT_CUTOFF` instead of switching dispositions.

A release or refund whose inline answer was lost settles from the webhook route's re-read of the payout item or refund, so the route is the recovery path for the same edges the outbox dispatches.

The paid view carries what a lane and the page read. `job.release` is the observed release evidence: `payoutItemId` names the referenced payout item the capture paid through (`GET /v1/payments/referenced-payouts-items/<item id>`), and `captureId`, `paid`, and `at` are what that item observed. `job.merge` is the merge of the verified pull request, null until `PAID` and then `PENDING`, `MERGED` with `at` (`job.pullRequest` and `job.mergeCommit` name the pull and the tree that landed), or `NEEDS_HUMAN` with the reason. `job.client` names the owning client, and `job.viewerCanApprove` is the API's own answer to whether this session is that client with the review awaiting its approval, so the page gates the control on ownership rather than on role (a window that has already closed is still the edge's `REVIEW_CLOSED` refusal). `job.attempts` counts what the job actually used: a settled job serves the attempts its receipt or history recorded, so a PAID job's `used` is its receipt's `attemptsUsed`.

## Development controls

Every `/api/dev/` route requires `ACQUIT_DEV=1` on the API process and a development session. Without the flag, the API returns `403 { error: "DEV_DISABLED", detail: "Set ACQUIT_DEV=1 when starting the API." }`. Cross-origin requests still fail the origin check.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/dev/clock` | `{ advanceMs }`, a positive integer of at most 365 days | `{ now }`, the new UTC clock time after due work runs |
| POST | `/api/dev/fund-mode` | `{ mode: "card" \| "checkout" }` | `{ mode }` |
| POST | `/api/dev/tick` | | `{ ok: true }` after due work runs |

`createAcquit` accepts an optional `Clock` with `now(): Instant`. Production code defaults to wall time. The API development clock adds a process-local offset. Session expiry and PayPal token expiry still use wall time. Restart resets the offset and funding mode.

`ctl clock advance <duration>` accepts `ms`, `s`, `m`, `h`, or `d`. `ctl fund-mode card` selects a sandbox card source for CREATE_ORDER. A completed create first records the order identity, then re-reads PayPal and applies the existing CaptureCompleted edge. It never writes HELD directly. The observed card processing fee can differ from the checkout fee quote.

## Errors

`{ error: string, detail?: string }` with a 4xx or 5xx status. A PayPal outage on the return route redirects to `/jobs/<id>?funding=retry` instead of showing a stack trace.
