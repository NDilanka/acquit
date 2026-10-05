# Acquit roadmap

This doc is the working plan for building Acquit for the PayPal AI Hackathon. The deadline is 2026-11-12 at 15:00 EST. It follows the greenfield line of the PV Stack Playbook, one section per step. Each section gives the prompt to paste, the playbook's "Done when" items, the Acquit check that closes the step, and the role that runs it. The product is in `docs/concept.md`. The target experience is in `docs/tutorial.md`.

## Status

| Step id | Step | Status | Target dates | Done-check |
| --- | --- | --- | --- | --- |
| gf-tutorial | Write the tutorial first | done | 2026-10-05 | All three boxes in the gf-tutorial section are ticked. |
| gf-prototype | Settle four open decisions with throwaways | done | 2026-10-06 to 2026-10-18 | Each of the four decisions has a result and a decision log row. |
| gf-architect | Sketch the domain and stop | done | 2026-10-15 to 2026-10-17 | The sketch exists, and no implementation exists. |
| gf-skeleton | Build the walking skeleton | next | 2026-10-19 to 2026-10-21 | One command starts web and API, and a funded job shows a HELD ledger line. |
| gf-verify | Create the verification skill | pending | 2026-10-22 to 2026-10-23 | `/verify-acquit` exists and ran once end to end. |
| gf-plan | Turn the design into a plan | pending | 2026-10-24 to 2026-10-25 | The plan file passes `check-plan.mjs`, and you said go. |
| gf-feature | Build each feature with proof | pending | 2026-10-26 to 2026-11-07 | Every feature PR in the gf-feature list merged with proof. |
| Step 8 (id not printed) | Open the PR, babysit, ship | pending | Per PR, 2026-10-26 to 2026-11-08 | Every feature PR merged through Shipping. |
| Step 9 (id not printed) | Maintain the verification skill | pending | Daily from 2026-10-23 | A daily run reports `clean`, `changed`, or `blocked`. |

The fetched playbook page prints the ids `gf-tutorial`, `gf-verify`, `gf-feature`, and `gf-plan`. The ids `gf-prototype`, `gf-architect`, and `gf-skeleton` come from the session context. The page prints no id for steps 8 and 9, so this doc names them by heading.

The playbook lists gf-feature before gf-plan. For Acquit, run gf-plan first, because the feature list is too big for one PR.

## Track 0: business, runs in parallel

These tasks run beside the build. None of them waits for code.

- [x] Run `git init` and commit `docs/`. Done 2026-10-05.
- [ ] Create the public GitHub repo with a license and push. Target 2026-10-06.
- [ ] Read the Devpost rules on existing projects and record the answer in the decision log. Target 2026-10-06.
- [ ] Apply for PayPal partner status, which live delayed disbursement needs. Target 2026-10-06.
- [ ] Look at thejobcafe.com and assay.guide. Record whether either is a direct competitor in the decision log. Target 2026-10-07.
- [ ] Line up three committed buyers from agencies and non-technical founders with private repos. Target 2026-10-16, before gf-skeleton starts.

## Write the tutorial first (gf-tutorial)

The tutorial is the target for every later step. Agents check their work against `docs/tutorial.md`, and the demo video follows it.

Prompt used:

```text
/poteto-mode use /technical-writing to write a tutorial for Acquit, as if it already exists. show how a user would post a coding job, deliver it with their own AI agent, and get paid after the verifier passes it.
```

Optional check on the approach:

```text
/teach me and prove to me why this new approach is superior to a freelance marketplace that pays on client approval and ranks operators by star ratings
```

Done when:

- [x] A tutorial file exists in the repo, written in one Diátaxis mode.
- [x] You can say in one sentence what a user builds in the tutorial.
- [x] Each tutorial step names a result the reader can see.

Notes on the boxes:

- The file is `docs/tutorial.md`, committed to the local repo on 2026-10-05. The failure section was cut to one pointer sentence, so no explanation remains in the tutorial.
- The sentence is "A user posts a $400 coding job from a GitHub issue, delivers it with their own AI agent, sees the verifier reject a tampered test, and ends with a merged PR, a $360 sandbox payout, and a verified receipt."
- The third box is ticked. The prompt-file step had no visible result, so `acquit agent create` now prints `Prompt: prompts/ts-bugfixer.md (5 lines)` (`docs/tutorial.md:193`).

