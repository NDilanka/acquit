# Acquit core domain sketch

This is a sketch only. Every function body throws `not implemented`. Nothing here is implemented. The human approved this design on 2026-10-05.

## Problem

Acquit must move one escrow to exactly one disposition while five actors write to the same job. Clients click buttons. Operators submit from the CLI. PayPal webhooks repeat, sometimes with new event IDs. The verifier CI can crash or time out. Timers fire late or twice. The money rules must hold under every replay and crash. A paid job has RELEASED plus FEE equal to HELD. A refunded job has REFUND equal to HELD. No job has both. Escrow pays only the accepted operator.

The sandbox evidence adds constraints the brief does not state.

- A delayed-disbursement order names its payee when it is created (`scratch/paypal-escrow/run2.log`).
- Release takes a capture ID and no amount.
- Order creation fails until the operator finishes Partner Referrals.
- PayPal takes its processing fee out of the payee's share. It was 15.15 on each of three 420.00 captures.
- Sending `platform_fees` 44.85 instead of 60.00 paid the operator exactly 360.00 (`run6.log`).
- A refund naming `platform_fees` fails with `PLATFORM_FEE_NOT_ENABLED`. A plain full refund works.
- After a full refund, the operator's balance was 15.15 lower than before the job. PayPal keeps its fee and takes it from the operator.
- Held funds auto-disburse after 28 days.
- Event-ID dedupe alone paid twice.
- An in-process verifier can be fooled by `expect.extend` (`scratch/verifier/RESULT.md`).
- A GET on an order returned a transient 503 during polling.

The first constraint breaks the tutorial's order. The tutorial funds escrow before any bid exists, but PayPal needs the payee at order creation. This sketch moves funding into Accept.

## Usage (caller's view)

Callers import one package entry. They never import the table, the ledger, or the PayPal adapter.

```json
{ "name": "@acquit/core", "exports": { ".": "./src/acquit.ts" } }
```

The API handles **Accept** with one command. The response carries the PayPal checkout link.

```ts
import { parseBidId, parseJobId, parseRequestKey, type Acquit } from "@acquit/core";

export async function acceptBid(acquit: Acquit, req: AuthedRequest): Promise<Response> {
	const outcome = await acquit.execute(req.actor, parseRequestKey(req.header("Idempotency-Key")), {
		type: "AcceptBid",
		jobId: parseJobId(req.params.job),
		bidId: parseBidId(req.params.bid),
	});
	if (outcome.kind === "DENIED" || outcome.result.kind !== "JOB") return Response.json(outcome, { status: 409 });
	// status "OPEN", phase "FUNDING". approveUrl is null only if PayPal was slow. The page then polls query.
	return Response.json({ approveUrl: outcome.result.job.approveUrl, phase: outcome.result.job.phase });
}
```

The CLI's `acquit submit` posts a commit to the API, which calls `execute` with `Submit`. The CLI then reads the job until the attempt is judged.

```ts
const sent = await api.execute({ type: "Submit", jobId, sourceCommit: await git.headSha() });
for (;;) {
	const { job } = await api.query({ type: "Job", jobId });
	if (job.phase !== "VERIFYING") return printVerdict(job); // "REJECTED ... Attempts left: 2" or "VERIFIED ... 72 hours"
	await sleep(2_000);
}
```

The PayPal webhook route is one line. Signature checks, resource re-reads, routing, and replay safety live behind it.

```ts
export const POST = (request: Request) => acquit.handlePayPalWebhook(request);
```

The timer worker is one loop. `tick` fires due job clocks and the weekly credit grant, then drains the outbox.

```ts
setInterval(() => void acquit.tick(), 30_000);
```

Every tutorial transition maps to one table edge in `packages/core/src/job.ts`.

