# Acquit feature plan

This plan takes Acquit from the walking skeleton (escrow HELD) to the full `docs/tutorial.md` run in the PayPal sandbox.
It serves the client who pays only for verified work, and the operator who gets paid exactly once.
Every PR keeps one rule. Money moves only through a job state edge, and every edge is proven on the running app before the PR joins the stack.
The PRs run in this order, H0, F1, F3, F2, F4, F5, F6, F7. F-numbers are the row numbers in the gf-feature table of `docs/roadmap.md`. H0 is a harness PR this plan adds.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `playbooks/autopilot-stack.md` from the poteto-mode skill in the installed PV Stack plugin. No owner merges. The root appends each verified PR to one linear stack on `main`, and the operator reviews and lands it bottom-up. Every PR stops at STACK-READY. The operator items in Arm the program are the only work the operator does before landing.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Confirm the operator items. Each one is an account action only the operator can take. Record each as done or missing in the decision trail.
  - [ ] The public GitHub repo exists with a license, and `main` is pushed, so `git ls-remote origin main` prints a SHA. Every `git show origin/main:` read below depends on it.
  - [ ] `SANDBOX_BUYER_PASSWORD` is set in the root `.env`. Check only that the name is set. Without it, the regression lanes that fund through checkout and F7's tutorial run report BLOCKED. Other lanes fund with H0's dev card source.
  - [ ] A GitHub App named `Acquit sandbox` exists with contents, issues, pull requests, and checks permissions. It is installed on the `acquit-forks` org and on the account that owns the lane client repos. Its app id and private key path are in `.env`. F3 needs this.
  - [ ] A second sandbox Business account is onboarded through Partner Referrals, and its merchant id is in `.env` as `OPERATOR_HOUSE_MERCHANT_ID`. F6 needs this.
  - [ ] Docker Desktop is running, so `docker info` exits 0. The verifier's container subject in F3 and the runner in F5 need it. On 2026-10-05 the daemon was down.
  - [ ] Optional. An Anthropic API key is available for the one `claude-code` runner lane in F5.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:docs/plan.md`
  - [ ] `git show origin/main:.factory/skills/verify-acquit/SKILL.md`
  - [ ] `git show origin/main:.factory/skills/verify-acquit/features/README.md`
  - [ ] `git show origin/main:docs/roadmap.md`
  - [ ] Read the plugin files `skills/poteto-mode/playbooks/autopilot-stack.md`, `skills/poteto-mode/playbooks/autopilot-full.md`, `skills/swarm/SKILL.md`, `skills/poteto-mode/playbooks/opening-a-pr.md`, `skills/poteto-mode/playbooks/shipping.md`, `skills/poteto-mode/references/bugbot-triage.md`, and `skills/show-me-your-work/SKILL.md`. They live in the PV Stack plugin cache, not in git, so read them with the Read tool.
  - [ ] Read the built-in `agent-browser` and `tuistory` skills. They are the control skills for the web UI and for both CLIs.
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below, through Droid's `Loop` tool. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Each owner works in its own git worktree under `/home/factory-user/repos/acquit-worktrees/<pr-id>`. Each owner's prompt opens with the poteto-agent line from `skills/poteto-mode/references/droid-tools.md`, so the owner reads the poteto-mode SKILL.md in full before any work.
  - [ ] Backend code owners for H0, F3, F2, F4, F5, and F6 run on `pv-sol-high`.
  - [ ] The F1 owner runs on `pv-grok-xhigh`, per the roadmap role for the ledger.
  - [ ] Every file under `apps/web/` is written by a `pv-opus-medium` delegate, in every PR. F7's owner runs on `pv-opus-medium`.
- [ ] Follow this dependency graph. The stack is linear, so each PR branches from its parent's branch tip.
  - [ ] H0 is first. It branches from `main`.
  - [ ] F1 after H0.
  - [ ] H1 after F1. H1 makes lane control work on Linux, after the program moved off Windows on 2026-10-06.
  - [ ] F3 after H1.
  - [ ] F2 after F3.
  - [ ] F4 after F2.
  - [ ] F5 after F4.
  - [ ] F6 after F5.
  - [ ] F7 after F6.
- [ ] Start an owner early when its parent is code-ready. It builds on the parent tip and rebases when the root appends the parent. Unit work starts early. Live lanes run only on a head that contains the verified parent.
- [ ] Hold the file boundaries.
  - [ ] H0 touches only `packages/cli/**` (renamed to `packages/ctl/**`), `apps/api/src/**`, `packages/core/src/paypal.ts`, `packages/core/src/acquit.ts`, `scripts/**`, `README.md`, `package.json`, and `.factory/skills/verify-acquit/**`.
  - [ ] F1 touches only `packages/core/src/ledger.ts`, `packages/core/test/ledger*.test.ts`, `packages/ctl/src/**`, and `scripts/ledger-demo.mjs`.
  - [ ] F3 touches only `packages/core/src/verifier.ts`, `packages/core/src/job.ts`, `packages/core/src/effects.ts`, `packages/core/src/github.ts`, `packages/verifier/**`, `packages/acquit-cli/**`, `apps/api/src/**`, `apps/web/src/pages/JobPage.tsx`, and their tests.
  - [ ] F2 touches only `packages/core/src/paypal.ts`, `packages/core/src/effects.ts`, `packages/core/src/job.ts`, `packages/core/src/ledger.ts`, `packages/core/src/acquit.ts`, `packages/ctl/src/**`, `apps/api/src/**`, `apps/web/src/pages/JobPage.tsx`, and their tests.
  - [ ] F4 touches only `packages/core/src/job.ts`, `packages/core/src/credits.ts`, `packages/core/src/effects.ts`, `apps/api/src/**`, `apps/web/src/pages/**`, and their tests.
  - [ ] F5 touches only `packages/acquit-cli/**`, `packages/runner/**`, `apps/api/src/**`, and their tests.
  - [ ] F6 touches only `packages/core/src/operator.ts`, `packages/house/**`, `scripts/seed.ts`, `packages/core/src/seed-data.ts`, `apps/web/src/pages/JobPage.tsx`, and their tests.
  - [ ] F7 touches only `apps/web/**` and `apps/api/src/**` for read routes the pages need.
  - [ ] Every PR that changes a user path updates its feature file under `.factory/skills/verify-acquit/features/` in the same PR.
- [ ] Hold the review gate. F3, F2, F4, F5, F6, and F7 change an interaction. Each posts its screenshots and video in chat before it lands.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run `npm run typecheck` and `npm test` once before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` (Droid's built-in `simplify` skill) before each commit and `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, or on a CI failure that comes from a change on trunk.
- [ ] Put the PR's sandbox ids (order, capture, payout item, refund) and its evidence folder in the PR body. Never put a credential, token, cookie, or approval query string there.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per the swarm skill. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Give audit lanes these focuses at least. One audits money paths against the three ledger laws and the idempotence rules in `docs/architecture/rationale.md`. One audits secret handling and evidence sanitizing per the verify-acquit Hard rules.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Since 2026-10-07 the operator has delegated merges to the root. The root lands each PR through the Shipping playbook once its verdict is clean and the PR sits at the bottom of the stack. It retargets the PR to `main`, checks that `git patch-id --stable` still matches the verdict, and merges with a merge commit pinned to the verdict SHA. A squash would force-push every child branch. The per-PR lines below that say the operator lands a PR mean this.
- [ ] On a clean verdict, the root appends the PR to the stack. It rebases the branch onto the exact parent tip, checks `git ls-remote`, pushes with `--force-with-lease`, and sets the PR base to the parent branch. A rebase that leaves `git patch-id --stable` unchanged keeps the verdict. A changed patch-id sends the PR back for a fresh swarm. No owner merges, arms auto-merge, or closes.

### Boot recipe, for every live lane

Each live lane runs on this machine in its own git worktree and its own lane slot. Drive the web UI through `agent-browser` and both CLIs through `tuistory`. H0 builds the lane slot. Before H0 lands, H0's own lanes use the slots that H0's head provides.

- [ ] `git fetch origin <head-branch>` then `git worktree add /home/factory-user/repos/acquit-lanes/<pr-id>-<n> <head SHA>`, then `npm install` in that worktree.
- [ ] Set `ACQUIT_LANE=<n>`. The slot gives API port `4310 + 10n`, web port `5173 + 10n`, database `data/verify/lane-<n>/acquit.db`, run state `data/ctl/lane-<n>/`, browser session `verify-acquit-lane-<n>`, and from F3 on the shared client repo `NDilanka/invoice-app` with one work repo per job, `acquit-forks/invoice-app-<job uuid>`. Run the verify-acquit Launch preflight, then `npm run ctl -- start --timeout 60` through Execute with `fireAndForget:true`, then `seed-db --yes` and Doctor. Require `healthy:true`.
- [ ] Deliver input only through `agent-browser` with the lane's session, `tuistory`, and the operator CLI commands. Read-only diagnostics are `npm run ctl -- status`, `npm run ctl -- ledger --job <id> --json`, `GET /api/jobs/:id`, and sandbox GET calls made by the verify-acquit helpers. Assert on per-transaction PayPal values, never on a merchant balance, because lanes share the sandbox merchants.
- [ ] Save every screenshot to `data/evidence/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.
- [ ] Run verify-acquit Cleanup for the lane slot after every run, pass or fail.

## Isolate verification lanes and add a dev clock (H0)

**Depends on.** None.

**Files.**

- [ ] Move `packages/cli/` to `packages/ctl/` and rename the root script `acquit` to `ctl`. Update every caller in `README.md`, `.factory/skills/verify-acquit/**`, and `packages/ctl/test/cli.test.ts` in the same commit.
- [ ] Edit `packages/ctl/src/state.ts`, `packages/ctl/src/process.ts`, and `packages/ctl/src/commands.ts`.
- [ ] Edit `apps/api/src/config.ts` and `apps/api/src/server.ts`.
- [ ] Edit `packages/core/src/paypal.ts` and `packages/core/src/acquit.ts`.
- [ ] Edit `.factory/skills/verify-acquit/SKILL.md`, `.factory/skills/verify-acquit/features/README.md`, and `.factory/skills/verify-acquit/scripts/fund-escrow.mjs`.
- [ ] Create `.factory/skills/verify-acquit/scripts/lanes.mjs`.
- [ ] Create `scripts/perf/boot.mjs`.

**Build.**

- [ ] Add `laneSlot(n)` in `packages/ctl/src/state.ts`. It derives both ports, the database path, the run directory, and the browser session from `ACQUIT_LANE`. Without `ACQUIT_LANE`, it returns today's values.
- [ ] Add `webOrigin` to `apps/api/src/config.ts`. The origin check in `server.ts` and the return and cancel URLs in `paypal.ts` read it, so no file names port 5173.
- [ ] Record each child's process start time in the run file. `stop` kills a PID only when its start time still matches, which closes the PID reuse gap.
- [ ] Add an injectable `Clock` to `createAcquit` config. Add `POST /api/dev/clock` with `{ advanceMs }` and `npm run ctl -- clock advance <duration>`. Both exist only when `ACQUIT_DEV=1`.
- [ ] Add an `approve` mode to `fund-escrow.mjs` that completes buyer approval through standard input per the skill's Optional buyer approval section, and drives on to HELD.
- [ ] Add `lanes.mjs` with `start <count>`, `doctor`, and `cleanup` across lane slots. `start` reads free physical memory and starts at most `floor((free MB - 1024) / per-lane MB)` slots at once, where per-lane MB is the measured peak of one slot (API, Vite, and its headless browser). It prints the cap and the measurement. The root runs a PR's ten lanes in waves of that cap. This machine has 8 GB, and 904 MB was free on 2026-10-05, so ten slots at once do not fit.
- [ ] Add a dev-only card funding source. With `ACQUIT_DEV=1` and `npm run ctl -- fund-mode card`, the `CREATE_ORDER` effect sends a PayPal sandbox test card as `payment_source.card`, and PayPal returns a completed DELAYED capture with no buyer login (Appendix A, P2). The capture still flows through `CaptureCompleted`. Lanes whose scenario is not funding use it. Regression lanes and the tutorial run keep the buyer checkout.

**You see.**

- [ ] `node .factory/skills/verify-acquit/scripts/lanes.mjs start 10` prints its memory cap and one `healthy:true` row per started slot, with lane n on ports `4310 + 10n` and `5173 + 10n`.
- [ ] `npm run ctl -- clock advance 4h` on a job in checkout prints the new clock time, and the job page shows `OPEN` with bidding open again.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/ctl/test/cli.test.ts` gains `laneSlot` cases for lanes 0, 1, and 10, and a `stop` case that refuses a live PID whose start time differs. Run `npm test`.
- [ ] `packages/core/test/skeleton.test.ts` gains a case where the checkout expires after `Clock` advances three hours. Run `npm test`.
- [ ] Run `npm run typecheck`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `pv-sol-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the verify-acquit feature 04 drive at trunk and at head on the default slot. Save `fund-checkout.png`. Pass when both `summary.json` files show `passed:true` and the same stored quote (total 42000, platform fee 4485, operator net 36000).
- [ ] Lane 2. Start lanes 1 and 2 at the same time and run the feature 04 drive on both. Save `two-lanes-checkout.png`. Pass when both drives pass and the two jobs have different ids in different database files.
- [ ] Lane 3. Run `lanes.mjs start 10`, then `lanes.mjs doctor`. Save `lanes-cap-doctor.png`. Pass when `start` prints a cap with its per-lane measurement, starts exactly that many slots, refuses the rest with a message naming the free memory, and every started row shows `healthy:true`.
- [ ] Lane 4. From lane 3's browser session, send a command to lane 4's API with the lane 3 origin. Save `cross-origin-refused.png`. Pass when lane 4 refuses it with 403 and accepts the same command from its own origin.
- [ ] Lane 5. On lane 5, accept a bid and read the order from the sandbox. Save `return-url.png`. Pass when the order's return URL names port 5223.
- [ ] Lane 6. Write a lane run file that names a live unrelated `node` process, then run `npm run ctl -- stop`. Save `pid-guard.png`. Pass when `stop` refuses with a start-time mismatch and the unrelated process still runs.
- [ ] Lane 7. Accept a bid, leave checkout unpaid, and run `npm run ctl -- clock advance 4h`. Save `checkout-expired.png`. Pass when the job page shows `OPEN` and bidding open, and Devon's credits stay at 20.
- [ ] Lane 8. Start a lane without `ACQUIT_DEV=1`, call `POST /api/dev/clock`, and run `fund-mode card`. Then restart with `ACQUIT_DEV=1`, set `fund-mode card`, and accept a bid. Save `card-held.png`. Pass when the first two are refused with a hint to set `ACQUIT_DEV=1`, and the second run shows `Escrow: HELD, locked to devon-ops` with no buyer login.
- [ ] Lane 9. If `SANDBOX_BUYER_PASSWORD` is set, run `fund-escrow.mjs approve` on lane 9. Save `held.png`. Pass when the job page shows `Escrow: HELD, locked to devon-ops` and the ledger shows `HELD 420.00 USD`. If the password is not set, the lane reports BLOCKED with that reason.
- [ ] Lane 10. With lanes 6, 7, and 8 running, run cleanup for lane 7 only. Save `cleanup-isolated.png`. Pass when lane 7's ports close and lanes 6 and 8 still report `healthy:true`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Seconds from `start` to both endpoints answering, for one instance at trunk and head. At head also, seconds until one wave of slots at the memory cap all answer, and the measured per-lane MB.
- [ ] Probe. `node scripts/perf/boot.mjs --rounds 5` alternates trunk and head single starts, then runs one wave at the cap at head.
- [ ] Baseline. Record the trunk single-start median first.
- [ ] Rule. Fail if the head single-start median exceeds trunk by more than 15 percent. Fail if one wave at the memory cap takes more than 120 seconds to answer.

**Review gate.** None. H0 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends H0 to the base-branch stack, and the operator lands it bottom-up.

## Finish the ledger and prove its three laws (F1)

**Depends on.** H0.

**Files.**

- [ ] Edit `packages/core/src/ledger.ts`.
- [ ] Create `packages/core/test/ledger.test.ts` and `packages/core/test/ledger-laws.test.ts`.
- [ ] Edit `packages/ctl/src/registry.ts` and `packages/ctl/src/commands.ts`.
- [ ] Create `scripts/ledger-demo.mjs` and `scripts/perf/ledger.mjs`.

**Build.**

- [ ] Implement the `Release` and `Refund` moves in `reduceLedger` and implement `checkLaws` in `packages/core/src/ledger.ts`. A paid book has RELEASED plus FEE equal to HELD. A refunded book has REFUND equal to HELD. No book has both.
- [ ] Add the treasury entries `PROCESSOR_FEE_VARIANCE`, `REFUND_FEE_RETAINED`, and `OPERATOR_REIMBURSEMENT_OWED` per question 5 and 6 of the rationale.
- [ ] Add `npm run ctl -- ledger --job <id> [--json] [--check]` and `ledger --all --check`. They read the stored book through the API and print each line and the law result.
- [ ] Add `scripts/ledger-demo.mjs double-release` and `release-then-refund`. Each prints `REJECTED` and the law that refused it, for the demo beside `scratch/bend2-ledger/ledger.bend`.

**You see.**

- [ ] `npm run ctl -- ledger --job <held job>` prints `HELD  420.00 USD  client payment (400.00 job + 20.00 escrow fee)` and `Laws: OK`.
- [ ] `node scripts/ledger-demo.mjs double-release` prints `REJECTED  no double release` in under 20 seconds.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/core/test/ledger.test.ts` replays the tutorial and asserts the literal lines HELD 42000, RELEASED 36000, and FEE 6000 with processor 1515 and Acquit 4485. Run `npm test`.
- [ ] `packages/core/test/ledger-laws.test.ts` generates 10,000 seeded random move sequences and asserts that every accepted book satisfies the three laws and every refused move names its law. Run `npm test`.
- [ ] Run `npm run typecheck`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `pv-sol-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Fund a job to HELD with `fund-escrow.mjs approve` at trunk and at head. Save `held-ledger.png`. Pass when both job pages show the same `HELD 420.00 USD` line and head's `ledger --job` prints it with `Laws: OK`.
- [ ] Lane 2. Run `ledger --job` on a job that is OPEN with no bids. Save `ledger-empty.png`. Pass when it prints `No ledger lines` and `Laws: OK` and exits 0.
- [ ] Lane 3. Run `ledger --job job_missing`. Save `ledger-missing.png`. Pass when it exits nonzero with `JOB_NOT_FOUND` and a line that says to run `jobs` or check the id.
- [ ] Lane 4. Run `ledger --job <held job> --json` and `GET /api/jobs/<id>`. Save `ledger-json.png`. Pass when the two ledger arrays are equal, cents and kinds.
- [ ] Lane 5. Cancel an open job before payment, then run `ledger --job` on it. Save `ledger-closed.png`. Pass when the job shows `CLOSED` and the book has no lines.
- [ ] Lane 6. Run the property test file alone with `node --test packages/core/test/ledger-laws.test.ts`. Save `laws-property.png`. Pass when it reports 10,000 cases and 0 failures.
- [ ] Lane 7. Run `scripts/ledger-demo.mjs double-release` three times. Save `double-release.png`. Pass when each run prints `REJECTED` with the no-double-release law in under 20 seconds.
- [ ] Lane 8. Run `scripts/ledger-demo.mjs release-then-refund`. Save `release-refund.png`. Pass when it prints `REJECTED` with the one-disposition law.
- [ ] Lane 9. Open the PayPal return URL for one funded job twice in two browser tabs. Save `double-return.png`. Pass when the ledger still has one HELD line and the sandbox order has one capture.
- [ ] Lane 10. After lanes 1 to 9 finish, run `ledger --all --check` on every lane database. Save `ledger-all.png`. Pass when every job prints `Laws: OK`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Median latency of `GET /api/jobs/:id` on a HELD job at trunk and head. At head also, the property test wall time.
- [ ] Probe. `node scripts/perf/ledger.mjs --requests 200` alternates trunk and head instances in rounds of 20 requests.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail if the head median exceeds trunk by more than 20 percent plus 2 ms. Fail if the property test takes more than 10 seconds.

**Review gate.** None. F1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends F1 to the base-branch stack, and the operator lands it bottom-up.

## Verify submissions on frozen inputs and open the PR (F3)

**Depends on.** F1.

**Files.**

- [ ] Edit `packages/core/src/verifier.ts`, `packages/core/src/job.ts`, and `packages/core/src/effects.ts`.
- [ ] Create `packages/core/src/github.ts`.
- [ ] Create `packages/verifier/judge.ts` and `packages/verifier/subject.ts`.
- [ ] Create `packages/acquit-cli/package.json`, `packages/acquit-cli/src/main.ts`, and `packages/acquit-cli/src/submit.ts`.
- [ ] Edit `apps/api/src/server.ts` and `apps/web/src/pages/JobPage.tsx`.
- [ ] Create `packages/core/test/verifier.test.ts` and `scripts/perf/verifier.mjs`.
- [ ] Create `.factory/skills/verify-acquit/features/06-submit-verify.md` and `.factory/skills/verify-acquit/scripts/lane-repo.mjs`.

**Build.**

- [ ] At OpenJob, record the frozen commit, the six hidden tests, and the protected paths in the contract. At CaptureCompleted, emit a `CREATE_WORK_REPO` effect that pushes the frozen commit to `acquit-forks/<repo>-<job>` through the GitHub App.
- [ ] Implement the `Submit` and `VerifierFinished` edges in `job.ts` and dispatch `START_VERIFIER` in `effects.ts`. A rejection keeps escrow HELD and returns the job to READY with one attempt used. The third rejection moves to REFUND_PENDING.
- [ ] Implement the judge in `packages/verifier/judge.ts`. It holds hidden tests as data and never imports submitted code. It runs the subject in the variant Appendix A selects, screens source for test-framework imports, rejects protected-path diffs, and requires all 54 test ids. A missing or malformed reply counts as missing. A duplicate reply id invalidates that id for the whole run, because a first-reply-wins parser accepted the forged transcript in the prototype. The subject runs in Docker with `--network none` and a read-only mount. The plain child-process subject stays only as the unit-test path, because it cannot keep judge files or host credentials away from same-user code.
- [ ] On VERIFIED, the GitHub App pushes branch `acquit/<job>` to the client repo, opens the PR, and posts the `Acquit verifier` check run.
- [ ] Add `acquit submit <job> [--dir .]` in `packages/acquit-cli`. It pushes the directory's HEAD to the work repo, sends `Submit`, polls until the attempt is judged, and prints the tutorial's REJECTED or VERIFIED block.
- [ ] Have the `pv-opus-medium` delegate show the attempt history and the verifier result on `JobPage.tsx`.
- [ ] Add `lane-repo.mjs` that creates `invoice-app-lane-<n>` from the template and prepares a work directory from one `scratch/verifier/invoice-app` branch.

**You see.**

- [ ] `acquit submit job_X` on the `tamper-test` branch prints `Verifier result: REJECTED` and `PR modifies frozen test file tests/totals.test.ts` and `Attempts left: 2`.
- [ ] `acquit submit job_X` on `fix-honest` prints `Frozen tests: 48 passed`, `Hidden tests: 6 passed`, `Required tests: 54 completed, 0 skipped or missing`, and `Pull request opened`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/core/test/verifier.test.ts` runs the judge on every `scratch/verifier/invoice-app` branch and asserts the literal verdict and reason per branch, including `cheat-assertion` as REJECTED. Run `npm test`.
- [ ] `packages/core/test/skeleton.test.ts` gains Submit and VerifierFinished edge cases for attempts 1, 2, and 3 and for a timed-out run. Run `npm test`.
- [ ] Run `npm run typecheck`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `pv-sol-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no Submit edge, so record that `Submit` is refused there. At head, fund to HELD, prepare `tamper-test`, and run `acquit submit`. Save `reject-tamper.png`. Pass when the CLI prints the tutorial's REJECTED block and the job page shows `IN_PROGRESS` with escrow HELD.
- [ ] Lane 2. After lane 1's flow, prepare `fix-honest` and submit again. Save `verified-pr.png`. Pass when the CLI prints the VERIFIED block with 48, 6, and 54, the client lane repo has the PR, and its `Acquit verifier` check is green.
- [ ] Lane 3. Submit `cheat-assertion`. Save `reject-matcher.png`. Pass when the result is REJECTED with the failing hidden test ids.
- [ ] Lane 4. Submit `cheat-config`. Save `reject-config.png`. Pass when the result is REJECTED with required tests missing.
- [ ] Lane 5. Submit `fix-with-test-tamper`. Save `reject-protected.png`. Pass when the result is REJECTED with the protected path named.
- [ ] Lane 6. Submit the `cheat-rpc-forged`, `cheat-rpc-json`, and `cheat-local-matcher` trees from `scratch/verifier-judge/setup.mjs`. Save `reject-rpc.png`. Pass when all three are REJECTED and no hidden expected value appears in the subject's input log.
- [ ] Lane 7. Submit three rejected attempts on one job. Save `attempts-exhausted.png`. Pass when the job shows REFUND_PENDING after the third and the ledger still has only the HELD line.
- [ ] Lane 8. Run `acquit submit` as an operator who is not the locked one. Save `submit-denied.png`. Pass when it prints a denial that names the locked operator and no verifier run starts.
- [ ] Lane 9. Stop the subject process or container while a run is in progress. Save `subject-killed.png`. Pass when the attempt slot is returned, the job shows READY, and the attempt count is unchanged.
- [ ] Lane 10. Send the same Submit twice with one request key. Save `submit-replay.png`. Pass when the second reply is REPLAY and exactly one verifier run exists.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk has no verifier. At head, the judge wall time per run and the end-to-end seconds from `acquit submit` to the printed verdict.
- [ ] Probe. `node scripts/perf/verifier.mjs --runs 5` runs `fix-honest` and `tamper-test` alternately after one warm-up. It records judge time and submit-to-verdict time.
- [ ] Baseline. Record that trunk cannot produce the metric. Record the prototype's child-process median first (623 ms for `fix-honest` in Appendix A), then the head's Docker subject cold and warm medians.
- [ ] Rule. Fail if the warm Docker judge median exceeds 10 seconds. Fail if the submit-to-verdict median exceeds 120 seconds.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and lane 2 screenshots into `data/evidence/review/F3-review-reject.png` and `data/evidence/review/F3-review-verified.png`.
- [ ] Record a 30 to 60 second video of the reject then verify flow with `agent-browser record` on a lane slot. Save it as `data/evidence/review/F3-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. Stop at STACK-READY. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends F3 to the base-branch stack, and the operator lands it bottom-up.

## Release, refund, and replay webhooks through PayPal (F2)

**Depends on.** F3.

**Files.**

- [ ] Edit `packages/core/src/paypal.ts`, `packages/core/src/effects.ts`, `packages/core/src/job.ts`, `packages/core/src/ledger.ts`, and `packages/core/src/acquit.ts`.
- [ ] Edit `packages/ctl/src/registry.ts` and `packages/ctl/src/commands.ts`.
- [ ] Edit `apps/api/src/server.ts` and `apps/web/src/pages/JobPage.tsx`.
- [ ] Create `packages/core/test/paypal.test.ts` with sanitized fixtures from Appendix A, and `scripts/perf/release.mjs`.
- [ ] Create `.factory/skills/verify-acquit/features/07-approve-release.md` and `08-refund.md`.

**Build.**

- [ ] Implement `Approve`, `ReleaseSettled`, `RefundSettled`, and `MergeFinished` in `job.ts`. `ReleaseSettled` builds the receipt.
- [ ] Dispatch `RELEASE`, `REFUND`, and `MERGE` in `effects.ts`. Each call sends the deterministic effect key as `PayPal-Request-Id`, and each lease reconciles by lookup before it redispatches, per the Appendix A result on request ids.
- [ ] Add the reimbursement of the retained refund fee as a Standard Payout from the platform to the operator's merchant id (Appendix A, P4). Record PayPal's 0.25 USD payout fee as a treasury line.
- [ ] Extend `TimerDue` past capture. A delivery deadline refunds unverified work. The day 21 capture-age cutoff refunds unverified work and releases verified work.
- [ ] Replace the 501 in `handlePayPalWebhook`. Parse the event, re-read the resource from PayPal, and route it to its edge. The job state is the guard, not the event id.
- [ ] Record every delivery as its canonical envelope in a `webhook_events` table: the event id, the event type, the resource type and id, and the outcome. Never the body. Add `npm run ctl -- webhook replay --event <id>` to rebuild the envelope the route recorded and repost it, and `--capture <id> --new-event-id` to build an envelope that names a real capture id. PayPal's event list returned nothing in the probe (Appendix A, P5), so replay cannot fetch events from PayPal: the route's re-read of the resource the envelope names is what makes a locally built envelope a real test of the guard.
- [ ] Use the measured idempotence keys. The effect key is the `PayPal-Request-Id` for release and refund, because a repeat returned the same resource with HTTP 200. The reimbursement's effect key is its `sender_batch_id`, because a repeat returned HTTP 400 `USER_BUSINESS_ERROR` naming the original batch. Treat `PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE` and `CAPTURE_FULLY_REFUNDED` as settled, and reconcile by lookup.
- [ ] Have the `pv-opus-medium` delegate add **Approve and release** with its confirm dialog, the PAID state, the receipt id, and the three-line ledger to `JobPage.tsx`.

**You see.**

- [ ] After **Approve and release**, the job page shows `Status: PAID`, the merged PR, and a receipt id, and the ledger shows `RELEASED 360.00 USD` and `FEE 60.00 USD  fees (15.15 PayPal processing + 44.85 Acquit)`.
- [ ] `npm run ctl -- webhook replay --event <id>` run twice prints `applied` then `no-op, job already PAID`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/core/test/paypal.test.ts` parses recorded capture, payout, and refund bodies into evidence types and asserts the literal cents. Run `npm test`.
- [ ] `packages/core/test/skeleton.test.ts` gains cases for a duplicate webhook, a new event id for an applied capture, a crash between dispatch and settle, and an uncertain release that must never become a refund. Run `npm test`.
- [ ] Run `npm run typecheck`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `pv-sol-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk stops at VERIFIED AWAITING_CLIENT, so record that. At head, run fund, `fix-honest` submit, and **Approve and release**. Save `paid.png`. Pass when the job shows PAID with the merged PR and receipt, and the sandbox payout item for the capture is `SUCCESS` with 360.00 USD to Devon.
- [ ] Lane 2. Deliver one capture envelope with `webhook replay --capture <id>`, then replay the recorded envelope with `webhook replay --event <recorded id>`. Save `replay-twice.png`. Pass when the sandbox lists exactly one referenced payout for the capture and the ledger is unchanged.
- [ ] Lane 3. Deliver the same capture under a new event id with `webhook replay --capture <id> --new-event-id`. Save `replay-new-id.png`. Pass when the route returns 200 with a no-op outcome and no payout is added.
- [ ] Lane 4. Fund a job, submit nothing, and advance the clock past the deadline. Save `deadline-refund.png`. Pass when the job shows REFUNDED, the ledger shows `REFUND 420.00 USD`, and the reimbursement of 15.15 USD to Devon reaches a terminal success.
- [ ] Lane 5. Run three rejected attempts. Save `three-rejects-refund.png`. Pass when the job ends REFUNDED with one sandbox refund for the capture.
- [ ] Lane 6. Click **Approve and release** in two tabs at once. Save `approve-twice.png`. Pass when one release exists and the second tab shows PAID without an error.
- [ ] Lane 7. Stop the API right after Approve commits, then start it again. Save `crash-reconcile.png`. Pass when the job reaches PAID with exactly one payout item for the capture.
- [ ] Lane 8. Post a webhook whose event id PayPal does not know. Save `webhook-unknown.png`. Pass when the route refuses it and no job changes version.
- [ ] Lane 9. Sign in as `devon-ops` and try to approve. Save `approve-denied.png`. Pass when the API denies it and the page shows no Approve control for the operator.
- [ ] Lane 10. After lane 1, read Devon's receipt through `GET /api/jobs/<id>`. Save `receipt.png`. Pass when it shows frozen tests 48/48, hidden tests 6/6, and attempts 2 of 3.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk has no release. At head, seconds from the Approve click to PAID on the page, and the webhook route time excluding PayPal calls.
- [ ] Probe. `node scripts/perf/release.mjs --jobs 5` funds and approves five jobs in sequence and replays each webhook five times.
- [ ] Baseline. Record that trunk cannot produce the metric, and record trunk's capture time from the return route as the nearest PayPal round trip.
- [ ] Rule. Fail if the Approve-to-PAID median exceeds 20 seconds. Fail if the webhook route median exceeds 500 ms excluding PayPal calls.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and lane 4 screenshots into `data/evidence/review/F2-review-paid.png` and `data/evidence/review/F2-review-refund.png`.
- [ ] Record a 30 to 60 second video of approve and release with `agent-browser record`. Save it as `data/evidence/review/F2-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. Stop at STACK-READY. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends F2 to the base-branch stack, and the operator lands it bottom-up.

## Finish the review window, disputes, and credits (F4)

**Depends on.** F2.

**Files.**

- [ ] Edit `packages/core/src/job.ts`, `packages/core/src/credits.ts`, and `packages/core/src/effects.ts`.
- [ ] Edit `apps/api/src/server.ts` and `apps/web/src/pages/JobPage.tsx` and `apps/web/src/pages/OperatorHome.tsx`.
- [ ] Create `packages/core/test/review.test.ts`, `packages/core/test/credits.test.ts`, and `scripts/perf/commands.mjs`.
- [ ] Create `.factory/skills/verify-acquit/features/09-dispute.md` and `10-credits.md`.

**Build.**

- [ ] Implement `Dispute` and `ResolveDispute` in `job.ts`. A dispute pauses the 72-hour clock, and the arbiter has 48 hours.
- [ ] Extend `TimerDue` in VERIFIED. Review silence releases with authority `REVIEW_SILENCE`. A missed arbiter deadline releases with `ARBITER_SLA_MISSED` and an alert.
- [ ] Run the weekly grant from `tick` on Monday 00:00 UTC. The allowance is 30 plus 10 per verified receipt, capped at 100.
- [ ] Add a dev-only arbiter route `POST /api/dev/arbiter` that sends `ResolveDispute`, and document it as the arbiter's surface for the hackathon.
- [ ] Have the `pv-opus-medium` delegate add **Open dispute** and the review deadline to `JobPage.tsx`, and the weekly credit line to `OperatorHome.tsx`.

**You see.**

- [ ] After a bid, `GET /api/me/credits` shows 20, and after the client cancels it shows 30.
- [ ] A verified job left alone for 72 hours on the dev clock shows `PAID` with authority `REVIEW_SILENCE`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/core/test/review.test.ts` covers silence release, a dispute pause, both arbiter outcomes, and the missed arbiter deadline with literal states. Run `npm test`.
- [ ] `packages/core/test/credits.test.ts` covers the Monday grant, the cap at 100, and no mid-week growth. Run `npm test`.
- [ ] Run `npm run typecheck`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `pv-sol-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Bid as Devon at trunk and head and read `GET /api/me/credits`. Save `bid-charge.png`. Pass when both show 30 then 20, and at head a client cancel returns Devon to 30.
- [ ] Lane 2. Bid, then advance the clock 73 hours with no client action. Save `no-response-return.png`. Pass when Devon's credits return to 30.
- [ ] Lane 3. Verify a job and advance the clock 73 hours. Save `silence-release.png`. Pass when the job shows PAID with authority `REVIEW_SILENCE` and one payout item.
- [ ] Lane 4. Verify a job, click **Open dispute**, and advance 73 hours. Save `dispute-paused.png`. Pass when the job stays VERIFIED in DISPUTED.
- [ ] Lane 5. Resolve a dispute to release through the arbiter route. Save `arbiter-release.png`. Pass when the job shows PAID.
- [ ] Lane 6. Resolve a dispute to refund. Save `arbiter-refund.png`. Pass when the job shows REFUNDED with one sandbox refund.
- [ ] Lane 7. Leave a dispute undecided for 49 hours. Save `arbiter-missed.png`. Pass when the job shows PAID with `ARBITER_SLA_MISSED` and an alert row exists.
- [ ] Lane 8. With one receipt, advance the clock from Thursday to Monday. Save `weekly-grant.png`. Pass when credits read 30 before Monday and 40 after.
- [ ] Lane 9. Seed an operator with eight receipts and advance to Monday. Save `grant-cap.png`. Pass when credits read 100.
- [ ] Lane 10. Spend all credits, then bid again. Save `no-credits.png`. Pass when the bid form shows a denial that says when credits return, and no bid is added.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Median `POST /api/commands` latency for `PlaceBid` at trunk and head, and `tick` duration with 200 jobs at head.
- [ ] Probe. `node scripts/perf/commands.mjs --bids 100` alternates trunk and head instances in rounds of 10, then times `tick` on a seeded 200-job database at head.
- [ ] Baseline. Record the trunk `PlaceBid` median first.
- [ ] Rule. Fail if the head median exceeds trunk by more than 20 percent. Fail if `tick` takes more than 200 ms without PayPal calls.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 3 and lane 4 screenshots into `data/evidence/review/F4-review-silence.png` and `data/evidence/review/F4-review-dispute.png`.
- [ ] Record a 30 to 60 second video of opening a dispute with `agent-browser record`. Save it as `data/evidence/review/F4-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. Stop at STACK-READY. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends F4 to the base-branch stack, and the operator lands it bottom-up.

## Ship the operator CLI from the tutorial (F5)

**Depends on.** F4.

**Files.**

- [ ] Edit `packages/acquit-cli/src/main.ts`.
- [ ] Create `packages/acquit-cli/src/login.ts`, `operator.ts`, `agent.ts`, `jobs.ts`, `bid.ts`, `run.ts`, `diff.ts`, and `receipts.ts`.
- [ ] Create `packages/runner/Dockerfile` and `packages/runner/run.mjs`.
- [ ] Edit `apps/api/src/server.ts` for the CLI login exchange.
- [ ] Create `packages/acquit-cli/test/cli.test.ts` and `scripts/perf/cli.mjs`.
- [ ] Create `.factory/skills/verify-acquit/features/11-operator-cli.md`.

**Build.**

- [ ] Add `acquit login`. It opens the web app with a one-time code, waits for sign-in, and stores the token under the user profile.
- [ ] Add `acquit operator init`. It checks PayPal onboarding for the operator's merchant, and stores the provider key in Windows Credential Manager, never in a file.
- [ ] Add `acquit agent create`, `jobs list`, `bid`, `diff`, and `receipts` with the tutorial's output blocks.
- [ ] Add `acquit run`. It clones the work repo with a scoped token, starts the runner container with network limited to the package registry and the model provider, and runs the agent. It supports runner `claude-code` and runner `command`, which runs a script the operator names.

**You see.**

- [ ] `acquit bid job_X --price 400 --eta 2d --agent ts-bugfixer --pitch "..."` prints the tutorial's `Bid sent on` block ending in `Credits spent: 10 (20 left this week)`.
- [ ] `acquit run job_X` prints `Preparing sandbox for job_X` and `Agent finished`, then `Review the diff: acquit diff job_X`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/acquit-cli/test/cli.test.ts` renders each command's output from fixed API replies and asserts it against the matching tutorial block, character for character. Run `npm test`.
- [ ] Run `npm run typecheck`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `pv-sol-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has only `acquit submit`, so record that. At head, run login, bid, run, and submit on one job. Save `cli-path.png`. Pass when every printed block matches `docs/tutorial.md` except ids, times, and durations.
- [ ] Lane 2. Run `acquit login` and finish sign-in in the lane's browser. Save `login.png`. Pass when the terminal prints `Signed in as devon-ops (operator)`.
- [ ] Lane 3. Run `acquit operator init`. Save `operator-init.png`. Pass when it prints the three steps and `Bid credits: 30 (weekly allowance)`, and a search of the lane's data folder finds no provider key.
- [ ] Lane 4. Run `acquit agent create ts-bugfixer` with the tutorial's prompt file. Save `agent-create.png`. Pass when it prints `Prompt: prompts/ts-bugfixer.md (5 lines)`.
- [ ] Lane 5. Run `acquit jobs list`. Save `jobs-list.png`. Pass when the header and the job row match the tutorial's columns.
- [ ] Lane 6. Run `acquit run` with a `command` runner that edits `tests/totals.test.ts`. Save `run-tamper.png`. Pass when it prints `Changed files: tests/totals.test.ts (1 line)` and a request from the container to `example.com` fails.
- [ ] Lane 7. Run `acquit diff` after lane 6. Save `diff.png`. Pass when it prints the tutorial's test diff.
- [ ] Lane 8. Run `acquit run --instruction` with a `command` runner that fixes `src/money.ts`, then `acquit submit`. Save `run-fix-submit.png`. Pass when submit prints the VERIFIED block.
- [ ] Lane 9. After the client approves, run `acquit receipts`. Save `receipts.png`. Pass when it prints the receipt line and `Weekly bid credits: 40 from Monday (30 + 10 for 1 receipt)`.
- [ ] Lane 10. If an Anthropic key is available, run `acquit run` with the `claude-code` runner on a fresh job. Save `claude-run.png`. Pass when the agent finishes and the changed files are under `src/` or `tests/`. Without a key, report BLOCKED with that reason.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk has no operator CLI beyond `submit`. At head, `acquit jobs list` wall time and `acquit run` time from start to agent start, warm.
- [ ] Probe. `node scripts/perf/cli.mjs --rounds 5` runs `jobs list` and a `command` runner `run` five times each after one warm-up. It also times trunk's `acquit submit --help` and head's for a like-for-like start cost.
- [ ] Baseline. Record trunk's `acquit submit --help` median first.
- [ ] Rule. Fail if head's `--help` median exceeds trunk by more than 20 percent. Fail if `jobs list` exceeds 800 ms or the warm run start exceeds 30 seconds.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and lane 3 screenshots into `data/evidence/review/F5-review-path.png` and `data/evidence/review/F5-review-init.png`.
- [ ] Record a 30 to 60 second terminal video of login, bid, and run by capturing `tuistory` screenshots and joining them with `ffmpeg`. Save it as `data/evidence/review/F5-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. Stop at STACK-READY. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends F5 to the base-branch stack, and the operator lands it bottom-up.

## Run the House agent with its own payee and receipts (F6)

**Depends on.** F5.

**Files.**

- [ ] Create `packages/house/runner.ts`.
- [ ] Edit `packages/core/src/operator.ts`, `scripts/seed.ts`, and `packages/core/src/seed-data.ts`.
- [ ] Edit `apps/web/src/pages/JobPage.tsx`.
- [ ] Create `packages/house/test/house.test.ts`.
- [ ] Create `.factory/skills/verify-acquit/features/12-house.md`.

**Build.**

- [ ] Seed `house-tsfix` with `OPERATOR_HOUSE_MERCHANT_ID` and remove the fallback to Devon's merchant. The seed fails with a clear message when the id is missing.
- [ ] Compute the House line from receipt rows. Seeded history rows carry `source: SEED`, and the label counts them with real receipts.
- [ ] When the client accepts the House bid, `packages/house/runner.ts` runs the `command` runner with the honest fix and submits through the same Submit edge.
- [ ] Have the `pv-opus-medium` delegate render the House row as `House (quality bar): tsfix` with `41 fixes, 39 passed verified CI`.

**You see.**

- [ ] The job page shows `House (quality bar): tsfix    400.00 USD  1 day   house-ts-fixer    41 fixes, 39 passed verified CI` below the operator bids.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/house/test/house.test.ts` asserts the House label from a receipts table of 41 rows with 39 paid, and a seed run without the House merchant id fails. Run `npm test`.
- [ ] Run `npm run typecheck`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `pv-sol-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open a job and bid as Devon at trunk and head. Save `house-row.png`. Pass when both show the House bid below Devon's, and head shows the quality-bar label and `41 fixes, 39 passed verified CI`.
- [ ] Lane 2. Accept the House bid and pay. Save `house-delivers.png`. Pass when the House runner submits and the job reaches VERIFIED.
- [ ] Lane 3. Approve the House job. Save `house-paid.png`. Pass when the payout item for the capture goes to the House merchant id, not Devon's.
- [ ] Lane 4. After lane 3, open a new job. Save `house-count.png`. Pass when the House line reads `42 fixes, 40 passed verified CI`.
- [ ] Lane 5. Trigger the House bid for a job twice. Save `house-once.png`. Pass when the job has one House bid and the second attempt is refused with `HOUSE_ALREADY_BID`.
- [ ] Lane 6. Read House credits before and after a House bid. Save `house-credits.png`. Pass when House spends no credits and Devon's balance is unchanged.
- [ ] Lane 7. Give Devon fewer receipts than House and open a job with both bids. Save `house-below.png`. Pass when Devon's bid still sorts above the House section.
- [ ] Lane 8. Open a job that gets no operator bids. Save `house-only.png`. Pass when the page shows the House section with its label and an empty operators section.
- [ ] Lane 9. Time the House bid after Open job. Save `house-latency.png`. Pass when the House bid shows on the job page within 5 seconds.
- [ ] Lane 10. Read the funding checks for the House job. Save `house-payee.png`. Pass when the order's payee matches `OPERATOR_HOUSE_MERCHANT_ID` and differs from Devon's.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Median `GET /api/jobs/:id` latency for a job with both bid sections at trunk and head.
- [ ] Probe. `node scripts/perf/ledger.mjs --requests 200 --with-house` alternates trunk and head instances in rounds of 20 requests.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail if the head median exceeds trunk by more than 20 percent plus 2 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and lane 3 screenshots into `data/evidence/review/F6-review-row.png` and `data/evidence/review/F6-review-paid.png`.
- [ ] Record a 30 to 60 second video of the job page with both sections with `agent-browser record`. Save it as `data/evidence/review/F6-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. Stop at STACK-READY. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends F6 to the base-branch stack, and the operator lands it bottom-up.

## Finish the web pages and run the whole tutorial (F7)

**Depends on.** F6.

**Files.**

- [ ] Create `apps/web/src/pages/SignUp.tsx` and `apps/web/src/pages/OperatorProfile.tsx`.
- [ ] Edit `apps/web/src/pages/NewJob.tsx`, `apps/web/src/pages/JobPage.tsx`, `apps/web/src/router.tsx`, and `apps/web/src/App.tsx`.
- [ ] Edit `apps/api/src/server.ts` for `GET /api/operators/:handle`.
- [ ] Create `scripts/tutorial-run.mjs` and `scripts/perf/web.mjs`.
- [ ] Create `.factory/skills/verify-acquit/features/13-tutorial.md`.

**Build.**

- [ ] Add the sign-up path with **I want work done**, **I deliver work**, GitHub sign-in, and the App install step that shows `Connected: issues, pull requests, checks`.
- [ ] Show the checkout substate on the job page (creating the order, waiting for approval, capturing) with the price breakdown and the payee.
- [ ] Switch the job page from the proof-first bid layout to the ledger spine after Accept, per `scratch/job-page/shots/`.
- [ ] Add the operator profile at `/o/:handle` with fixes, verified passes, and receipts.
- [ ] Add `scripts/tutorial-run.mjs`. It drives every tutorial step through the web UI and both CLIs and diffs each output block against `docs/tutorial.md`, ignoring only ids, times, and durations.
- [ ] Split F7 into one PR per page if a page does not fit in one PR, keeping the tutorial run in the last one.

**You see.**

- [ ] `node scripts/tutorial-run.mjs` prints one `MATCH` row per tutorial output block and ends with `tutorial: all blocks match`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/tutorial-run.mjs --self-test` diffs the tutorial against itself and against one changed block, and asserts `MATCH` and `DIFF` for them. Run `node scripts/tutorial-run.mjs --self-test`.
- [ ] Run `npm run typecheck` and `npm test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `pv-sol-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run sign-in, post, bid, and accept at trunk and head. Save `client-path.png`. Pass when both reach checkout and head shows the checkout substate, the price breakdown, and the payee.
- [ ] Lane 2. Run the sign-up path for a new client. Save `sign-up.png`. Pass when the dashboard shows the repo with `Connected: issues, pull requests, checks`.
- [ ] Lane 3. Open a job from issue 12. Save `job-opened.png`. Pass when the page shows the tutorial's opened block with the frozen commit, 48 tests, and 6 hidden tests.
- [ ] Lane 4. Accept and pay, watching the page. Save `checkout-substates.png`. Pass when the page shows each checkout substate in order, then `Escrow: HELD, locked to devon-ops`.
- [ ] Lane 5. Compare the job page before and after Accept. Save `layout-switch.png`. Pass when the bids use the proof-first layout before and the ledger spine after.
- [ ] Lane 6. Approve and release in the dialog. Save `approve-dialog.png`. Pass when the page shows PAID, the merged PR, and the receipt.
- [ ] Lane 7. Open a dispute on a verified job. Save `dispute-ui.png`. Pass when the page shows the dispute and the arbiter deadline.
- [ ] Lane 8. Open `/o/devon-ops` after one paid job. Save `profile.png`. Pass when it shows `1 fix, 1 passed verified CI` and the receipt.
- [ ] Lane 9. Walk the client path by role and label only at a 390 px wide viewport. Save `narrow-a11y.png`. Pass when every action has a named control and no page scrolls sideways.
- [ ] Lane 10. Run `node scripts/tutorial-run.mjs` against the sandbox on a fresh lane. Save `tutorial-run.png`. Pass when every block prints `MATCH` and the run ends with a merged PR, a 360.00 USD payout item to Devon, and a verified receipt.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Job page time to the bid list visible, at trunk and head, on a seeded job with two bids.
- [ ] Probe. `node scripts/perf/web.mjs --loads 10` alternates trunk and head lanes and reads navigation timing through `agent-browser eval`.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail if the head median exceeds trunk by more than 20 percent or exceeds 1.5 seconds.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 4, lane 5, and lane 10 screenshots into `data/evidence/review/F7-review-checkout.png`, `F7-review-layout.png`, and `F7-review-tutorial.png`.
- [ ] Record a 30 to 60 second video of the client path from sign-up to PAID with `agent-browser record`. Save it as `data/evidence/review/F7-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. Stop at STACK-READY. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends F7 to the base-branch stack, and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Tick the gf-feature boxes in `docs/roadmap.md` with links to the evidence, and add a decision log row for each decision made during the program.
- [ ] Reply to the operator with links to the stack root and tip, a one-line verdict summary per link, and anything parked or excluded with the reason.

## Appendix A. Prototype evidence

All prototypes are throwaway and uncommitted. They live in `scratch/` on the `main` working tree at `08b63c3`, so they have no branch or SHA of their own. Each folder's `RESULT.md` holds the raw output.

### The four gf-prototype results

- **a. Ledger.** The TypeScript reducer runs the product, and Bend2 proves the same three laws for the demo. `bend --check-only bad.bend` rejected a double payout in a median of 0.32 seconds warm. The first run took 44.57 seconds to build the kernel. See `scratch/bend2-ledger/RESULT.md`. F1 implements the reducer.
- **b. PayPal escrow.** A DELAYED order with `platform_fees` 44.85 released exactly 360.00 USD to the operator. Release is guarded by the job's HELD to RELEASED edge, because event-id dedupe alone paid twice. A plain full refund works, and a refund that names `platform_fees` fails. See `scratch/paypal-escrow/RESULT.md` and `run6.log`. F2 builds on it.
- **c. Verifier.** Frozen inputs plus protected-path rejection plus all 54 tests completing. The `cheat-assertion` branch passed both earlier variants. See `scratch/verifier/RESULT.md`. The judge prototype below closes that gap.
- **d. Job page.** Variant 2 (proof first) for choosing a bid, then variant 3 (ledger spine) after Accept. See `scratch/job-page/shots/`. F7 builds it.

### The architecture's open questions, measured on 2026-10-05

- **The payee cannot change after order create. Measured.** A PATCH replacing the payee of order `32W4554603639194E` returned HTTP 422 `NOT_PATCHABLE`. A PATCH of `platform_fees` returned HTTP 204 and changed 44.85 to 45.85. So the lock to one operator is PayPal's, and the fee can still move before approval. See `scratch/paypal-probes/P1.log`.
- **A buyer-free sandbox capture exists. Measured.** An order created with a sandbox test card as `payment_source.card` came back with completed DELAYED captures `7UF934978D4719827` and `22K75987MS815804V`. Each netted the seller 363.78 USD, not 360.00, because the card fee is lower than the wallet fee. See `P2.log`. H0's dev card source uses this.
- **PayPal honors `PayPal-Request-Id` on release and refund. Measured.** A repeat with the same id returned HTTP 200 and the same resource id. A new id returned HTTP 422, `PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE` for release and `CAPTURE_FULLY_REFUNDED` for refund. Refund `7RJ16571JG198034E` completed once. How long PayPal keeps the request id is not measured. See `P3.log`. F2 relies on it.
- **The reimbursement goes out as a Standard Payout. Measured.** Batch `2NZDCGL49SRBG` paid Devon 15.15 USD with `SUCCESS` and a 0.25 USD payout fee to the platform. A repeat `sender_batch_id` returned HTTP 400 `USER_BUSINESS_ERROR` naming the first batch. See `P4.log`. F2 uses it.
- **Real webhook events cannot be fetched from PayPal for replay. Unproven.** Registering `PAYMENT.REFERENCED-PAYOUTS-ITEM.COMPLETED` failed, because the event name is not in the catalog. A webhook with three valid events registered, but 13 filtered queries and one unfiltered query returned no events after fresh captures and refunds. Fetching by id and resend stay untested. Both webhooks were deleted. See `P5.log`. F2 records deliveries locally and replays those, and confirms release by lookup instead of a payout event.
- **Hidden tests cross the process boundary. Measured for the child-process subject.** The judge held the expected values and sent only `{ id, target, args }` in 1,296 calls. The honest fix verified 48/48 and 6/6 in a median of 623 ms. The local matcher cheat, the JSON serializer cheat, and the forged-reply cheat were all REJECTED. A first-reply-wins parser would have passed the forged transcript, so duplicate ids must void the run. The Docker subject is unproven, because the daemon was down. See `scratch/verifier-judge/RESULT.md`. F3 builds it.
- **The approval link's expiry is unproven.** Order `34B01703W6431550L` still read `PAYER_ACTION_REQUIRED` when the probe returned. A poller (PID 14528) appends its status every ten minutes to `scratch/paypal-probes/expiry.log` until 2026-10-05 22:37 UTC. The root reads that log at program start and records whether the three-hour checkout window outlives the link. A status read does not prove the link still opens.

### Sandbox state the probes left

No capture is left HELD. Capture A was released, and captures B, C, and D were refunded. Two unapproved orders remain and expire on their own.

## Appendix B. Alternatives rejected

**The roadmap's PR order, 1 to 7, lost to H0, F1, F3, F2, F4, F5, F6, F7.** In the roadmap order, the PayPal adapter (F2) comes before the verifier (F3). Release needs a VERIFIED job, and only the verifier makes one, so F2's live lanes could never reach a release through user actions. They would be left with unit fixtures and refunds. With F3 first, every lane in F2 drives the real path from submit to PAID. The cost is that F3's third rejection ends in REFUND_PENDING with no refund until F2 lands, a state that exists only between two adjacent links of one stack.

**Running the ten lanes one after another lost to the H0 harness.** The verify-acquit skill allows one instance per machine, because ports, the run file, sessions, and the allowed origin are shared. Ten serial lanes at about five minutes each make every verdict take close to an hour, and fix rounds repeat that. H0 removes the sharing (separate before serializing) instead of queueing around it. It also closes three gaps the skeleton left open, which are PID reuse in `stop`, the hardcoded web port in the origin check, and the hardcoded PayPal return URLs.

**Adding the operator commands to the control CLI lost to a rename.** The control CLI already answers to `npm run acquit` and has its own `login`. The tutorial's `acquit` is a published operator CLI. Keeping both under one name would mix dev-only commands such as `seed-db` and `clock` into the product. H0 renames the control CLI to `ctl` and migrates every caller in the same PR. F3 and F5 build `@acquit/cli` in `packages/acquit-cli`.

**A separate GitHub PR lost to folding GitHub into F3 and F2.** The gf-feature list has no GitHub row, but the tutorial needs a work repo, a PR on the client repo, a green check, and a merge after release. The verifier is the only consumer of the work repo and the check, so F3 owns them. The merge follows release, so F2 owns it. A ninth PR would have had no surface of its own to verify.

**A true GitHub fork per job lost to a pushed per-job repo.** GitHub allows one fork of a repository per owner, so `acquit-forks` could hold only one fork of `invoice-app` at a time, and ten lanes would collide. Pushing the frozen commit to `acquit-forks/<repo>-<job>` has no such limit. The PR on the client repo comes from a branch the App pushes there after VERIFIED, so it does not need a fork network. This is inferred from GitHub's documented fork rule and is not measured. It needs the GitHub App, which is an operator item.

**The child-process subject lost to the Docker subject.** Both kept assertions out of submitted code in the prototype. The child process still runs as the same user, so submitted code could read the judge manifest, `.env`, or host files. Docker with no network and read-only mounts closes that. The Docker path is unmeasured because the daemon was down.

**A real model in every CLI lane lost to the `command` runner.** The tutorial's first attempt is an agent that edits a test. A real model does not cheat on cue, and ten lanes of real model calls cost money and give different output each run. Operators bring their own agent, so a runner that runs the operator's script is a real product feature, not a stub. One lane in F5 still runs `claude-code` when a key exists.

**Seeding the House history by running 41 sandbox jobs lost to labeled seed rows.** Real releases need a buyer approval per job and would take hours. The seed rows carry `source: SEED`, so the count stays honest in the data. The operator can tell the root to cut the House history to real receipts only, which shows `0 fixes` until House completes jobs.

**Stubbing PayPal for post-HELD lanes lost to real sandbox calls.** The verify-acquit Hard rules forbid stubs, and the money rules are the product. The dev clock moves time, not state, so deadlines and review windows run through their real edges.

## Appendix C. Risks

**No buyer password blocks the checkout lanes.** This lands in H0 and every later PR. `SANDBOX_BUYER_PASSWORD` is not set. Lanes that fund through checkout, including every regression lane that pays and F7's tutorial run, report BLOCKED until it is. Other lanes use the dev card source.

**Card funding changes the processor fee.** This lands in H0, F2, and F4. A card capture netted the seller 363.78 USD, not the 360.00 USD a PayPal wallet capture gives, so PayPal's fee was 11.37 instead of 15.15 (Appendix A, P2). Lanes funded by card must assert RELEASED equal to the capture's observed net and a matching `PROCESSOR_FEE_VARIANCE` line, never the literal 360.00. Only lanes funded through buyer checkout assert the tutorial numbers. The quote in `paypal.ts` predicts the wallet fee, so a real card buyer would get a variance line too.

**Webhook signatures stay unverified.** This lands in F2. PayPal cannot reach localhost, and the probe's webhook event list stayed empty, so no real signed delivery exists to test against. The handler re-reads every resource from PayPal, so a forged event can only point at a real PayPal resource whose state the job already guards. Signature checking needs a public URL, which means exposing a port. That is the operator's call, and the plan does not do it.

**No remote blocks trunk reads and PRs.** This lands in Arm the program. `main` has no remote, so `git show origin/main:` and `gh pr create` fail. The operator's Track 0 task, due 2026-10-06, clears it.

**The Docker daemon is down.** This lands in F3 and F5. The verifier's container subject and the runner both need Docker. The owner checks `docker info` before building and reports BLOCKED if it fails. The prototype's Docker variant has no measured verdicts or timings.

**Lanes share sandbox merchants.** This lands in F2, F4, and F6. Ten lanes pay the same Devon merchant at once, so a balance delta proves nothing. Lanes assert per-capture payout items and refunds. Sandbox rate limits are not measured. The owner watches for HTTP 429 and lowers lane concurrency if it appears.

**House shares Devon's merchant until the operator adds one.** This lands in F6. `scripts/seed.ts` falls back to Devon's merchant today. F6 removes the fallback, so F6 is blocked until `OPERATOR_HOUSE_MERCHANT_ID` exists.

**The GitHub App is an operator item.** This lands in F3, F2, and F7. Without it, nothing pushes the work repo, opens the PR, posts the check, or merges. The per-job repo design is inferred, not measured.

**The subject can fabricate answers it can guess.** This lands in F3. The judge separates assertions, but a hostile subject that knows a hidden case can return the expected value. Hidden cases stay secret only while they stay off the subject's mounts and out of the repo. The prototype's static screen is lexical and can be bypassed. The process split is the real guard.

**Hidden tests that need more than an exported function.** This lands in F3. The prototype settled exported pure functions for the invoice fixture only. A job whose behavior needs a CLI or HTTP call needs a different call kind. The hackathon demo uses only the invoice fixture, so this stays a known limit.

**PayPal timing is outside our control.** This lands in F2. A GET on an order returned a transient 503 once. Approve-to-PAID depends on sandbox latency, so the 20 second budget can fail for PayPal's reasons. The perf lane records PayPal's share of each run separately.

**The machine has 8 GB of memory.** This lands in every PR. On 2026-10-05, 904 MB was free, and `gh` crashed with `cannot allocate memory` during the repo push. Ten lanes run in waves at the cap `lanes.mjs` computes, so a verdict takes several waves. The root counts a lane that dies from memory as a gap, not a pass or a failure, and reruns it in the next wave.

**The tuistory binary is not on PATH.** This lands in F1 and F5. The tuistory skill is listed, but `tuistory` did not resolve on 2026-10-05. The owner installs it per its skill before the first CLI lane. `ffmpeg` and `agent-browser record` are present.

**The PayPal Partner application gates live payouts, not the sandbox.** This lands after the program. The demo runs in the sandbox, so the program does not wait for it.

## Appendix D. Links and reading list

Read these before editing.

- `docs/tutorial.md` is the usage spec. Every output block is a pass predicate for F7 lane 10.
- `docs/architecture/rationale.md` is the approved design. Its transition table maps each tutorial step to one edge.
- `docs/architecture/http.md` is the contract between the web app and the API. Update it in every PR that adds a route.
- `docs/roadmap.md` holds the roles, the decision log, and the done-when boxes.
- `docs/concept.md` holds the product rules behind the decision log.
- `.factory/skills/verify-acquit/SKILL.md` and its feature map hold the Hard rules every lane follows.
- `scratch/paypal-escrow/RESULT.md`, `scratch/paypal-probes/RESULT.md`, `scratch/verifier/RESULT.md`, and `scratch/verifier-judge/RESULT.md` hold the measured PayPal and verifier facts.

Run the **how** skill before building F2 and F3, because both touch money or the trust boundary across several modules. Run the **interrogate** skill on F2's reconcile and redispatch rule and on F3's RPC parser before their code-ready report. Both are contested designs where a wrong rule pays twice or passes a cheat. Skip both for H0, F1, F4, F5, F6, and F7. Their designs are set by the rationale.

Keep the decision trail per the show-me-your-work skill in `data/trail/decisions.tsv`, one row per root decision and per tick. Each owner keeps its own `decisions.tsv` and `children.tsv` uncommitted and returns them in its report. Commit the root trail with the Close the program reply, because the stack moves money and needs an auditable record.
