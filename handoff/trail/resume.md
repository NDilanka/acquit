# Acquit autopilot-stack resume note

Updated 2026-10-06 after parking the session.

Run `/poteto-mode` with the Autopilot-stack playbook and load the `verify-acquit` skill. The trunk has no `pstack/` path. Read the playbook from the plugin copy at `C:\Users\A S U S\.factory\plugins\marketplaces\pvstack\plugins\pvstack\skills\poteto-mode\playbooks\autopilot-stack.md`. Its SHA-256 prefix was `007C0A3B1201` at every tick.

## Intent
Build and verify the gf-feature roadmap as one linear stack on https://github.com/NDilanka/acquit. The roadmap is `docs/roadmap.md` and the plan is `docs/plan.md`. The operator lands the stack and the root never merges. The order is H0, F1, F3, F2, F4, F5, F6, F7. The root owns topology, verdicts, rebases, and pushes. Each PR gets one fresh owner per round, working in `D:\dev\Apps\acquit-worktrees\<pr>`. Each round has a live lane worker plus two audits from different model families.

## State of the stack
- **H0.**
  - PR #1, branch `stack/h0-lanes` at `2a27d59`, base `main`.
  - Verdict CLEAN. The verdict comment is https://github.com/NDilanka/acquit/pull/1#issuecomment-6008852746, with the text in `data/trail/h0-verdict.md`.
  - H0 is the stack root.
- **F1.**
  - PR #2, branch `stack/f1-ledger` at `6fec296`, base `stack/h0-lanes`.
  - Verdict CLEAN. The verdict comment is https://github.com/NDilanka/acquit/pull/2#issuecomment-6012108758, with the text in `data/trail/f1-verdict.md`.
  - GitHub reported PR #2 as MERGEABLE.
  - Lane 1 was accepted on round-2 HELD evidence.
- **F3.**
  - The worktree `D:\dev\Apps\acquit-worktrees\f3` is on branch `stack/f3-verifier`. It is at `6fec296` and clean, with no F3 commits. Root `.env` is already copied there.
  - The first owner (pv-ds-max, task b5f093b5) was stopped before writing anything.
  - Next step: spawn a fresh F3 backend owner with the brief below.
- **F2, F4, F5, F6, F7.** Not started.
- **The hourly audit Loop is cancelled.** Re-arm it in the new session with the `Loop` tool, cron `17 * * * *`. Use the tick prompt verbatim from `docs/plan.md` (Program checklist, Arm the program).

## Model routing (operator's rule)
- The role sheet is `C:\Users\A S U S\.factory\pvstack-models.md`.
- DeepSeek V4.1 Flash does all building and heavy work:
  - `pv-ds-max` for owners, fix rounds, and code audits.
  - `pv-ds-high` for swarm workers.
  - `pv-ds-low` for lookups.
- GPT-6.1 Sol (`pv-sol-high`) does the judging: the verdict audit and synthesis.
- Front-end work keeps the Balanced droid:
  - Web UI code under `apps/web/` goes to `pv-opus-medium`, per the plan.
  - Browser-driven live lanes go to `pv-sol-high`.
- The per-round audit pair is `pv-ds-max` plus `pv-sol-high`.
- The root reads each fix diff before launching the next round.
- DeepSeek escape count is 1. It missed the null FEE processor false green in F1 round 4, which Sol caught.

## Operator blockers (unchanged)
- **GitHub App and org.** The GitHub App `Acquit sandbox` and the `acquit-forks` org are missing. `.env` has no `GITHUB*` names. F3 needs them for the work repo and the VERIFIED PR flow.
- **Docker.** Docker Desktop is down, so `docker info` fails. F3's Docker subject and F5's runner need it.
- **House merchant.** `OPERATOR_HOUSE_MERCHANT_ID` is missing. F6 needs it.
- **Respawning agent-browser daemon.** An `agent-browser.exe` daemon that is not part of any lane respawns within seconds of being killed. It runs headless Chrome with a temp profile and its parent process is gone. It makes the H0 approval guard refuse PayPal approval, so do not kill it again. Accept checkout lanes on earlier evidence unless the operator stops whatever spawns it.

## F3 owner brief (re-dispatch on pv-ds-max)
- **Scope.** Unit-scope F3 per `docs/plan.md` lines ~216-283.
- **Blocked dependencies.** The GitHub App and Docker are missing, so put them behind interfaces with fakes. They must fail with named errors such as `GITHUB_APP_NOT_CONFIGURED` and `DOCKER_UNAVAILABLE`, never hang.
- **Test subject.** The child-process subject is the unit-test path.
- **Front end.** Do not touch `apps/web/src/pages/JobPage.tsx`. Expose the attempt history and verifier result through the API projection instead. The root later spawns a `pv-opus-medium` front-end delegate for the page.
- **Fixtures.** They live at `D:\dev\Apps\unnamed\scratch\verifier\invoice-app` (git branches) and `scratch\verifier-judge\setup.mjs`. `scratch/` is gitignored.
- **Commits.** Commit early in green units with the factory-droid co-author trailer. No push and no PR, because the root does both.
- **Gates.** `npm run typecheck`, then `npm test` twice. Record judge wall time for each branch.
- **Evidence.** `data/evidence/f3-r1-build`.

## Follow-ups carried forward
- **F2.**
  - A state-vs-book agreement check: for example, CLOSED plus a HELD book prints `Laws: OK` today.
  - Decide what happens when `refundTreasury` gets a retained fee of zero.
- **F1 lows, all failing closed.**
  - Null `bids` gives `IO_FAILED`.
  - `jobs` on a null state gives `IO_FAILED`.
  - A zero-row jobs table passes `--check`.
  - A null FEE component renders as `0.00`.
- **H0 latent issues.**
  - The ownership preload can read a truncated `run.json` ("Unexpected end of JSON input").
  - The readiness and real-listener dashboard tests are flaky under load.
  - The stream race.
  - Daemon PID spoofing.
  - Bare taskkill and git calls in the dev and perf scripts.
  - The base64, NFD, and numeric-entity redaction gaps.
  - Unix ownership is unsupported.

## Hard rules
- **Secrets.** Never print secrets. `SANDBOX_BUYER_PASSWORD` is in the root `.env`. Copy the whole `.env` into each new worktree; it is gitignored.
- **Browsers.** Strip every `AGENT_BROWSER_*` environment variable from browsers you start. Never attach to the operator's desktop browser.
- **Processes.** Only stop processes you started. Verify by port and by a command line that names the worktree. Stop lanes with `npm run -s ctl -- stop`, setting `ACQUIT_LANE`.
- **Protected state.**
  - Do not reset lane 9 in F1. It holds a funded fixture.
  - Lanes 61 and 62 belong to the ledger perf probe.
  - Leave `D:\dev\Apps\unnamed\index.html` and `data/acquit.db` alone.
- **Memory.** The machine has 8 GB of RAM. Run browser lanes serially. The perf probe needs three apps at once with no browser running.
- **Connections.** They drop often. Tell agents to commit early and write evidence as they go. After a drop, probe the side effects (git log, evidence mtimes, processes) and clean up orphans: dead parent and a command line that names the worktree.
- **gh.** Set `GOMEMLIMIT=256MiB` before running `gh`.
- **Decision trail.** Log every decision as a row in `data/trail/decisions.tsv`, with columns ts, phase, decision, why, evidence, result.
