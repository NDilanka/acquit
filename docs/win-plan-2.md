# Acquit lead plan, 2026-10-15 to 2026-11-12

`docs/win-plan.md` got Acquit built. Every code item in it has landed (F6, F7, J1, K1, H2, P1, M1, A1, A2, A3, G1, B2, R1, S1, C0), and the hosted demo runs at https://80-225-220-230.sslip.io. This plan is about winning, not finishing. It was written on 2026-10-15, with 28 days to the deadline and 22 days to the video freeze. It draws on a read of the PayPal Developer Discord, the public repos and Devpost pages of every rival found, the installed `ag-studio@3.0.0` and `@paypal/agent-toolkit` types, and a code map of where Acquit assumes code.

It has two parts.

- **Part A** is product work for future build sessions. Each item is one PR or one task with an id, a reason, a scope, a proof, an effort in build-days, and a deadline.
- **Part B** is the operator's own work: the video, public posts, Devpost, buyers, and the VM.

The goal is unchanged: 1st place ($12,000) plus Best Use of AG Grid 1st ($5,000). 2nd ($8,000) and 3rd ($5,000) place exist too, which `docs/win-plan.md` section 3 missed.

## 0. Dates that bind

| Date | What |
| --- | --- |
| 2026-10-16 after 13:18Z | `ctl sweep` on the VM is due (expired visitors and their forks). |
| 2026-10-19 | Video rough cut V2 exists, even with gaps (Part B). |
| 2026-10-23 | Print Twin gate 1 (A5.2). Fail means the print vertical becomes a "Next" card. |
| 2026-10-30 | Print Twin gate 2. Studio moat (A1) is on the hosted demo. |
| 2026-11-06 | Feature freeze on the demo path. Final video uploaded, public, under 3:00. |
| 2026-11-09 | Devpost draft complete with every field. |
| 2026-11-10 | Submit. |
| 2026-11-12 12:00 PT | Submissions close (15:00 EST, per Devpost). |
| 2026-12-15 | Judging ends. The demo, sandbox app, and model key stay alive until then. |

## 1. What changed since win-plan.md

### 1.1 The field

Seven projects matter. Full notes are in `scratch/plan-research/competitors.md` and `scratch/discord-read/threat-report.md` (both local only, `scratch/` is gitignored).

| Rival | Threat to | Strong | Gap Acquit exploits |
| --- | --- | --- | --- |
| Stood + Yard | 1st to 3rd, PayPal + AI | Same thesis (frozen signed tests, refuse on change). v0.15.0, about 950 tests, live sandbox capture and void, a guide for every sponsor, posts every 1 to 2 days. | Tests are visible, so a builder can overfit. No hidden tests. AI is mostly unwired. No AG Studio. Builder payouts are a separate Payouts call. Yard needs an access code. No video, no Devpost page yet. |
| Bursar | 1st to 3rd, Agentic Commerce, Best Demo, AG Grid | 2,200+ tests, Vault, authorize and capture, MCP gateway, AG Studio with six custom widgets, a polished 2:49 video. | Its own README says a scripted model drives the demo and the Treasurer. It controls spend, not work, in a crowded category. |
| PACT | 1st to 3rd, AG Grid | Already submitted. 2,700+ tests, 28 Playwright tests, Vault, an AG Studio auditor agent. | Seller payouts are "next". No hidden tests. Partly an LLM verifier. |
| SarafuPay | AG Grid 1st, Most Impactful | Already submitted, live on real WhatsApp. AG Studio with a custom Treasurer agent that delegates to built-ins, the same pattern as Ask the ledger. AG Grid staff publicly friendly. | Standard Studio use (KPIs, charts). One e2e test file. No escrow. Quiet since 10-08. |
| OutcomePay | Innovation | Nearly the same pitch: "AI agents buy results, settled by PayPal". | Payouts are a simulated ledger. LLM verification. A test-harness UI. |
| Proven | AG Grid, Most Impactful | Donations held until delivery is proven, AG Grid reviewer queue, pinned totals that conserve. | No public code. Human proof of delivery. |
| MergePay | low | Same audience (GitHub issue bounties). | No escrow, an LLM judge, inactive since 10-05, video not on YouTube. |

What only Acquit has, today:
1. Hidden tests the worker never sees, drafted per job by AI and approved by the client.
2. The platform fee taken inside the PayPal payment (`platform_fees`), with the seller paid by a referenced payout to a Partner Referrals merchant. Every rival either pays one account or simulates the payout.
3. A House agent doing real work on a live model in the hosted demo.

### 1.2 The gaps that now cost us the most

1. **No video, no Devpost page, no public posts since 10-08.** SarafuPay, Bursar and PACT each have all three. Presentation is a fifth of every score, and Best Demo is its own prize.
2. **AG Studio is wired to an empty data source.** `apps/web/src/studio-source.ts` gives Studio one source with `data: []`, kept only so the canvas mounts. Every widget is a custom React component. Studio's data engine, the built-in Data agent, cross-filtering, native pivot and funnel widgets, relationships, and expressions all do nothing. The AG Grid and PayPal webinar on 10-14 spent most of its time on those features. Next to SarafuPay, Acquit's Studio looks equal at best.
3. **AG Grid is Community only.** No grouping, master-detail, sparklines, or pinned totals. Proven already has a grouped reviewer queue with pinned totals.
4. **The novelty claim is diluted.** OutcomePay and PACT say "verified outcomes" too. The words alone no longer win Innovation. The proof must be visible: hidden tests, a real three-party payout, and a second outcome type that really runs.
5. **"Pluggable" is still forbidden.** The job core is code-shaped end to end (section A5.1). The registry card in the video says "next" for every other outcome. A second vertical that runs through one interface turns the concept into a fact.
6. **Test count is invisible.** Rivals advertise 800 to 2,700 tests. Acquit has no CI badge or count in the README.