**Acquit end check.** The tutorial shows the credits charge on a bid (`docs/tutorial.md:227`) and the allowance growth after a receipt (`docs/tutorial.md:427`). Both are present.

**Who runs it.** The `pv-opus-medium` droid, the judgment and prose role.

Watch out:

- Don't let one document try to be a tutorial, a reference, and a design doc at once. Split it into one document per mode.

## Settle four open decisions with throwaways (gf-prototype)

Acquit has four open decisions that a run can settle and a discussion cannot. Each one gets its own throwaway folder under `scratch/`. No prototype code moves into the product.

### Decision a. Bend2 ledger or TypeScript ledger

The gate comes from the stress test. Bend2 stays only if a proof rejects a double payout on camera in under 20 seconds by 2026-10-18. Otherwise the product ships the TypeScript ledger with property tests, and Bend2 goes in the pitch as roadmap. Bend2 has no Windows build, so this prototype runs in WSL.

```text
/poteto-mode prototype the Acquit escrow ledger in Bend2 under WSL in scratch/bend2-ledger. make it a pure library with entries HELD, RELEASED, FEE, and REFUND. prove three laws. conservation means RELEASED plus FEE equals HELD for a paid job. no double release. a job gets a refund or a payout, never both. show the proof rejecting a double payout and time it from command to result. the gate is under 20 seconds by 2026-10-18. report pass or fail against the gate. this is throwaway. delegate the code to pv-grok-xhigh.
```

**Acquit end check.** A screen recording shows the double payout rejected in under 20 seconds, or the decision log records the fallback to TypeScript.

**Who runs it.** The `pv-grok-xhigh` droid, the hardest-tasks role.

### Decision b. PayPal sandbox escrow with one payout per job

The whole product depends on PayPal holding the money and paying exactly once.

```text
/poteto-mode prototype PayPal sandbox escrow for Acquit in scratch/paypal-escrow. create an order for a 400.00 USD job plus the 20.00 USD client fee with delayed disbursement and platform_fees of 60.00 USD, so the sandbox Business payee receives 360.00 USD on release. release it. then deliver the same webhook event twice and show that exactly one payout exists. also refund a second held order. print every API response and webhook body. this is throwaway. delegate the code to pv-sol-high.
```

**Acquit end check.** The printed responses show one payout of 360.00 USD after two identical webhook deliveries, and one refund on the second order.

**Who runs it.** The `pv-sol-high` droid, the code role.

### Decision c. Verifier tamper detection

The demo centerpiece is the verifier rejecting a tampered test. This prototype proves the rule before any product code exists.

```text
/poteto-mode prototype the Acquit verifier in scratch/verifier. make a small copy of the invoice-app sample from docs/tutorial.md with the KWD rounding bug. freeze the test suite at a commit, add hidden tests that the PR cannot see, and protect tests/**, .github/**, package.json, and package-lock.json. run it on two branches. one edits the expected value in tests/totals.test.ts. the other fixes src/money.ts. print REJECTED and VERIFIED with the same reasons docs/tutorial.md shows. this is throwaway. delegate the code to pv-sol-high.
```

**Acquit end check.** The tamper branch prints `REJECTED` with `PR modifies frozen test file tests/totals.test.ts`. The fix branch prints `VERIFIED` with 48 frozen and 6 hidden tests passed.

**Who runs it.** The `pv-sol-high` droid, the code role.

### Decision d. Job page and bid list layout

The client decides on this page, and judges score design. Frontend work runs on pv-opus-medium only.

```text
/poteto-mode prototype three variants of the Acquit job page with its bid list in scratch/job-page, behind one switcher. use the data from docs/tutorial.md. show the devon-ops bid with 0 verified receipts, the House: tsfix bid with "41 fixes, 39 passed verified CI", the escrow status line, and the Accept button. take screenshots of each variant for me to choose from. this is throwaway. delegate only to pv-opus-medium.
```

**Acquit end check.** Three screenshots exist, and the decision log names the chosen variant and the reason.

**Who runs it.** The `pv-opus-medium` droid only, per the frontend rule.

### Done when

- [x] Two or three variants exist in a scratch folder, outside production code.
- [x] You have a screenshot, an output, or a timing for each variant.
- [x] You picked one direction and wrote down why.
- [x] The agent's reply says plainly that the prototype is throwaway.
- [ ] Or you skipped this step because no decision was open, and you wrote down that reason. (Not applicable. All four decisions were open.)