| Tutorial step | Caller | Command | Edge |
| --- | --- | --- | --- |
| Open job | API | `OpenJob` | none to OPEN BIDDING. No ledger line. |
| `acquit bid` | CLI via API | `PlaceBid` | OPEN BIDDING to OPEN BIDDING. Spend 10 credits (30 to 20) in the same commit. |
| House bid appears | House runner via API | `PlaceBid` (HOUSE) | OPEN BIDDING to OPEN BIDDING. No credits. At most one per job. |
| Accept on devon-ops (opens checkout) | API | `AcceptBid` | OPEN BIDDING to OPEN FUNDING CREATING_ORDER. The order names devon-ops as payee. |
| Checkout link ready | outbox | `OrderCreated` | FUNDING CREATING_ORDER to AWAITING_APPROVAL |
| Pay with PayPal sandbox | webhook or return URL | `BuyerApproved` | AWAITING_APPROVAL to CAPTURING |
| Escrow HELD, locked to devon-ops | outbox | `CaptureCompleted` | OPEN FUNDING to IN_PROGRESS READY. HELD 420.00. |
| `acquit run`, `acquit diff` | CLI only | none | no edge |
| `acquit submit`, attempt 1 | CLI via API | `Submit` | IN_PROGRESS READY to VERIFYING (1 of 3) |
| Verifier REJECTED | verifier callback | `VerifierFinished` | VERIFYING to READY. Escrow stays HELD. |
| `acquit submit`, attempt 2 | CLI via API | `Submit` | READY to VERIFYING (2 of 3) |
| Verifier VERIFIED, PR #13 opened | verifier callback | `VerifierFinished` | IN_PROGRESS to VERIFIED AWAITING_CLIENT. Review ends in 72h. |
| Approve and release | API | `Approve` | VERIFIED AWAITING_CLIENT to RELEASE_PENDING |
| Status PAID, receipt | outbox or webhook | `ReleaseSettled` | VERIFIED to PAID. RELEASED 360.00, FEE 60.00, receipt. |
| PR merged | outbox | `MergeFinished` | PAID merge PENDING to MERGED |
| `acquit receipts` | CLI via API | query | no edge |
| If a job fails | timer or verifier | `TimerDue` or `VerifierFinished` (slot 3) | to REFUND_PENDING, then `RefundSettled` to REFUNDED |

`execute` dispatches the outbox rows its own commit created, inline with a short bound, before it returns. That is why Accept usually returns the approve URL and Approve usually returns PAID. If PayPal is slow, the same rows finish on the next `tick`.

## Shape

**Module map.** A reader traces any rule from `acquit.ts` to `job.ts` to one leaf, so three files at most.

- `acquit.ts` is the public entry. It holds `Acquit`, `createAcquit`, the command, query, and view types, and re-exports the parsers callers need.
- `job.ts` owns the job row, the `JobState` union, the private transition table, wake times, bid ranking, and the view projection. It is pure.
- `ledger.ts` owns cents, the escrow book, the three laws, the commercial split, and treasury entries. It is pure and mirrors `ledger.bend`.
- `credits.ts` owns bid credits with their own `Credits` brand. It is pure.
- `operator.ts` owns payout onboarding and agents. `PlaceBid` reads it.
- `effects.ts` is the impure shell. It holds request keys, the atomic commit, the outbox, reconciliation, webhook and verifier ingestion, and the timer scan.
- `paypal.ts` is the adapter. It holds the fee quote, wire parsing, auth assertions, and host normalization.
- `verifier.ts` holds the `Verdict` the core consumes and the judge and subject protocol that runs on CI.
- `ids.ts` holds brands shared by every module.

**Data first.** One versioned `JobRow` holds the contract, the bids, and one `JobState`. User-facing statuses are OPEN, IN_PROGRESS, VERIFIED, PAID, REFUNDED, and CLOSED. Typed substates carry the rest. OPEN has BIDDING and FUNDING. FUNDING has a `Checkout` with CREATING_ORDER, AWAITING_APPROVAL, CAPTURING, and REFUND_PENDING. IN_PROGRESS has READY, VERIFYING, and REFUND_PENDING. VERIFIED has a `Review` with AWAITING_CLIENT, DISPUTED, RELEASE_PENDING, and REFUND_PENDING. Each pending disposition lives in exactly one substate, so a release and a refund cannot both be selected. Per model-the-domain, the state union replaces flags such as `funded` or `disputed`.

**Money in types.** `HeldEscrow` exists only from capture on. It contains the `LockedBid` whose merchant the order named. "Locked to devon-ops" is a PayPal fact and a type, not a field to keep in sync. The book is a tuple union of `EmptyBook`, `HeldBook`, `PaidBook`, and `RefundedBook`. No book type holds both RELEASED and REFUND. `reduceLedger` is overloaded so a release can only be applied to a held book. `Receipt` carries a module-private brand, and only the `ReleaseSettled` edge builds one. Per type-system-discipline, cents, credits, request keys, and PayPal resource IDs are distinct brands.