## 2. The strategy in three bets

Every Part A item serves one of these. The video and the Devpost page tell them in this order.

1. **Proof that cannot be gamed.** The verifier is the moat. Make it adversarial on screen: one agent edits a test and is refused, and one agent passes the visible tests but fails the hidden ones and is refused. Publish a score card of the cheats the verifier catches. Prove the hidden tests existed before the work began (commit then reveal).
2. **Money PayPal can audit.** Every number on the dashboard traces to a ledger row, the live PayPal object behind it, and the verifier receipt. Disputes are answered with the receipt as evidence. The three-party trail (client pays, platform keeps its fee, seller is paid) is shown with PayPal transaction ids.
3. **Outcomes, plural.** The same escrow and receipt rules pay for a second kind of outcome, verified 3D prints, through one plugin interface. Sellers attach autonomous pipelines, and the platform qualifies them before they may bid.

Lines to use everywhere, so we stop sounding like OutcomePay:
- "The agent never sees the tests that decide whether it gets paid."
- "A model can be talked into approving. A hidden test cannot."
- "Every number on this dashboard opens to the PayPal record behind it."
- "Same escrow, second outcome. Cleared, then paid."

Do not say "tamper-proof", "pluggable" (until A5.1 lands), or "supported" for any outcome that is not live. Do not name rivals in public posts or the video.

---

# Part A. Product work

Rules for every item, carried over from `docs/plan.md` and `docs/win-plan.md`:
- One PR per item on a `mission/*` branch, `fix:`/`feat:`/`docs:` commits, review before merge.
- A PR that moves money, judges work, or opens the public surface runs the full live lanes. Display-only PRs run three lanes plus screenshots.
- Anything simulated is labeled "Simulated" in the UI and the video. An unlabeled staged scene would cost every other claim.
- Nothing in Part A may break the code demo path. When an item risks it, it ships behind a flag until proven on the hosted demo.

## A0. Ship what is done (2026-10-15 to 10-17)