Results, 2026-10-05. Each folder has a `RESULT.md` with raw output.

- **a.** Gate passed when warm. `bend --check-only bad.bend` printed `SOME PROOFS FAIL` at the one-release proof in a median of 0.32s over 3 runs. The first `bend --verdict` after installing Lean took 44.57s, because it builds the kernel once. Decision: TypeScript runs the product ledger, and `scratch/bend2-ledger/ledger.bend` becomes the proof of the same three laws for the demo. Pre-warm the kernel before recording. See `scratch/bend2-ledger/RESULT.md`.
- **b.** Partly settled. No PayPal sandbox credentials exist yet, so `sandbox.mjs` exits 2 and names the missing variables. A local replay showed that dedupe on event id alone pays twice when PayPal re-sends with a new event id (`payout_count=3`). Guarding the job's HELD to RELEASED transition paid once per job (`payout_count=2` for two jobs). Decision: guard the job state transition. See `scratch/paypal-escrow/RESULT.md`.
- **b, sandbox run.** Ran on 2026-10-05 against a sandbox Platform app. The seller first had to grant permissions through a Partner Referrals link, or order creation failed with `No permissions to set target_client_id`. After that, a 420.00 USD order with `DELAYED` and `platform_fees` of 60.00 USD captured as held. The referenced payout released it with status `SUCCESS`. The seller received 344.85 USD, not 360.00 USD, because PayPal charged its 15.15 USD processing fee to the seller. So `platform_fees` can carry the client fee, but the operator's net is 360.00 minus PayPal's fee. A refund that names `platform_fees` failed with `PLATFORM_FEE_NOT_ENABLED`. A plain full refund of 420.00 USD worked, and the capture became `REFUNDED`. The refund breakdown shows `paypal_fee 0.00`, which suggests PayPal keeps its 15.15 USD on a refund. See `scratch/paypal-escrow/run2.log`, `run3.log`, and `run4.log`.
- **b, fee follow-up.** Also 2026-10-05. An order with `platform_fees` of 44.85 USD captured with the same 15.15 USD PayPal fee and released exactly 360.00 USD to the operator (`scratch/paypal-escrow/run6.log`). So Acquit can absorb PayPal's fee and keep the tutorial's 360.00. The operator's sandbox balance read 5,329.70 USD after one release and one refund, from 5,000.00. That is 15.15 USD less than the release and the held refund job explain, so a refund takes PayPal's kept fee from the operator. A GET on an order returned a transient 503 during polling.
- **c.** Neither variant alone was enough. Path protection (A) rejected a fix that also touched a test. The frozen overlay (B) verified a tree that differs from what merges. Decision: run on frozen inputs (B), reject protected-path changes in the merge diff (A), and require every test to complete. Residual: source code that replaces a test matcher passed both, so assertions must run outside the submitted code's process. See `scratch/verifier/RESULT.md`.
- **d.** Three layouts. Decision: variant 2, proof first, for choosing a bid. After a bid is accepted, the page switches to variant 3, the ledger spine. Screenshots are in `scratch/job-page/shots/`.

Watch out:

- Don't ship prototype code. Hand the chosen direction to `/architect` or the Feature playbook for the real build.

## Sketch the domain and stop (gf-architect)

Acquit spans the web app, the API, the ledger, PayPal, the verifier CI, and the operator CLI. The money rules must live in types and one state machine, not in scattered checks.

```text
/architect this new Acquit core domain with checkpoint. stop and show me before implementing. use docs/tutorial.md as the usage section. model these parts.
	Job is a state machine with states OPEN, IN_PROGRESS, VERIFIED, PAID, and REFUNDED. REJECTED is an attempt result, not a job state.
	Ledger entries are HELD, RELEASED, FEE, and REFUND. For a paid job, RELEASED plus FEE equals HELD. For a refunded job, REFUND equals HELD. A job never has both RELEASED and REFUND.
	Bid has operator, price, ETA, agent, and pitch. Accepting one bid locks the escrow to that operator.
	Receipt is created only by an escrow release, and it records frozen tests, hidden tests, and attempts.
	Credits ledger. A bid costs 10 credits. The weekly allowance is 30, plus 10 per verified receipt, up to 100. Credits return when the client cancels or does not respond to bids within the review window. Extra credits cost 0.15 USD each. Credits cannot be transferred or cashed out, and they never mix with escrow money.
	Acceptance contract with definition of done, 3 attempts, a 72-hour client review window, and a dispute path.
the ledger is a pure TypeScript reducer. scratch/bend2-ledger/ledger.bend proves the same three laws for the demo. carry the decisions from the gf-prototype results into the sketch.
```