**One table.** `transitionTable` declares every edge with its payload, its before and after states, and the role allowed to call it. `UserCommand` derives from the edges whose role is not SYSTEM. A system edge cannot be sent through `execute`, and the typecheck proves it. Adding an edge adds its command, so there is no hand-synced command list.

**Idempotence.** Per make-operations-idempotent, three mechanisms cover replay and crash. Request keys bind to a payload digest, so a retried click replays its result and a reused key with a new body is refused. Row-version compare-and-set arbitrates concurrent writers. Effects go to a durable outbox in the same commit as the state change. Each effect key is deterministic from the job and effect kind, plus the round or run where one job has several. The same key is the `PayPal-Request-Id`. A worker leases a row, reconciles any earlier uncertain call by correlation, and dispatches only when PayPal shows nothing. Reads retry transient 5xx responses before reporting UNKNOWN. An uncertain release never becomes a refund, and the reverse holds too. A webhook with a new event ID for an applied capture reaches a no-op edge. The state is the guard, not the event ID.

**Capture-age watchdog.** `HeldEscrow.cutoffAt` is capture time plus 21 days. `TimerDue` checks it first in every state. Unverified work refunds. Verified work, including an undecided dispute, releases. A pending settlement raises an alert and keeps reconciling, never switching sides. The worst case from capture is delivery 14 days, review 72 hours, and dispute 48 hours, so day 19. Day 21 leaves a week to reconcile before PayPal's day 28.

**Boundaries.** Per boundary-discipline, `paypal.ts` parses PayPal JSON into `CaptureEvidence`, `ReleaseEvidence`, and `RefundEvidence`. `verifier.ts` parses the judge's signed report into a `Verdict`. The table sees only those types. Credits and cents never meet, because their reducers take different brands.

**Interface depth.** The public surface is five methods on `Acquit` plus a config. Behind them sit authorization, credit charging, fee quoting, the state machine, ledger laws, receipts, the outbox, reconciliation, the watchdog, and the weekly grant. A caller never sequences "change state, then call PayPal". Per laziness-protocol, the interface is no larger than the four call sites above need.

**What it does not do.** No partial refunds. No release amount. No bounty mode. No mid-week credit top-up. No Bend2 in the request path. No credit purchase command yet, though the reducer has the line.

## Synthesis decision

**Base.** Candidate 2 (pv-sol-xhigh). It had the single versioned owner, the typed substates, one private transition table, `execute` and `query`, payload-digest request keys, an outbox with lease, reconcile before redispatch, and the rule that an uncertain outcome never authorizes the opposite disposition. Those carry over unchanged in meaning. Its 860-line single file was split into the module map above.

**Grafts from candidate 1 (pv-opus-medium).**

- Seller-first checkout. Funding moves to `AcceptBid`, a FUNDING substate waits for approval and capture, and an abandoned checkout returns to bidding.
- One House bid per job, House costing 0 credits, and House as an ordinary onboarded operator row.
- Bid ranking as separate `{ operators, house }` sections. `house` is `Bid | null`, so the one-per-job rule shows in the view type too.
- The tutorial-step to edge mapping table, updated to this machine.
- The judge and subject protocol, the static screen for test-framework imports in source, and fail-closed reply parsing.
- Deterministic effect keys derived from the job, never random (also in candidate 3).

**Grafts from candidate 3 (pv-grok-high).**

- The small pure ledger. `checkLaws` mirrors `close()` in `ledger.bend`, and `commercialSplit` holds the 5% and 10% terms.
- The small pure credit reducer with its own unit brand.
- The capture-age watchdog that forces settlement before PayPal's auto-disburse.

**Rejected.**