- [ ] **A0.1 Deploy the per-address cap removal.** Branch `mission/no-ip-cap` (a65d34f, c527359) is committed and not pushed. Push, open the PR, merge, deploy to the VM per `deploy/README.md`. Proof: two visitors from one address both get a demo, and the 50-per-day deployment cap still refuses the 51st.
- [ ] **A0.2 Check the PayPal Agent Toolkit calls.** The hosted sandbox MCP has returned "Unsupported cache mode: default" for others since 10-06 (AI-Toolkit issue #34). Acquit uses `@paypal/agent-toolkit` as a local client, which is likely unaffected. Confirm `get_order` in Ask the ledger and `get_payout_status` in the MCP server on the hosted demo. Effort 0.1.
- [ ] **A0.3 Test count and CI badge.** Add a GitHub Actions workflow that runs typecheck and the unit suites, a badge, and a measured test count at the top of the README. Fix or skip-with-reason the two POSIX path assertions in `packages/core/test/hidden-cases.test.ts` so the suite is green on Windows too. Effort 0.5.

## A1. The AG Studio moat (AG Grid 1st), 2026-10-17 to 10-30

The research is in `scratch/plan-research/paypal-aggrid.md`. Order matters: A1.1 unlocks the rest.

- [ ] **A1.1 A real escrow data model in Studio.** Effort 2. Impact: the minimum to be judged on "use of AG Studio" at all.
  - Replace the empty source in `apps/web/src/studio-source.ts` with tables served by a platform read route: `jobs`, `bids`, `verdicts` (verifier runs), `ledger_entries`, `paypal_events` (orders, captures, refunds, payouts, webhooks, disputes), `operators`, `clients`.
  - Relationships on `jobId`, `operatorId`, `captureId`. Expressions: take rate, verifier pass rate, escrow at risk, time to verdict, refund rate. A calendar on `releasedAt`. A dataset description so the built-in Data agent knows the domain.
  - Let the custom Ask the ledger agent delegate to the built-in `data` and `page` agents as well as `widget` (`apps/web/src/ask-harness.ts`).
  - Seed native widgets: a lifecycle funnel (posted, bid, funded, verified, paid), a pivot of status by operator, a treemap of escrow by operator, cross-filters. Keep "Ledger conserves" and the receipt card as the custom widgets.
  - Proof: a test asserts the native widgets' totals equal the custom widgets' totals and the conservation law. Screenshots at desktop and 390 px.
- [ ] **A1.2 Live escrow without remount.** Effort 1.
  - Create the engine once at module scope with `createDataEngine`, so the narrow/wide `key` switch no longer rebuilds Studio.
  - Push webhook and ledger events over server-sent events into `engine.update({ sources })`, replacing the 30-second poll. In grids, `getRowId` plus `applyTransactionAsync` with cell flashing.
  - First, measure whether `update()` replaces or merges a source. Replacing a whole table is fine at our volume.
  - Write the pattern up as a short README section. Builders asked AG Grid exactly this in Discord (Part B posts it).
  - Proof: a webhook replayed in the sandbox moves a Studio KPI and a grid row within two seconds, with no remount (the Studio history survives).
- [ ] **A1.3 Transaction Search reconciliation.** Effort 1. Needed by A1.4.
  - Enable Transaction Search on the sandbox app (10 to 15 minutes to propagate). Read `/v1/reporting/transactions` through the toolkit's `list_transactions`.
  - Reconcile row by row against `ledger_entries`. Rows newer than about 3 hours show "pending at PayPal", never a false mismatch.
  - Proof: a reconciliation widget lists matched, pending, and mismatched counts, and a test covers the lag window.
- [ ] **A1.4 "Explain this number".** Effort 2. Impact 9. No rival goes from a figure to the money to the proof.
  - Any KPI or pivot cell opens its ledger rows, through `DataEngine.drillThrough` or, because that request type is marked internal, a custom agent tool `trace_figure` that runs `execute_query` with the cell's filters.
  - Each ledger row links to its PayPal object, re-read live (`get_order`, `list_transactions`), shown as matching or not, and to the verifier receipt digest.
  - Render the trace as a chat Tool Component card: number, rows, PayPal id, receipt.
  - Proof: clicking "Fees collected" lists exactly the fee rows, each with a live PayPal match, and the sum equals the figure.
- [ ] **A1.5 Verdict timeline grid on AG Grid Enterprise.** Effort 1.5. First ask in #ag-grid whether Enterprise without a licence key is fine for judging (Part B, D4). If not, ship the Community version with custom renderers and skip pinned totals.
  - Master-detail jobs grid: the detail lists each verifier attempt with a sparkline of passing tests and the PayPal state.
  - Row grouping by escrow state. Pinned bottom totals that are the conservation law (held + released + refunded + fees = funded), green when it holds. Live rows from A1.2.
  - Proof: screenshot with a grouped view, an expanded job with three attempts, and green totals that match the ledger route.
- [ ] **A1.6 Agent change history with undo receipts.** Effort 1.
  - Attach an `AgAiTelemetryObserver` to the harness. Join tool calls to `api.getHistory()` entries by the delegate call ids the harness already tracks.
  - A "Changes" grid: which agent, which tool, what changed, and an "Undo to here" button (`api.undo(entry.id)`).
  - The twist rivals lack: hash each entry into the receipt chain, so the dashboard's own edits follow the same proof rules as payouts.
  - Proof: ask the agent for two widgets, undo to the first, and the chain verifies.
- [ ] **A1.7 PayPal objects as chat cards.** Effort 0.5. `get_order`, payout, refund, and dispute results render as Tool Component cards in the Studio chat instead of JSON text.

## A2. The proof moat, 2026-10-17 to 10-27

- [ ] **A2.1 The overfit catch, with a real model.** Effort 0.5. This is the strongest scene we can make, and it is not staged.
  - Prototype M2 already found it: a free model passed the frozen tests and failed hidden case 6 (JPY). Re-run that model on a fresh job and keep the run.
  - Show it on the job page as its own rejection type: "Passed the 8 visible tests. Failed 1 of 6 hidden tests." Escrow stays held.
  - Proof: a hosted job with a REJECTED attempt from a named real model, where frozen tests pass and a hidden one fails.
- [ ] **A2.2 Commit then reveal for per-job hidden cases.** Effort 1.
  - At freeze, store a salted digest of the hidden cases on the job (the manifest digest already exists). After the job closes (PAID, REFUNDED, or CLOSED), publish the cases and the salt on the receipt, so anyone can recompute the digest.
  - Only cases AI-drafted for that job (A1 scoping) are revealed. The curated fixture cases are shared by every visitor and must never be revealed, or later agents could hardcode them.
  - Proof: a receipt page recomputes the digest in the browser and shows a match, and a test refuses to reveal a fixture case.
- [ ] **A2.3 The verifier score card.** Effort 1.5.
  - A mutation corpus for the code vertical, each with its expected rejection reason. Edit a frozen test. Add `expect.extend` in source. Hardcode the visible expected values. Skip a test. Delete the tests. Commit a symlink. Exceed the diff limit. Touch a protected path. Return a constant from the function under test.
  - The suite runs every mutation plus at least 20 honest fixes and asserts each mutation is rejected with its reason and each honest fix is verified.
  - Publish the result as a "Verifier score card" on a public `/verifiers` page and in the README: "caught 9 of 9 known cheats, passed 20 of 20 honest fixes".
  - Proof: the score card comes from a CI run, not typed numbers.
- [ ] **A2.4 One-click judge scenarios.** Effort 1.5. Judges should reach every branch in under three minutes.
  - On the judge tour, five buttons that each set up a visitor job and drive it to the interesting point: verified and paid, hidden-test fail, test tamper, dispute and arbiter, deadline refund.
  - Each scenario runs the real path (real verifier, real sandbox calls) and is labeled where a script drives the agent.
  - Proof: each button from a clean private browser reaches its end state, timed.
- [ ] **A2.5 Concurrency proof on screen.** Effort 0.5. A test that fires the same VERIFIED webhook N times in parallel and asserts one payout. Show its result in the README next to the badge, and on the job page's money panel ("delivered 5 times, paid once").

## A3. PayPal depth, 2026-10-22 to 11-03

- [ ] **A3.1 More read-only toolkit tools.** Effort 0.5. Add `list_disputes`, `get_dispute`, `list_transactions`, `get_refund`, and merchant insights to Ask the ledger and the MCP server.
- [ ] **A3.2 Disputes answered with the receipt.** Effort 2. Impact 9. Timebox: if a real sandbox dispute cannot be filed by 10-31, ship the simulator path only.
  - Handle `CUSTOMER.DISPUTE.CREATED`. Freeze any unreleased money. Because disbursement is delayed, the money is still held when a dispute arrives.
  - When the verdict passed, answer with `provide-evidence`: the signed receipt, the verdict report, the merged PR. When it failed, accept the claim and refund.
  - AI drafts the evidence summary, and every sentence must cite a receipt field.
  - First drive it with the webhook simulator. Then record one real sandbox dispute from a personal sandbox buyer for the video.
  - Proof: a dispute on a paid job shows the evidence filed, with the PayPal dispute id, and a dispute on a failed job refunds.
- [ ] **A3.3 In-page checkout with the v6 Web SDK (optional).** Effort 1 to 1.5. The webinar promoted v6. Replace the approval redirect with in-page buttons and keep server-side create and capture. Card mode stays as the fallback. Do this only if A1 and A2 are done by 10-30.
- [ ] **A3.4 Contribute to paypal/AI-Toolkit.** Effort 0.5 to 1. Jo Franchetti and Eddie Jaoude are top contributors and judges.
  - A `references/` guide for marketplace escrow: Orders v2 with delayed disbursement, `platform_fees`, referenced payouts, and the auth assertion header.
  - `/paypal:explain-error` entries for the errors Acquit measured: `PLATFORM_FEE_NOT_ENABLED` on a refund naming `platform_fees`, `No permissions to set target_client_id` before consent, `NOT_PATCHABLE` on a payee PATCH, `PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE` on a repeat release.
  - Opening the PR is an outside write. The operator opens it or approves it first.
- [ ] **A3.5 Vault for agent-initiated funding (stretch).** Effort 1.5 to 2, with a half-day kill switch. A client's own agent funds later jobs from a vaulted PayPal account inside a cap. Drop it on the first `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`.

## A4. UI redesign, 2026-10-18 to 11-04

The Design criterion asks for "a complete, coherent product experience, not just a technical proof of concept". The page audit on 10-15 captured 65 screenshots of every route and role at 1440 px and 390 px (`data/evidence/ui-audit/20261015-205533/manifest.md`, gitignored, regenerate with the `verify-acquit` skill). The visual base is good: calm palette, clear type, the SANDBOX badge, proof-first copy. The problems are hierarchy, raw internals on screen, mobile overflow, and an operator journey that stops at the bid.

### A4.1 What the audit found

| Problem | Where (screenshot) | Why it costs points |
| --- | --- | --- |
| Raw internals as primary text: job UUIDs as headings and the widest table column, `IN_PROGRESS · READY` enums, the error code `ISSUE_BODY_UNREADABLE` in the contract card. | 06, 08, 18, 24, 25, 07, 20 | Reads as a tech demo. A judge cannot tell what state a job is in at a glance. |
| The job page repeats its status three times (pill, monospace status block, Escrow card), and the Verifier, the product's whole point, sits last and empty. | 24 | The proof is the product. It should lead. |
| The operator journey vanishes after the award. /operator shows "No open jobs right now", and there is no My work, In progress, Deliveries, or Payouts section. The awarded job page gives no next step (how to deliver). | 26, 27 | Half the marketplace has no home. Agentic Commerce judges will look here. |
| Mobile overflow: the New job form, the operator bid form, and the client jobs table are clipped at 390 px. Studio widgets are cut off inside an inner scroll. | 05-mobile, 10-mobile, 18-mobile, 29-mobile | Judges open links on phones. Design scores drop on first touch. |
| Studio looks empty: one band of $0.00 tiles, a receipt widget that is a blank box, a large dead area under the widgets, black squares in place of the AI Assistant's icons, and two AI entry points at once (Ask the ledger and Studio's panel). | 15, 29, 31 | This is the AG Grid entry. It must look like the richest page, not the emptiest. |
| Contradictory states: Ask the ledger says it is ready while warning that no model key exists; the accept dialog says "pay with PayPal" in card mode; a fake CLI code says "Link no longer valid"; literal backticks in CLI copy; the code hint shows `ABCD_EFGH` for `ABCD-EFGH`. | 30, 22, 33, 14, 32 | Each one is small. Together they say "unfinished". |
| Weak validation and guards: a budget of 0 is accepted, an operator can open the New job form, and the client's issue option renders disabled while selected. | 05, 34 | A judge testing edges finds these in a minute. |
| Three different not-found styles, and a signed-out 404 shows the sign-in picker at the bad URL. | 02, 04, 35, 36 | Incoherent. |
| The hosted landing page: the Platform key card is wider than the hero and has no heading or explanation, and the intro paragraph repeats step 1. | 38 | It is the first screen every judge sees. |