Questions the sketch must answer:

- What happens when the 72-hour review window ends with no client action.
- Whether House agent bids spend credits.
- Whether House bids sort first on the job page. Sorting by receipts puts House first, which works against new operators.
- How assertions run outside the submitted code's process, so a replaced test matcher cannot pass hidden tests.
- Who pays PayPal's processing fee, about 15.15 USD on 420.00 USD. Today it comes out of the operator's 360.00 USD, which breaks the tutorial's "$360 released" line. Acquit can absorb it by lowering `platform_fees` to 44.85 USD at order time, since PayPal's fee is predictable (3.49% plus 0.49 USD in the sandbox).
- Who covers the PayPal fee PayPal keeps when a timed-out job is refunded.

Done when:

- [x] A usage sketch shows how callers will use the code. See the Usage section of `docs/architecture/rationale.md`.
- [x] At least two structurally different designs were compared. Three were: an event log, a versioned row with an outbox, and split money and work machines (`scratch/architect/candidate-1` to `candidate-3`).
- [x] Types and signatures exist with placeholder bodies, in one file or a module map. Nine files in `docs/architecture/sketch/`, 44 `not implemented` bodies, strict `tsc` exit 0.
- [x] A rationale records which design won and why. See its Synthesis decision section.
- [x] The agent stopped after the sketch and did not implement it.
- [ ] Or you skipped this step because the shape was obvious, and you wrote down that reason.

**Acquit end check.** Every transition in `docs/tutorial.md` maps to one state machine edge, and the three questions above have answers in the rationale.

**Who runs it.** You run `/architect` in the main session. The sketch arena and judge follow the role sheet. The review panel is pv-opus-medium, pv-sol-xhigh, and pv-grok-high.

Watch out:

- Don't accept the first design. The skill exists to compare at least two.

## Build the walking skeleton (gf-skeleton)

The verification skill needs an app it can launch. The first real action in the tutorial is posting a job and funding the escrow.

```text
/poteto-mode build the smallest version of Acquit that starts with one command and lets a client post a job, an onboarded operator bid on it, and the client accept the bid and fund escrow in the PayPal sandbox end to end. add a seed script with the test users maya-client (client) and devon-ops (operator, already onboarded to the sandbox merchant) and the invoice-app repository. show me it running. implement against docs/architecture/sketch and its rationale. delegate backend code to pv-sol-high and any frontend code only to pv-opus-medium.
```

Done when:

- [ ] One documented command starts the app from a clean checkout. The command may assume prerequisites, such as a language runtime, when the README lists them.
- [ ] One user action works end to end, and you saw it work.
- [ ] Seed data and a test login exist, if the app needs them.

**Acquit end check.** One command on Windows starts the web app and the API. `maya-client` posts a 400.00 USD job, `devon-ops` bids, and `maya-client` accepts and pays 420.00 USD in the sandbox. The ledger shows one `HELD 420.00 USD` line, as in the Accept section of `docs/tutorial.md`.

**Who runs it.** The `pv-sol-high` droid writes backend code. The `pv-opus-medium` droid writes frontend code.

Watch out:

- Don't add features before the app starts reliably. A flaky start teaches the verification skill wrong steps.
- If Bend2 passed its gate, the one command must also start the WSL side. A start that works only from a WSL shell does not count.

## Create the verification skill (gf-verify)

After this step, any agent can drive Acquit like a user and bring proof.

```text
/create-verification-skill
```

Then build the control CLI:

```text
/poteto-mode build a small control CLI for Acquit that /verify-acquit uses. add subcommands for start, stop, screenshot, seed-db, login --test-user <name> for maya-client and devon-ops, ledger --job <id>, and webhook replay --event <id>. add --dry-run to anything destructive, rich --help, JSON output, and error messages that say what to do instead. prove each command against the running app. delegate the code to pv-sol-high.
```

Done when:

- [ ] A `verify-<app>` skill exists with Launch, Doctor, Drive, Evidence, and Cleanup sections.
- [ ] The generator ran the skill once end to end, and the evidence still exists after cleanup.
- [ ] `features/README.md` lists at least one feature, and each listed feature has its own file.
- [ ] The agent launched the app and showed you a screenshot or output from one feature.

