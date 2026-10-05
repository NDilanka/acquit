# Acquit HTTP contract (skeleton)

The web app and the API meet only here. The API owns this file. The web app reads it and never imports from `packages/core` at runtime; it may import types from `@acquit/core` (type-only imports).

## Ports and processes

- API: `http://localhost:4310` (env `PORT`).
- Web: `http://localhost:5173` (env `WEB_PORT`). Vite proxies `/api` and `/paypal` to the API, so the browser sees one origin.
- `npm run dev` at the repo root starts both. `npm run seed` resets the SQLite file at `DATABASE_PATH` and loads the seed.

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
3. The order's return URL is `http://localhost:5173/paypal/return?jobId=<id>` and its cancel URL is `http://localhost:5173/paypal/cancel?jobId=<id>`. Both are API routes reached through the proxy.
4. `GET /paypal/return` re-reads the order from PayPal, records `BuyerApproved`, captures, records `CaptureCompleted`, and redirects `302` to `/jobs/<id>`. It is idempotent: a second visit redirects without a second capture.
5. `GET /paypal/cancel` redirects `302` to `/jobs/<id>` and leaves the job in FUNDING until the checkout window closes.

When capture completes the job is `IN_PROGRESS`, `escrow: "HELD"`, and `ledger` is `[{ kind: "HELD", cents: 42000, at }]`.

Webhooks are not reachable on localhost, so the skeleton relies on the return route plus `POST /api/dev/tick` (fires `Acquit.tick`, dev only). `POST /paypal/webhook` exists and calls `handlePayPalWebhook`, for later.

## Errors

`{ error: string, detail?: string }` with a 4xx or 5xx status. A PayPal outage on the return route redirects to `/jobs/<id>?funding=retry` instead of showing a stack trace.