### A4.2 Principles for the redesign

1. **Lead with the proof, then the money, then the details.** Every job surface answers three questions in this order: is the work proven, where is the money, what happens next.
2. **Human words on screen, ids on hover.** Issue titles and operator handles are headings. Job ids, commits, and PayPal ids sit in small copyable chips, and they stay visible because they are the audit trail.
3. **One status vocabulary.** Map every machine state to one plain label and one color, used in pills, tables, Studio, and the video: Open for bids, Waiting for payment, Held in escrow, Being verified, Rejected (escrow still held), Verified (awaiting review), Disputed, Paying out, Paid, Refunded, Closed.
4. **Every page has one primary action.** The client's next step or the operator's next step is the only filled button on the page.
5. **390 px is a first-class layout.** No horizontal scroll on any route. Grids switch to card rows below 640 px.
6. **AI is always labeled with what it did and which model.** "Drafted by Nemotron 3 Ultra, approved by you", "Live model" on House runs.

### A4.3 The work, page by page

- [ ] **U1. Quick fixes (one PR, effort 1, by 10-20).** Everything in the "contradictory states" and "weak validation" rows: budget must be at least the minimum with an inline message; role guard on /jobs/new; correct accept-dialog label in card mode; Ask the ledger disables its starters and says why when no key exists; "That code is not valid" for unknown CLI codes; render inline code instead of backticks; fix the code hint; one shared not-found component used by all four cases, and a signed-out 404 that keeps its own URL. Also check whether `ISSUE_BODY_UNREADABLE` happens on the hosted demo or only on a local lane without GitHub access. If hosted, it is a scoping bug and blocks the video's scene 2.
- [ ] **U2. Status vocabulary and id chips (effort 1, by 10-22).** One `statusLabel(job)` and one `IdChip` component, used everywhere, replacing raw enums and UUID headings. Jobs tables lead with the issue title, then status, budget, deadline, bids. The id column goes, and the id moves into the row's chip.
- [ ] **U3. The job page as a proof timeline (effort 2.5, by 10-28).** The most important redesign.
  - Header: issue title, the status pill, and a one-line "what happens next" for this viewer.
  - Left column, a vertical timeline in time order: contract drafted and approved (with the hidden-case digest from A2.2), bids, payment held (PayPal order id), each attempt with its verdict (frozen and hidden counts, the reason in plain words, the diff link), review, payout (three PayPal ids), receipt. Rejected attempts stay on the timeline in red with "escrow still held".
  - Right column, the money card only: held, released, refunded, fee, with the ledger rows folded under it. Remove the duplicate monospace status block.
  - The Verifier moves from last to the centre of the timeline. Its empty state explains what will happen ("Devon's agent has 3 attempts. Every attempt runs 48 visible and 6 hidden tests.").
  - Operator view adds a "Deliver" panel with the exact CLI and MCP commands for this job.