**Acquit end check.** `.factory/skills/verify-acquit/` exists, and its Feature Map lists "post a job, accept a bid, and fund escrow".

**Who runs it.** You run the skill in the main session. The control CLI code goes to pv-sol-high.

Watch out:

- If the generator's own proof run fails, don't use the output. Fix the app start or report the blocker first.
- Don't drive the app by screen coordinates when a stable handle exists, such as an ARIA label, a data attribute, or a route.

## Build each feature with proof (gf-feature)

Each feature is one PR that ends with proof from the running app. The order comes from gf-plan.

Prompt template:

```text
/poteto-mode build <feature>. use /verify-acquit to verify your changes and show me <proof> as proof. delegate the code to <role>.
```

Feature PRs, with the proof to ask for and the role:

| PR | Feature | Proof to ask for | Role |
| --- | --- | --- | --- |
| 1 | Ledger core, Bend2 or TypeScript per the gate | Property test output and a rejected double release | pv-grok-xhigh |
| 2 | PayPal adapter with delayed disbursement, platform_fees, refunds, and idempotent webhooks | Sandbox responses showing one payout after a replayed webhook | pv-sol-high |
| 3 | Verifier CI with frozen suite, hidden tests, and protected paths | `REJECTED` on the tamper branch and `VERIFIED` on the fix branch | pv-sol-high |
| 4 | Jobs, bids, and credits API | HTTP responses for bid, accept, credit charge, and credit return | pv-sol-high |
| 5 | `acquit` CLI with login, operator init, agent create, jobs list, bid, run, diff, submit, and receipts | Command output matching `docs/tutorial.md` | pv-sol-high |
| 6 | House agent with a labeled bid and receipts | The House: tsfix bid on the job page | pv-sol-high |
| 7 | Web UI pages for sign-up, new job, fund escrow, job page with bids, ledger, and operator profile | Screenshots and a video of the client path | pv-opus-medium only |

Split PR 7 into one PR per page if a page does not fit in one PR.

Done when:

- [ ] The reply includes proof from the running app, such as a video, screenshots, command output, or HTTP responses.
- [ ] The todo list showed the Feature playbook steps, and every skipped step had a reason.
- [ ] The Feature Map has a file for the new feature.

**Acquit end check.** One agent runs the whole of `docs/tutorial.md` against the sandbox, and every output block matches.

**Who runs it.** The role in the table for each PR.

Watch out:

- Don't accept "the build passed" as proof. Ask for the real flow, output, or stored value.

## Turn the design into a plan (gf-plan)

The feature list above is seven or more PRs across five systems. Run this step before the first feature PR.

```text
/poteto-mode turn this design into a plan. the PRs are the gf-feature list in docs/roadmap.md. the live checks use /verify-acquit against the PayPal sandbox. the plan runs under Autopilot-stack.
```

Done when:

- [ ] The plan file exists, and `check-plan.mjs` prints no problems.
- [ ] Each PR section has its own files, build step, and unit, live, and perf checks.
- [ ] Prototypes answered the open questions, and the plan's first appendix lists them.
- [ ] None of the planned work is built yet, and the agent waits for your go.
- [ ] Or you skipped this step because the work fits in one PR, and you wrote down that reason.

**Acquit end check.** The plan's first appendix lists the four gf-prototype results, and the last PR in the plan ends with the full tutorial run.

**Who runs it.** The `pv-opus-medium` droid, the judgment and prose role.

Watch out:

- Don't overcook the plan without evidence. Settle open questions with prototypes first.
- Don't review an abstract plan adversarially. Agents invent risks that never happen.

## Open the PR, babysit, ship (step 8, id not printed)

Every feature PR goes through this step. Babysit gets it merge-ready. Shipping verifies it again and lands it.

```text
/poteto-mode open the pr. small ordered commits, evidence in the description.
```

```text
/poteto-mode babysit this pr. get it green.
```

```text
/poteto-mode land the stack.
```

Done when:

- [ ] The PR is open, not a draft, and its description shows how the change was verified.
- [ ] Babysit reports the PR as merge-ready. Babysit stops there and never merges.
- [ ] Before anything merged, a fresh agent verified each PR on the real app.
- [ ] Shipping merged the PR. Merged is the end state of this step.

**Acquit end check.** By 2026-11-08, every feature PR merged into `main` on the public repo, and `main` runs the full tutorial.