- Candidate 2's `UnassignedFundingRoute` and its funded-first branch. PayPal names the payee at order creation, so the route can never be built.
- Candidate 2's House bids at 10 credits and its time-only bid order. Charging House its own currency limits nothing.
- Candidate 2's refund of an undecided dispute at the cutoff. Release was chosen, because the verifier already passed.
- Candidate 1's event log as the store. A snapshot row with a version gives the same money guard with less to read.
- Candidate 1's rule that a running attempt defers the deadline refund indefinitely. Here a run is bounded by `VERIFIER_RUN_MINUTES`.
- Candidate 1's mid-week receipt bonus. Keeping only the weekly grant leaves one way to add allowance.
- Candidate 1's 25-day hard stop. Day 21 leaves room to reconcile.
- Candidate 3's two state machines meeting at a boundary module. Money and work facts on one row need one writer.
- Candidate 3's post-capture payee lock. It contradicts the measured fact that the payee is named at order creation.
- Candidate 3's FUNDED status, its price-first sort, and its credit return on lost bids.

**Cross-judge verdict.** pv-sol-xhigh scored candidate 1 at 21, candidate 2 at 26, and candidate 3 at 11 out of 30. It recommended the grafts above. That judge shares a model family with candidate 2, so its preference for candidate 2 is a lean, not independent confirmation. The parent picked the same base for a separate reason. A versioned row with an outbox is less machinery for one developer in five weeks than an event store.

## The six roadmap questions

**1. The 72-hour review window ends with no client action.** The job releases with authority REVIEW_SILENCE. The verifier already passed against the frozen contract, and silence cannot hold an operator's pay forever. A dispute opened inside the window pauses the clock. The arbiter has 48 hours. If the arbiter misses that deadline, the job releases with authority ARBITER_SLA_MISSED and raises an alert. The verifier passed, so a late arbiter is Acquit's failure, and the operator should not wait for it. The capture-age cutoff at day 21 stays as the last guard.

**2. Whether House bids spend credits.** No. Credits stop operators from flooding clients, and charging Acquit its own currency limits nothing. The flood guard for House is structural instead. A job admits at most one House bid (`HOUSE_ALREADY_BID`).

**3. Whether House bids sort first.** No. `rankBids` returns independent operators first, by paid receipts and then by bid time. House sits in its own section below them, labeled as the quality bar. Because the return type has sections, a UI change cannot sort House to the top by accident. The tutorial already shows devon-ops above House.

**4. How assertions run outside the submitted code's process.** Hidden tests are data. Each has a target export, arguments, and an expected value. The judge process on CI holds them and never imports submitted code. A credential-free subject container with no network runs the submitted tree. It receives `SubjectCall` values, which have no `expected` field, over a bounded RPC, and returns raw results. The judge compares results in its own runtime, so a replaced matcher can only lie to itself. A static screen rejects any source file that imports vitest, `expect`, or `node:test`. A diff touching a protected path is rejected before either process starts. All 54 required test IDs must complete. A missing, duplicate, or malformed reply counts as missing, and missing is REJECTED. This is designed, not yet measured against the `cheat-assertion` branch.

**5. Who pays PayPal's processing fee.** Acquit absorbs it. At accept, `quote()` predicts 3.49% of 420.00 plus 0.49, which is 15.15. The order sends `platform_fees` 44.85, so the operator nets 360.00 and the client pays 420.00. This was measured. The sandbox paid the operator exactly 360.00 with that instruction (`scratch/paypal-escrow/run6.log`). The rate itself is inferred from three captures of the same amount. The ledger still shows RELEASED 360.00 and FEE 60.00, with FEE broken down as PayPal processing 15.15 and Acquit 44.85. If the observed fee differs, RELEASED records the observed net and the laws still hold. The difference becomes a `PROCESSOR_FEE_VARIANCE` treasury entry. If the net falls below the promised 360.00, Acquit owes the operator the shortfall (`OPERATOR_REIMBURSEMENT_OWED`).

**6. Who covers the fee PayPal keeps on a refund.** Acquit covers it. The client gets 420.00 back, so REFUND equals HELD. The refund call never names `platform_fees`. The sandbox showed PayPal keeps its 15.15 and takes it from the operator. The operator balance was 15.15 lower after a released job plus a refunded job than the release alone explains. So every refund writes `REFUND_FEE_RETAINED` and an equal `OPERATOR_REIMBURSEMENT_OWED`, and Acquit pays the operator back. Funding at accept makes refunds rarer, because a cancel before capture moves no money.

## Tutorial changes this design needs