- [ ] **U4. The operator workspace (effort 1.5, by 10-28).** /operator gets three sections: Open jobs to bid on, My work (awarded jobs with their state and the next step), and Earnings (held for me, paid to me, receipts). The breadcrumb follows the role. After a bid, a confirmation shows the credits spent.
- [ ] **U5. Mobile pass (effort 1, by 10-30).** Fix every overflow in the audit, card rows for grids under 640 px, the header nav as a compact menu, Studio widgets stacked without an inner scroll.
- [ ] **U6. Studio as the richest page (effort 1, after A1.1, by 10-30).** Full-width canvas, no dead space, seeded with the native funnel and pivot from A1.1, the receipt widget filled from real receipts or hidden when there are none, one AI entry point (Ask the ledger as a Studio custom agent inside the Studio panel, not a second button), and fixed icon glyphs. Operators get their own Ask the ledger scoped to their jobs. Empty data shows a short sample story ("Run a scenario to see money move"), never $0.00 tiles alone.
- [ ] **U7. The landing page (effort 0.5, by 10-30).** A hero that states the product in one line, the five scenario buttons from A2.4 as the main choice, "Start my demo" as the primary action, and the Platform key card folded into a small "Platform staff" link with one sentence of explanation. Remove the repeated paragraph.
- [ ] **U8. Receipt page (effort 1, with A2.2).** A public, shareable receipt per paid job: outcome, verdict counts, the revealed hidden cases with a browser-side digest check, the three PayPal ids, and the score card of the verifier that judged it. This is the artifact a seller would link from its own site, and it makes "receipts are proof" visible.
- [ ] **U9. Screenshots for review.** Re-run the page audit after U3, U5, and U6, at both widths, and compare with the 10-15 set before each merge.

Order: U1 and U2 first because they touch everything else, then U3 and U4 in parallel, then U5 to U8. U3, U4, U6, and U7 are on the never-cut list. U8 can shrink to a section on the job page.

## A5. Outcome as a Service: the plugin registry and the Print Twin

The full design is in `scratch/plan-research/oaas-3dprint.md`. This section is the build contract.

### A5.1 OutcomeVerifier interface and the code adapter (2026-10-20 to 10-22, effort 1.5)

Today the job core calls one verifier, and the contract, delivery, verdict, receipt, and post-release step are all code-shaped. The code map found these hard points: `DefinitionOfDone` (`packages/core/src/verifier.ts:32-41`), `OpenJob {repository, issueNumber}` (`packages/core/src/job.ts:383`), `CREATE_WORK_REPO` and `MERGE` effects (`job.ts:313`, `job.ts:319`), `Submit {sourceCommit}` (`job.ts:164-173`), Approve and Dispute naming `mergeCommit` (`job.ts:393-394`), the code-only `RejectReason` (`verifier.ts:54-96`), and every job page component (`apps/web/src/pages/JobPage.tsx`). Escrow, the ledger, credits, caps, refunds, disputes, timers, webhooks, and the outbox are already generic.

The interface (one file, `packages/core/src/outcome.ts`):

```ts
export interface OutcomeVerifierPlugin<Spec, Public, Hidden, Evidence, Reason, Metrics> {
  readonly manifest: PluginManifest;               // vertical, version, judge image digest, milestones, simulated flag
  readonly contract: ContractCodec<Spec, Public, Hidden>;   // validateSpec, freeze (seeded), reveal
  readonly evidence: EvidenceCodec<Evidence>;      // bounded parse, kinds per milestone
  readonly judge: OutcomeJudge<Public, Hidden, Evidence, Reason, Metrics>;
  readonly qualification: QualificationSuite<Spec, Evidence> | null;   // seller must pass before bidding
  readonly mutations: MutationCorpus<Evidence, Reason>;     // the score card (A2.3)
  readonly advisors: readonly Advisor<Public, Evidence>[];  // AI may flag or draft, never pass or reject
  receipt(verdicts: readonly MilestoneVerdict<Reason, Metrics>[], contract: FrozenContract<Public, Hidden>): ReceiptClaims;
  describeReason(reason: Reason): string;
  isFraud(reason: Reason): boolean;                // the analog of isTestTamper
}
```

Milestones carry `releaseBps`, so a vertical can release in tranches. The full type set (manifest, milestones, verdicts with `NEEDS_REVIEW`, evidence items with attestations, qualification, mutations) is in the design note, section 7.2.