**Who runs it.** You run the prompts in the main session. Shipping's per-PR verification uses the review panel, pv-opus-medium, pv-sol-xhigh, and pv-grok-high.

Watch out:

- Don't accept every review comment. Bots and people file real catches and noise in the same list.

## Maintain the verification skill (step 9, id not printed)

The Feature Map changes with every merged PR. A stale map sends the demo dry runs down wrong paths.

```text
/maintain-verification-skill
```

After a hard task:

```text
/reflect that took way too long. capture what we learned so the next run doesn't repeat it.
```

Done when:

- [ ] A maintenance run finished and reported `clean`, `changed`, or `blocked`.
- [ ] A daily schedule runs `/maintain-verification-skill`, or you have a daily reminder to run it.
- [ ] Any `changed` outcome arrived as one PR inside the verification skill's folder.

**Acquit end check.** The run on 2026-11-09, before the video, reports `clean`.

**Who runs it.** You start it in the main session or as a scheduled automation.

Watch out:

- Don't let the Feature Map go stale. A stale map sends agents down paths the app no longer has.

## Week by week

Week 1 starts on Monday 2026-10-05. The Bend2 gate is Sunday 2026-10-18, the end of week 2.

| Week | Dates | Steps | Milestone |
| --- | --- | --- | --- |
| 1 | 2026-10-05 to 2026-10-11 | Track 0 setup, gf-tutorial, gf-prototype b, c, and d, Bend2 work starts | Repo public, partner application sent, three prototype decisions logged |
| 2 | 2026-10-12 to 2026-10-18 | gf-prototype a, gf-architect (2026-10-15 to 2026-10-17) | Bend2 gate on 2026-10-18, three committed buyers by 2026-10-16 |
| 3 | 2026-10-19 to 2026-10-25 | gf-skeleton, gf-verify, gf-plan, step 9 starts | App starts from one command, `/verify-acquit` exists, plan approved |
| 4 | 2026-10-26 to 2026-11-01 | gf-feature PRs 1 to 4, step 8 per PR | Ledger, PayPal adapter, verifier, and API merged |
| 5 | 2026-11-02 to 2026-11-08 | gf-feature PRs 5 to 7, step 8 per PR | CLI, House agent, and web UI merged, full tutorial runs |
| 6 | 2026-11-09 to 2026-11-10 | Demo video under 3 minutes, Devpost submission | Submitted on 2026-11-10 |
| Buffer | 2026-11-11 to 2026-11-12 | Fixes only | Deadline 2026-11-12 15:00 EST |

## Decision log