Approved on 2026-10-05 and applied to `docs/tutorial.md`, together with CLOSED as the sixth status and release when the arbiter misses its deadline.

1. In the intro, change "we post a bug from GitHub and fund the escrow" to "we post a bug from GitHub, accept a bid, and fund the escrow".
2. Delete the "Fund the escrow" section from "Post the job as the client". The job opens with status OPEN and no ledger line.
3. In "Accept a bid as the client", change step 1 to "Click **Accept** on the `devon-ops` bid." Change step 2 to "Pay with your PayPal sandbox Personal account." Move the checkout block (400.00 job, 20.00 escrow fee, 420.00 total) here. Add "Acquit creates a PayPal order that can pay only `devon-ops`."
4. Move the first ledger line after the payment and change its time to after the bid, for example `2026-11-01 11:12  job_7Q2K  HELD  420.00 USD  client payment (400.00 job + 20.00 escrow fee)`. The 10:04 time goes away. Use the same new time in the final three-line ledger.
5. Change the FEE line to `60.00 USD  fees (15.15 PayPal processing + 44.85 Acquit)`. Change "Acquit kept $60" to "Acquit kept $44.85 after paying PayPal's $15.15 processing fee."
6. Under "Client review window: 72 hours", add "If you do nothing for 72 hours, Acquit releases the payment. To stop that, open a dispute."
7. Change "Weekly bid credits: 40 (30 + 10 for 1 receipt)" to "Weekly bid credits: 40 from Monday (30 + 10 for 1 receipt)". The balance does not grow mid-week.
8. In "If a job fails", add "A cancel before you pay costs nothing, because no money has moved."
9. Optional. Label the House row "House (quality bar): tsfix".

## Tradeoffs accepted

- We accept a tutorial rewrite in exchange for an escrow that PayPal itself locks to one payee.
- We accept listing unfunded jobs in exchange for that lock. Unanswered bids get their credits back after 72 hours, which bounds the drain.
- We accept a sixth status, CLOSED, in exchange for never calling a job REFUNDED when no money was held.
- We accept that a verifier run timing out after the deadline refunds the client, in exchange for a deadline that a hung run cannot push back more than 30 minutes. Before the deadline, a timeout gives the slot back.
- We accept that bids live on the job row, so concurrent bids retry on version conflict, in exchange for one writer per job.
- We accept a three-hour checkout window in exchange for a chosen operator who is not held hostage by an abandoned checkout.
- We accept that Acquit's net take moves by a few cents with PayPal's real fee in exchange for exact tutorial numbers.
- We accept that a dispute the arbiter does not decide within 48 hours releases to the operator, in exchange for operators never waiting on Acquit's own delay.
- We accept a 15.15 cost to Acquit on every refund in exchange for operators never losing money on a job that did not pay them.

## Alternatives considered

- **Event-sourced job log with the outbox derived from it.** It hides drift between status, ledger, and outbox, but every read folds events and every reader must learn the event vocabulary. The versioned row hides the same money rules behind a smaller surface.
- **Separate money and work owners that exchange commands.** It hides PayPal from the work code, but the receipt, the disposition, and the deadline then span two writers. Callers and maintainers must learn which side owns each rule.
- **Fund at open with Acquit as payee, then pay operators by standard payouts.** It keeps the tutorial order, but it drops the measured delayed-disbursement flow, makes Acquit hold client funds, and turns every pre-accept cancel into a refund that loses PayPal's fee.

## Open questions and risks

- Can a sandbox run confirm that the payee cannot change after order creation? It is inferred from the request shape.
- Does PayPal honor `PayPal-Request-Id` on referenced payouts and refunds, and for how long? Reconcile by lookup is the fallback either way.
- How does Acquit pay the refund reimbursement to the operator? A Standard Payout from the platform account is the likely path. It is not built or measured.
- Will every job's hidden tests target exported functions, a CLI, or HTTP, so they always cross a process boundary?
- Is three hours right for checkout, given PayPal approval links expire on their own schedule (not measured)?

## Next implementation step

Implement `ledger.ts` and `credits.ts`, then the `job.ts` table, with a test that replays the tutorial's commands and asserts the literal ledger lines HELD 42000, RELEASED 36000, and FEE 6000 with processor 1515 and Acquit 4485.