Migration that keeps every test green:
1. Add `outcome.ts` and a `codeVerifier` adapter that wraps the existing `VerifierPort`, `manifestOf`, `describeRejectReason`, `isTestTamper`, the GitHub port, and the work repo. No logic moves.
2. `Ports.verifiers` is optional. When absent it is `{ code: codeVerifier(ports) }`.
3. `vertical` defaults to `"code"` at the store read boundary, the way `storedDefinitionOfDone` already defaults old rows (`job.ts:1072`).
4. Keep `Verdict`, `Receipt`, and `JobProjection` field names. Add the generic fields beside them, so the API JSON and the web and CLI tests do not change. Approve and Dispute accept `artifact`, with `mergeCommit` kept as an alias.
5. The web job page picks its contract, evidence, approve, and receipt components by `job.vertical`.

Proof: the whole existing suite passes unchanged, plus one test that runs a job through the registry with a stub second vertical. Only after this lands may anything say "pluggable".

### A5.2 The Print Twin vertical (2026-10-20 to 11-05, effort about 9, gated)

What it is. A client orders printed parts (STL, material, quantity 1 to 10, tolerance, infill and walls, deadline). Sellers are print farms whose autonomous pipelines bid. The seller returns raw evidence only: G-code, signed telemetry frames, layer photos, a tracking number. Acquit computes every measurement and ignores any number the seller's slicer reports. A hidden set fixed at open decides: sampled layers, probe features, and a per-job witness coupon printed on the same plate with a marker code. Money releases by evidence level, and the last tranche only moves when the part is delivered and the client scans the coupon code. The honest limit, said on screen: software proves the G-code and the evidence, not the atoms.

What is real and what is simulated:

| Real | Simulated, labeled "Simulated" |
| --- | --- |
| Contract freeze, hidden digest, commit then reveal | The seller farm (SimFarm) |
| PrusaSlicer 2.7.2 slicing on the VM (Ubuntu 24.04 arm64 package) | The printer (motion, thermal, extrusion models in virtual time) |
| G-code parsing, conformance, time estimate | The camera (toolpath renders with noise) |
| Telemetry signature, chain, and consistency checks | The client's coupon scan (a button) |
| The fraud corpus and score card | |
| PayPal sandbox order, partial refund of a failed unit, tracking on the order, referenced payout | |
| EasyPost test-mode tracker and its webhook | |

Build in this order. Each line is a PR.

| # | Piece | Days | Gate |
| --- | --- | --- | --- |
| P0 | VM spike: `prusa-slicer --export-gcode` headless in an `ubuntu:24.04` container (fallback `xvfb-run`); `manifold-3d` loads and slices an STL in Node 24; one sandbox order with two purchase units for the same payee under delayed disbursement; platform fee behaviour on a partial refund of a held capture. | 0.5 | Day 1. Any blocker changes the money design before code is written. |
| P1 | `packages/verifier-print`: `PrintSpec` validation, mesh stats, coupon generator, hidden terms with digest and reveal. | 1 | |
| P2 | G-code parser and trapezoid time estimator. | 1 | |
| P3 | Raster conformance: footprint IoU against the mesh slice on public and hidden layers, infill ratio, scale, unit count, coupon marker cells. | 1.5 | **10-23: a real STL slices on the VM and the skip-infill G-code is rejected with `INFILL_BELOW_CONTRACT` in a test.** Fail means stop and ship the "Next" card. |
| P4 | Twin telemetry (Ed25519 per printer, hash chain, file hash binding, filament total, duration) and camera renders with photo fingerprints. | 1.5 | |
| P5 | Five fraud mutations with expected reasons (skip-infill, scale-95, reused-photo, layer-shift, swap-gcode), plus 20 honest seeds, as a confusion-matrix test. This is the print score card. | 1 | |
| P6 | SimFarm over the Seller API, honest and fraud modes. Qualification with five hidden challenge parts and one trap job the pipeline must decline. | 1 | |
| P7 | Money: a print job through the existing escrow, partial refund of a failed unit's share, tracking added to the PayPal order, EasyPost delivered webhook, referenced payout of the remainder. The ledger law gains one term: payout + fee + refunded = paid. | 2 | **10-30: one sandbox order with one refunded unit and a released remainder, ledger laws green.** Fail means the vertical runs in the video as verification only, money labeled "next". |
| P8 | One job page for print: qualification certificate, layer timeline (render beside "photo"), verdict reasons, score card, receipt. | 1.5 | |
| P9 | Record the 37-second print segment (Part B). | 0.5 | Before 11-06. No print work after the freeze. |

Deferred to after the hackathon: thermal plausibility, beacons and live photo challenges, the virtual Klipper printer and a real Moonraker agent, AI vision advisories, per-unit purchase units, print MCP tools, the phone coupon scan, and the disputes evidence package for prints.

Rules for the print vertical:
- It runs as its own job type. The code demo path is never touched.
- Every number in the video comes from a real twin run and a real sandbox order.
- The renderer that makes the seller's "photo" differs from the reference (pose, lighting, noise), and the reference is the contract mesh, never the seller's G-code. Otherwise the comparison proves nothing.
- Shipping is domestic only. PayPal auto-disburses held money on day 28, and the print timeline ends by day 17, inside Acquit's day-21 cutoff.

### A5.3 The registry page (2026-11-02 to 11-04, effort 1)

A public `/verifiers` page that lists each registered plugin from its manifest: title, version, judge image digest, milestones, evidence levels, whether it is simulated, and its score card. Code shows "Live". 3D printing shows "Live, simulated farms" only if gate 2 passed, otherwise "Next". Rendering, video, translation, and data labeling show "Next", each with one line on what its hidden checks would be (a re-rendered hidden frame, caption-sync probes, back-translation probes, hidden gold items).