| Date | Decision | Why | Evidence |
| --- | --- | --- | --- |
| 2026-10-05 | Operators bring their own API keys, billed to themselves. Acquit never resells subscription quota. | Anthropic and OpenAI terms forbid quota resale, and providers banned accounts for it in 2026. | `docs/concept.md:9`, `docs/concept.md:58` |
| 2026-10-05 | The verifier runs on platform CI with a frozen suite, hidden tests, and protected paths. | A test tamper must fail even when local tests pass. This is the demo centerpiece. | `docs/concept.md:55`, `docs/tutorial.md:285-304` |
| 2026-10-05 | Job deadlines end well before the PayPal 28-day auto-disbursement, with a refund on timeout. | The refund must always come before PayPal's automatic release. | `docs/concept.md:56`, `docs/tutorial.md:433` |
| 2026-10-05 | Bid mode only for the hackathon. Bounty mode is deferred. | Bounties waste operator compute and invite PR spam. | `docs/concept.md:57` |
| 2026-10-05 | Bend2 stays only if it passes the week-2 gate. | A proof must reject a double payout on camera in under 20 seconds by 2026-10-18, or the TypeScript ledger ships. | `docs/concept.md:59` |
| 2026-10-05 | The fee stays 15%, split as 5% from the client and 10% from the operator. | Kept despite Algora's 9%. | `docs/concept.md:60`, `docs/tutorial.md:409-414` |
| 2026-10-05 | Bids cost 10 credits from a weekly allowance of 30, plus 10 per verified receipt, capped at 100. Credits return on client cancel or no response. Extra credits cost 0.15 USD. Credits are closed-loop, cannot be transferred, and cannot be cashed out. | Free bids let agents flood clients, and paid-only bids price out new operators. | `docs/concept.md:29-34`, `docs/concept.md:61` |
| 2026-10-05 | First customers are agencies and non-technical founders with private repos. Get three committed buyers before building much. | Output of the three-model stress test. | `docs/concept.md:62` |
| 2026-10-05 | Write an acceptance contract with definition of done, rework limits, review deadline, and dispute path. | Verified payment needs agreed terms before work starts. | `docs/concept.md:63` |
| 2026-10-05 | Duplicate PayPal webhooks produce exactly one payout. | PayPal can deliver the same webhook more than once. | `docs/concept.md:64` |
| 2026-10-05 | The product name is Acquit, with the tagline "Cleared, then paid". | Chosen this session from the shortlist work. | `docs/tutorial.md:1`, `docs/tutorial.md:11` |
| 2026-10-05 | Write the tutorial before any code. | The tutorial is the target that agents and the demo video check against. | `docs/tutorial.md` |
| 2026-10-05 | A verifier rejection keeps escrow held while the operator reworks. Refunds happen only on deadline expiry or after 3 failed attempts. | More realistic than an instant refund, and the tutorial already shows it. | `docs/concept.md:55`, `docs/tutorial.md` attempt 1 |
| 2026-10-05 | The product ledger is TypeScript. Bend2 proves the same three laws as a demo artifact. | The Bend2 reject ran in 0.32s warm, so the gate passed. The cold kernel build took 44.57s, `Nat` overflowed at cent values, and calling Bend2 from the server needs WSL. | `scratch/bend2-ledger/RESULT.md` |
| 2026-10-05 | Release is guarded by the job's HELD to RELEASED transition, not by webhook event id. | Event-id dedupe paid twice on a re-sent event with a new id. | `scratch/paypal-escrow/RESULT.md` |
| 2026-10-05 | PayPal escrow works in the sandbox: delayed capture, a 60.00 USD platform fee that includes the client fee, referenced-payout release, and a plain full refund. Operators must grant permissions through Partner Referrals before their first job. Refunds don't name `platform_fees`. | Measured in the sandbox. A refund with `platform_fees` failed with `PLATFORM_FEE_NOT_ENABLED`, and order creation failed before the seller granted permissions. | `scratch/paypal-escrow/run2.log`, `run3.log`, `run4.log` |
| 2026-10-05 | Acquit absorbs PayPal's processing fee by sending `platform_fees` of 60.00 minus the predicted fee (44.85 on 420.00). Acquit also pays back the 15.15 PayPal takes from the operator on a refund. | Measured in the sandbox. 44.85 released exactly 360.00, and a refund lowered the operator's balance by 15.15. | `scratch/paypal-escrow/run6.log`, `docs/architecture/rationale.md` |
| 2026-10-05 | Approved. A job cancelled before payment ends as CLOSED, a sixth status. A dispute the arbiter does not decide within 48 hours releases to the operator. The tutorial edits from the rationale are applied. | You approved funding at Accept and CLOSED. You left the dispute default to me, and the verifier already passed, so a late arbiter should not delay the operator. | `docs/tutorial.md`, `docs/architecture/rationale.md` |
| 2026-10-05 | The core is one versioned job row with typed substates, one transition table, and an outbox. Funding moves from job open to bid accept. | PayPal names the payee when the order is created. Candidate 2 won the arena, with grafts from candidates 1 and 3. | `docs/architecture/rationale.md` |
| 2026-10-05 | The verifier runs on frozen inputs, rejects protected-path changes in the merge diff, and requires all 54 tests to complete. | Each variant alone missed a case. A config cheat exited 0 with no tests collected. | `scratch/verifier/RESULT.md`, `docs/tutorial.md` attempt 2 |
| 2026-10-05 | The job page uses the proof-first layout for bids, then the ledger spine after a bid is accepted. | Prices are equal, so receipts are the deciding signal. | `scratch/job-page/shots/` |
| 2026-10-05 | Follow the greenfield line with the Balanced role sheet. Frontend tasks run on pv-opus-medium only. | The user's role sheet and frontend rule. | This doc, Status table |

## How to update this doc

- Tick a box only when you have the proof. Link the proof or quote it next to the box.
- Add one decision log row for every decision, including each gf-prototype result and the Bend2 gate result.
- Change a status in the Status table on the day it changes. Keep one step at `next`.
- If a date slips, change the target date and add a decision log row that says why.
- Keep the "Done when" items as the playbook wrote them. Put Acquit detail in the end check instead.