### A5.4 After the hackathon (do not build now, mention in "What's next")

From the design note, section 10: per-unit refunds triggered when the printer cancels a failed object mid-print, payout speed tiered by evidence level, seller bonds that shrink with receipts, one checkout fanned out to up to 10 farms (PayPal purchase units), receipts exported as verifiable credentials, a verifier marketplace where plugin authors earn a fee share and stake a bond, red-team bounties that turn found cheats into permanent mutations, and agent-to-agent manufacturing where a CAD agent posts and a farm agent prints.

## A6. Cut order and never-cut

Cut from the top first:
1. A3.5 Vault, A3.3 v6 SDK.
2. A1.7 chat cards, A1.6 undo receipts.
3. A5.2 P8 polish (keep a bare page), then the whole print money step (P7), keeping verification only.
4. A5.2 entirely, down to the "Next" card and a 10-second twin replay.
5. A3.2 down to the simulator path.

Never cut: A0, A1.1, A1.2, A1.4, A2.1, A2.3, A2.4, A5.1, U1 to U4, U6, U7, and the video. They carry the AG Grid entry, the proof moat, the Design score, and the honest "pluggable" claim.

## A7. Calendar

| Days | Build | Operator (Part B) |
| --- | --- | --- |
| 10-15 to 10-17 | A0.1 to A0.3 | D1 first progress post, D4 questions in #ag-grid and #dev-questions, V2 setup |
| 10-18 to 10-20 | A1.1, A2.1, U1 | V2 rough cut by 10-19, X thread starts |
| 10-21 to 10-23 | A1.2, A5.1, A5.2 P0 to P3, U2 | Print gate 1 on 10-23, D2 Studio clip |
| 10-24 to 10-27 | A1.3, A1.4, A2.2, A2.3, U3 starts | B1 buyer follow-ups, Devpost draft started |
| 10-28 to 10-30 | A1.5, A2.4, A5.2 P4 to P7, U3, U4, U5, U6, U7 | Print gate 2 on 10-30, D3 post |
| 10-31 to 11-03 | A3.1, A3.2, A3.4, A5.2 P8, A2.5, U8 | AI-Toolkit PR opened |
| 11-02 to 11-05 | A5.3, A1.6, A1.7, U9, fixes | Record final scenes |
| 11-06 | Freeze | V3 final cut uploaded |
| 11-07 to 11-10 | Fixes only | Devpost complete 11-09, submit 11-10 |

Three tracks can run as parallel build sessions because they touch different code: Studio and PayPal (A1, A3) in `apps/web/src/studio*` and `apps/api`, the proof moat and UI (A2, U) in the job core's projection and `apps/web/src/pages`, and the print vertical (A5.2) in a new `packages/verifier-print`. A5.1 and U3 both touch the job page, so A5.1 lands first. About 40 build-days are queued for about 22 calendar days, about 13 per track. That fits only with three tracks and the cut order above. Decide at the gates on 10-23 and 10-30, not later.

---

# Part B. Operator tasks

These need the operator: a voice, a face on camera, accounts, and judgement about what to say in public.

## B1. Video (the biggest open risk)

The current script is `docs/video-script.md` (2:50, eight scenes). Three changes:

1. **Add the overfit catch to scene 4** (from A2.1). The tamper refusal and the hidden-test miss back to back is the moment nobody else can show.
2. **Make scene 6 a three-party trail.** Client sandbox account, platform fee, seller payout, each with its PayPal transaction id visible, in one AG Grid row.
3. **Replace scene 8's static registry with the Print Twin**, if gate 2 passes.

Revised timing, 2:55:

| Time | Scene |
| --- | --- |
| 0:00 to 0:12 | Hook. "SaaS sold seats. Acquit sells verified outcomes." The problem: AI work that "passed" because the agent edited the test. |
| 0:12 to 0:27 | Post a job. AI drafts the contract and hidden tests. The client approves. The hidden-case digest is shown. |
| 0:27 to 0:42 | Bids through MCP, House bids too. Accept, pay in the PayPal sandbox. Escrow HELD. |
| 0:42 to 1:02 | The catch, twice. A labeled scripted agent edits a test: REJECTED. A real model passes the visible tests and misses the hidden JPY case: REJECTED. Escrow still HELD. |
| 1:02 to 1:20 | The honest fix. VERIFIED with counts. Approve, the PR merges. |
| 1:20 to 1:38 | Money. Three accounts, three PayPal ids. Same webhook five times, one payout. |
| 1:38 to 2:08 | AG Studio. A webhook moves a KPI live. "How much escrow is held, and does PayPal agree?" The agent builds a pivot from real tables. Click a number, it opens to the PayPal record and the receipt. |
| 2:08 to 2:45 | Second outcome. A simulated farm qualifies. A cheating farm is caught (4% infill, reused photo, missing coupon code), nothing paid. The honest farm loses one unit to a layer shift: that unit is refunded, the rest delivered and paid. |
| 2:45 to 2:55 | The registry with score cards, the URL, a buyer quote if one exists, "Cleared, then paid." |

If gate 2 fails, 2:08 to 2:45 becomes the verifier score card and the dispute answered with a receipt, and the registry shows print as "Next".

Tasks:
- [ ] **V2. Rough cut by 10-19** against the hosted demo with today's features. Gaps are fine. The point is to find what is slow, confusing, or broken on camera.
- [ ] **V2b. Record scenes 2 to 6 again** as A2.1, A2.4, and A1.4 land. Keep every take.
- [ ] **V3. Final cut by 11-06.** Captions, no music or royalty-free only, "PayPal Sandbox" and "Simulated" labels on screen, public on YouTube, under 3:00. Check it plays logged out.
- [ ] Use the `openvids` skill for the title cards and transitions only. The product footage must be real screen recordings.

## B2. Public presence

Acquit's only posts are from 10-08, and the X channel is uncontested (no rival posts build updates there). Post every two to three days until submission. Each post has one image or clip and the demo link. The `x-post` skill drafts X posts in the operator's voice.

- [ ] **D1. #what-i-built progress post, 10-16.** The demo link, a 30-second clip of the tamper refusal, one line on the per-address cap removal ("no visitor limit per network, judges on shared wifi are fine"), and a question inviting people to try to get a cheat past the verifier.
- [ ] **D2. #ag-grid clip, after A1.2.** Studio updating live from PayPal webhooks without a remount, plus the README write-up of how. Builders asked AG Grid this in Discord, so answering it publicly helps them and shows depth to the AG Grid judge.
- [ ] **D3. #what-i-built post, after A1.4.** "Every number on this dashboard opens to the PayPal record behind it."
- [ ] **D4. Questions, 10-16.**
  - #ag-grid: is AG Grid Enterprise without a licence key acceptable for judging, as AG said for Studio? Does `DataEngine.update()` replace or merge a source?
  - #dev-questions: can a delayed-disbursement order carry several purchase units for the same payee, and how do `platform_fees` behave on a partial refund of a held capture?
  - Thread with Jo Franchetti on `PLATFORM_FEE_NOT_ENABLED` and Flexible Partner Fee Refunds: no reply since 10-09, follow-up sent 10-15. Wait until 10-20 before a second follow-up.
- [ ] **D5. X thread, from 10-18.** A build-in-public thread: hidden tests, the three-party trail, the score card, the Print Twin gates. Tag @paypaldev and @ag_grid only on posts with something new to see.
- [ ] **D6. The AI-Toolkit PR (A3.4).** Open it from the operator's account, or approve that a session opens it.

## B3. Devpost

- [ ] **Start the draft by 10-27, finish by 11-09.** Claim the category early in the title and tagline.
- Name: "Acquit. Cleared, then paid."
- Tagline: "Outcome as a Service. AI agents get paid only when hidden tests they never saw say the work is done, and PayPal escrow holds the money until then."
- Story sections: the problem, how it works (one paragraph per bet in section 2), what is real and what is simulated (a table, like Bursar's, with fewer simulated rows), PayPal errors we hit and how we fixed them, what's next (A5.4).
- Built with: Orders v2 with delayed disbursement and `platform_fees`, referenced payouts, Partner Referrals, refunds, webhooks with signature checks, Transaction Search, Disputes (if A3.2 lands), the PayPal Agent Toolkit and AI Toolkit, AG Studio and its agent framework, AG Grid, the free Nemotron model through OpenRouter, an Oracle Cloud VM, Caddy, Docker, the GitHub App, TypeScript, PrusaSlicer (if A5.2 lands).
- Tools section: say which AI did what (House agent, scoping, Ask the ledger, the explainer), as the rules require.
- Gallery: 3:2 images of the job page with a REJECTED and a VERIFIED attempt, the money trail, the Studio dashboard, Explain this number, the score card, the print timeline.
- Testing instructions: the URL, "Start my demo", the five scenario buttons, the sandbox buyer login, and the local one-command path.
- [ ] **Repo About:** homepage URL and topics (`paypal`, `ai-agents`, `escrow`, `ag-grid`, `outcome-as-a-service`).

## B4. Buyers (Potential Impact)

- [ ] Five emails went out on 10-08 with no replies. Follow up once by 10-20 with the demo link and the 30-second clip. Ask for one sentence: "Would you pay for code work this way, and for what?"
- [ ] Add five new contacts who already buy AI or contract code work (agencies, non-technical founders). Discord introductions has people who described that problem.
- [ ] Target: two written quotes by 11-01, used in the video's last scene and on Devpost. If none arrive, the video uses no quote rather than a weak one.

## B5. VM and accounts

- [ ] After 2026-10-16 13:18Z: run `ctl sweep` on the VM.
- [ ] Deploy A0.1, then each merged Part A item. Check the demo in a private window after each deploy.
- [ ] Check `deploy/runtime.env` before each deploy. The template sets `ACQUIT_DEV=1`. Confirm the hosted demo's dev routes stay limited to the visitor's own jobs, as J1 requires.
- [ ] Never run `scratch/s1/rotate-app-key.mjs`.
- [ ] Weekly until 12-15: the demo loads, a scenario reaches PAID, the sandbox app and model key work.
- [ ] After judging ends on 12-15: revoke the Factory key and any other build-time keys.

---

## Appendix. Sources

- `docs/win-plan.md`, `docs/concept.md`, `docs/video-script.md`, `README.md`.
- `scratch/discord-read/digest.txt` and `threat-report.md`: the Discord read of 10-15 (general, introductions, ag-grid, sponsors, what-i-built, dev-questions).
- `scratch/plan-research/competitors.md`: public repos, Devpost pages, and demo sites of every rival found, read 10-15.
- `scratch/plan-research/paypal-aggrid.md`: the installed `ag-studio@3.0.0` types, the agent-toolkit and AI-Toolkit READMEs, PayPal's agentic commerce page, the AG Studio docs, and the 10-14 webinar.
- `scratch/plan-research/oaas-3dprint.md`: the full Print Twin design, with tool checks for aarch64 and the PayPal API map.
- `data/evidence/ui-audit/`: the page screenshots behind section A4.
