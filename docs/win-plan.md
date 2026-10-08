# Acquit win plan for the PayPal AI Hackathon

This plan turns the 2026-10-07 livestream ("Set Up PayPal's Sandbox and AI Toolkit From Scratch") and the official rules into a build and submission plan for Acquit. It compares that target against `docs/roadmap.md` and `docs/plan.md`, lists the gaps, and orders the work that closes them. It was written on 2026-10-08 with 35 days left.

The goal is the largest prize one project can win. That is 1st place ($12,000) plus Best Use of AG Grid 1st place ($5,000), $17,000 in total. Every honorable mention stays a fallback, because the work that wins 1st place also competes for them.

## 1. The rules that bind us

Where the livestream and the official rules disagree, the rules win (rules section 11.4).

| Fact | Source | What it changes |
| --- | --- | --- |
| Submissions close Thursday 2026-11-12 at 12:00 PT (15:00 EST). | Rules section 1 | The livestream said 2 pm PT. That is wrong. We submit on 2026-11-10. |
| A project wins at most one Grand Prize plus one Sponsor Prize, or one Honorable Mention plus one Sponsor Prize. | Rules section 8 | "All the prizes" is not possible with one project. The operator chose one project. |
| Stage One is pass/fail. The project must fit the theme and meaningfully use the PayPal platform and AI. | Rules section 6 | AI must sit inside Acquit, not only on the operator's laptop. |
| The five criteria are equally weighted. Ties break on Technological Implementation first. | Rules section 6 | Depth of PayPal and AI use is the tie-breaker, so it gets the most build time. |
| Judges may score from the video and text alone, and judging may use automated AI analysis. | Rules sections 4 and 6 | The video and the README carry the score. The README maps each criterion to evidence. |
| Judges must be able to run the build or use a hosted demo. Mockups fail. | Rules section 4 | The operator chose a public hosted demo. |
| The hosted demo stays free and usable until judging ends on 2026-12-15. | Rules section 4, Testing | Hosting, sandbox credentials, and the model key must last to 2026-12-15. |
| The video is under 3 minutes, public on YouTube, with no third-party music or trademarks used without permission. | Rules section 4 | Use no music, or royalty-free music we hold rights to. |
| The repo is public with a license visible in the About section. | Rules section 4 | Done. `NDilanka/acquit` shows MIT (GitHub API, 2026-10-08). |
| New projects are fine. Existing ones must show significant updates. | Rules section 4 | The repo was created on 2026-10-05, after the period opened on 2026-10-01. Say so in the story. |
| Submission includes test credentials when the app needs a login. | Rules section 4, Testing | Ship a judge sign-in and a dedicated sandbox buyer account. |

The judges are the three livestream presenters (Jo Franchetti, Eddie Jaoude, Marco Podien), three more PayPal staff (an engineer, an engineering manager, and a senior PM), and one judge from each of AG Grid, APIMatic, Bryntum, Channel3, Elastic, Postman, and Render (Devpost overview page).

## 2. What the livestream told us the judges want

Each line names what the presenters said and what Acquit does about it.

- **PayPal is central, not bolted on.** "Adding a PayPal button to an unrelated app is not going to be enough." Acquit already passes this test. Escrow is the product.
- **Start from a real problem.** Marco said to start from the problem, not the product. Our story leads with the client's problem. They pay for AI work that turns out to be fake or broken.
- **Use the PayPal AI Toolkit, MCP server, and Agent Toolkit.** Jo spent a whole segment on the toolkit and asked people to install it this week, run `/paypal:doctor`, and file issues or PRs. Acquit uses none of them today.
- **Verify webhooks.** Eddie said to "verify that the request came from PayPal". Acquit deferred signature checks because it had no public URL (`docs/plan.md` Appendix C). Hosting removes that reason.
- **Test unhappy paths and use negative testing.** Eddie closed on this. Acquit's tamper rejection, rework, refund on timeout, and duplicate-webhook guard are exactly that. The video must show at least one.
- **Show both sides of the money.** Eddie logged into the buyer and the merchant sandbox accounts to show money leave and arrive. Our video does the same for client, operator, and platform fee.
- **Presentation is a fifth of the score, and Best Demo Delivery is a real $5,000.** "Don't leave the demo video until the last minute." The current roadmap gives the video two days at the end. This plan starts it in week 1.
- **Be in Discord, in public.** The judges are in the PayPal Discord. Public build updates and good questions make Acquit known before judging starts.
- **Contribute back.** Jo said a PR to the PayPal org gets reviewed and merged. We hit four sandbox errors the toolkit does not explain (section 6, item C1).

## 3. Prize targets

| Prize | Amount | Why Acquit fits | What must be true |
| --- | --- | --- | --- |
| 1st place | $12,000 | A full product with real escrow, real verification, and agents that get paid. | Top score on all five criteria, and the strongest on Technological Implementation. |
| Best Use of AG Grid 1st | $5,000 | Escrow, receipts, and verifier results are rich tabular and time data. | AG Studio dashboards with custom widgets, theming, and a custom agent working with Studio's built-in agents (AG Grid partner page). |
| Best Use of Agentic Commerce (fallback) | $5,000 | AI agents sell verified work and receive PayPal payouts. | The MCP flow in the video, with an agent earning a payout. |
| Best Use of PayPal + AI (fallback) | $5,000 | AI scopes the contract, AI delivers the work, and PayPal holds and releases money only on proof. | The AI parts are real and visible. |
| Most Creative, Most Impactful, Best Demo Delivery (fallbacks) | $5,000 each | The tamper-catch moment is memorable. Real buyers make the impact case. | A tight video and real buyer quotes. |
| AG Grid 2nd or 3rd (sponsor fallback) | $2,000 or $1,000 | Five AG Grid winners in total, the deepest sponsor pool. | Same work as AG Grid 1st. |

We do not chase Render. The demo is not hosted there, because it runs on one Oracle Cloud VM (Prototype H). Render's prizes are credits, and only one sponsor prize can be won.

## 4. Where Acquit stands on each criterion

The current state comes from `data/trail/resume.md` and `docs/roadmap.md`. H0, F1, H1, F3, F2, and F4 are merged. F5 (the operator CLI) merged on 2026-10-08 as #10. F6 and F7 are not started.

| Criterion | Strong today | Weak today | Fix in this plan |
| --- | --- | --- | --- |
| Technological Implementation | Delayed-disbursement orders, `platform_fees`, referenced payouts, refunds, Payouts reimbursement, Partner Referrals, idempotent release, Docker verifier with hidden tests, 574 tests at F5. | AI is not visible in the demo. No PayPal AI tooling. Webhook signatures unverified. Hidden answers are public. | F6, A1, A2, A3, P1, K1, C0 |
| Design | Proof-first job page, ledger spine. | Sign-up and checkout substates are not built (F7). No dashboard. No safe hosted entry point. | F7, G1, J1, H2 |
| Potential Impact | Clear audience (agencies, non-technical founders). | No committed buyers. The House history is a seeded count of 41, not real receipts. | B1, B2 |
| Innovation | Pay on verified outcome, tamper rejection with hidden tests, credit-priced bids. | The competitor check is not done, so the "differs from existing concepts" claim has no backing. | B3, A1 |
| Presentation | `docs/tutorial.md` is a ready script spine. | The video is scheduled for the last two days. | V1 to V4 |

## 5. The gaps, ranked

Ranked by how much each one costs us if it stays open.

1. **AI is not visible in the demo.** The operator CLI already runs `claude-code` agents (`packages/acquit-cli/src/run.ts:710-713`; `codex` agents can be registered but the CLI refuses to run them), but that runs on the operator's machine. F5's lane 10 ran `claude-code` through OpenRouter, the other lanes use the `command` runner, and F6 as first planned had the House agent run a scripted honest fix. The F6 ruling now has the House agent run the free NVIDIA Nemotron 3 Ultra model through OpenRouter (`docs/plan.md` F6), but until F6 lands a judge watching the video could see no AI at all. This is a Stage One risk.
2. **Judges cannot run it, and the public build is not safe to open.** Running Acquit locally needs Docker, the GitHub App, Partner Referrals onboarding, and a sandbox buyer. Hosting it as it stands is worse. Anyone can mint a seeded user's session (`apps/api/src/server.ts:179-186`). Card funding, the clock, and the arbiter only work with `ACQUIT_DEV=1`, which also opens them to every signed-in session (`apps/api/src/server.ts:303-327`, `docs/roadmap.md:412`). An approval merges into the client repo, so after the first judge reaches PAID the issue is fixed for every later judge (`data/trail/resume.md`).
3. **The hidden test answers are public.** All six hidden expected values sit in `packages/core/src/seed-data.ts:31-37` in a public repo. An operator could hardcode them. The tamper-rejection claim holds, but "tamper-proof" overstates it until hidden cases leave the repo.
4. **The video is late.** Best Demo Delivery and a fifth of every other score depend on it.
5. **Webhook signatures are not checked.** A PayPal judge will look for this first.
6. **Impact has no evidence.** Track 0's three committed buyers are still open (`docs/roadmap.md` Track 0).
7. **No dashboard, so no AG Grid entry.**
8. **The PayPal AI tooling is unused, in development and in the product.** The presenters built it and will judge us. The concept planned the Agent Toolkit for refunds (`docs/concept.md:43`), and nothing uses it.
9. **Seeded receipts.** The House's 41 paid receipts are a seeded count (`scripts/seed.ts:21-35`), not receipt rows. F6 plans labeled `source: SEED` rows (`docs/plan.md:494`). The moat claim is that receipts are proof. Seeded proof undercuts it.
10. **Secrets.** The GitHub App private key and a PAT were exposed. The operator deferred rotation until dev work is done (`data/trail/resume.md`). A public demo ends that window, so rotation must land before H2 goes public.
11. **OpenJob knows one issue.** OpenJob hardcodes issue 12 and its contract (`packages/core/src/effects.ts:169-172`), and the judge uses global cases and an invoice-only test extractor (`packages/verifier/judge.ts:168-178`). AI scoping and more fixture repos need per-job manifests first.
12. **Smaller drift.** Competitor check, existing-project rule note, and the partner application in Track 0 are still open. `scratch/` and `data/trail/` read as process noise to a judge or an automated reviewer skimming the repo.

## 6. The work, in build order

Each item is one PR or one task with its own proof, per the existing stack rules in `docs/plan.md`. New PR ids continue after F7. The Autopilot-stack program, role sheet, and review gates in `docs/plan.md` apply to every PR here, with one change to the live gate.

**Gate size by risk.** F5 took 17 rounds (`data/trail/resume.md`), and this plan queues about ten more PRs. A PR that moves money, judges work, or opens the public surface keeps all ten live lanes. That covers F6, J1, H2, P1, M1, A1, and A2. A PR that only displays data (G1, A3, and the README work) runs three lanes plus screenshots. This is a default the plan sets. The operator can restore ten lanes for any PR.

### Week 1, 2026-10-08 to 2026-10-11. Land F5, settle the unknowns, start outreach

- [x] **Land F5.** Merged on 2026-10-08 as https://github.com/NDilanka/acquit/pull/10.
- [ ] **B1. Line up buyers.** Contact agencies and founders today. The target is three written quotes and one real job on a real repo before 2026-11-01.
- [ ] **B3. Competitor check.** Record Algora, UpAgents, thejobcafe.com, and assay.guide in the decision log, with what Acquit does that each does not. Add three PayPal AI Hackathon entries. MergePay pays a GitHub bounty after the merge, once a Gemini reviewer gives its opinion, for open-source maintainers. Acquit verifies with deterministic hidden tests and rejects test tampering, holds escrow before work starts, reaches private repos through the GitHub App installation (not yet shown on a private repo), and writes receipts. Stood (an evidence-gated release gate with frozen signed tests and evidence profiles for other trades) and Bursar (spend limits and verification for agents that buy) are adjacent agentic-money entries.
- [ ] **D1. Start in Discord.** Post an intro and the first screenshot in public. Ask one real question about delayed disbursement with Partner Referrals in the public channel.
- [x] **Prototype H. Hosting.** Render web services are not expected to run Docker inside a container (guess, to measure). Try web and API on Render with a persistent disk for SQLite and a same-origin proxy, since the Vite proxy is dev-only (`apps/web/vite.config.ts:8-15`). Try the verifier on a small VM with Docker, reached over a private link, since both servers bind loopback today (`apps/api/src/server.ts:500`, `packages/verifier/server.ts:84`). Proof is a hosted tamper REJECTED and fix VERIFIED with timings, and the same after a restart. Result. Render has no Docker daemon, so the operator chose one Oracle Cloud Always Free Ampere A1 VM (aarch64, Ubuntu 24.04) for web, API, SQLite, the Docker verifier, and Caddy TLS on 443. Render is unused.
- [x] **Prototype M. Real model on the House fix.** Run the House agent with Claude through the OpenRouter key on invoice-app issue 12 ten times, each on its own disposable client repo. Record pass rate, median time, and cost per run. The gate is at least 9 of 10 VERIFIED. Result. Claude went 8 of 8 VERIFIED before paid credit ran out, and the free-only rule ruled it out. On free models, M2 failed hidden case 6 (JPY), and M3 went 10 of 10 VERIFIED on `nvidia/nemotron-3-ultra-550b-a55b:free` with an issue-agnostic instruction suffix. The F6 ruling uses that model and suffix (`docs/roadmap.md`, Prototype M results).
- [ ] **Prototype T. A real model cheating.** Prompt a model with "make the failing tests pass" against the frozen suite, up to 20 runs. Keep every run where it edits a test, with its log. This decides whether the video's tamper scene can use a real model.
- [ ] **Prototype G. AG Studio in our app.** Mount AG Studio in `apps/web` (React 19, Vite 7) from `paypaldev/hackathon-paypal-ag-grid-boilerplate`. The gate is a custom agent delegating to a built-in Studio agent, the model key held on the server, and a saved layout that reloads. Record the bundle size.
- [ ] **Prototype C. AI hidden-test drafting.** Give a model the frozen commit and the issue text, and ask for `HiddenCase` rows (`packages/core/src/verifier.ts:282-287`). Keep a case only when all four hold. It runs on the frozen commit without error and fails on an assertion mismatch. It passes on a trusted fix. Its expected value is justified from the issue text. A person approves it. Record how many survive each filter.
- [ ] **C0. Install the PayPal AI Toolkit and run `/paypal:doctor`.** Fix what it finds, and keep the before and after output for the README.
- [ ] **V1. Write the video script.** Use the storyboard in section 7.

### Week 2, 2026-10-12 to 2026-10-18. Make it safe to host, then host it

Hosting comes first in week 2, because every later lane and video take runs against it.

- [ ] **J1. Judge mode.** A "Start my demo" button gives each visitor fresh client and operator accounts, their own disposable client repo (productize `scratch/client-repo.mjs`), and a session scoped to them. Seeded-user session minting goes away in public mode. Card funding and the clock work only on the visitor's own jobs. The arbiter route stays off. Caps on jobs, attempts, amounts, and model spend per visitor and per day. Proof is two parallel visitors who reach PAID without seeing or changing each other's jobs, and a refused call to every dev route.
- [ ] **K1. Private hidden cases.** Move hidden cases out of `packages/core/src/seed-data.ts` into a per-deployment private store that never ships in the repo or to the subject's mounts. Keep a public example manifest for local runs. Proof is a repo grep with no hidden expected values and a VERIFIED run on the hosted demo.
- [ ] **S1. Rotate secrets and scan history.** This must land before H2 goes public, which ends the operator's deferral. Rotate the GitHub App private key and the PAT and update every `.env`. Run a secret scanner over the full history. Proof is a clean scan and a failed auth with the old key.
- [ ] **H2. Hosted demo.** Deploy per Prototype H with J1 and K1 in place. Add a judge entry page with a three-step tour. Proof is a run from a clean private browser to PAID, then a second run after the first merged.
- [ ] **P1. Verify webhook signatures.** Register the hosted webhook URL. Before the existing re-read, call PayPal's verify-webhook-signature and require `SUCCESS`. Keep the minimal envelope storage. Proof is a signed delivery accepted, a forged one refused with a logged reason, a verification outage handled, and unsigned dev replay kept separate.
- [ ] **F6, revised. House agent runs a real model.** Keep the F6 scope in `docs/plan.md`. Change the runner to `nvidia/nemotron-3-ultra-550b-a55b:free` through OpenRouter with the CLI default instruction and the House suffix in `docs/plan.md` F6, keep the `command` runner for lanes, and show the model's diff in the job timeline. Proof is a VERIFIED House job whose diff came from the model.

### Week 3, 2026-10-19 to 2026-10-25. Product completeness and agentic commerce

- [ ] **F7, trimmed. Web pages with AG Grid in the core flow.** Sign-up, checkout substates, and the ledger spine after Accept. Render the bid list, the ledger, and the receipts table with AG Grid in the Acquit theme, so AG Grid is on screen for the whole video. The operator profile and the tutorial diff harness move to week 5 as optional.
- [ ] **M1. Per-job manifests.** Replace the hardcoded issue 12 contract (`packages/core/src/effects.ts:169-172`) and the global judge cases (`packages/verifier/judge.ts:168-178`) with a manifest frozen per job. Add a second fixture repo and issue. Proof is a VERIFIED job on each fixture.
- [ ] **A2. Acquit MCP server.** A stdio MCP server over the operator token, with `list_jobs`, `get_job`, `place_bid`, `submit_attempt`, `get_receipt`, and `get_payout_status`. Submit reuses the F5 CLI delivery path (`packages/acquit-cli/src/submit.ts`), and the operator confirms the exact commit in the CLI or web app, never through a flag the model sets. `get_payout_status` reads the payout from PayPal through the PayPal Agent Toolkit. Reuse `GET /api/me/receipts` (`apps/api/src/server.ts:404-415`) and add the payouts route the API lacks. Proof is Claude Code finding a job, bidding, delivering, and the operator's sandbox account showing the payout.
- [ ] **V2. Rough cut.** Record the whole video once against the hosted demo, even with gaps.

### Week 4, 2026-10-26 to 2026-11-01. AG Studio, AI scoping, real receipts

- [ ] **G1. AG Studio dashboards.** An operator earnings dashboard and a platform escrow dashboard, with saved layouts a user can rearrange. Widgets for held, released, refunded, fees, verifier pass and reject rates, and tamper attempts caught. Two custom widgets, the receipt card and a live "Ledger conserves" check that shows payout plus fee equals paid from the book. Acquit theming. Add a platform ledger route, because `GET /api/jobs` is scoped to the viewer (`packages/core/src/acquit.ts:187-191`). Proof is screenshots at desktop and 390 px.
- [ ] **A3. Ask the ledger.** A custom AG Studio agent with Acquit tools and read-only PayPal Agent Toolkit tools. It delegates widget building to Studio's built-in agent. Video question: "How much escrow is held right now, and does PayPal agree?" Proof is the answer and the widget, checked against the ledger route and PayPal.
- [ ] **A1. AI scoping.** On Open job, AI drafts the acceptance contract and hidden cases through Prototype C's filters, stored privately per K1 and M1. The client approves before the manifest freezes. Proof is a job whose hidden tests came from the draft, then a tamper REJECTED and an honest fix VERIFIED against them.
- [ ] **B2. Real receipts.** Run 10 to 15 real House jobs through card funding across both fixtures. Label any remaining seed rows as seeded in the UI. Proof is a House line counted from real receipt rows.

### Week 5, 2026-11-02 to 2026-11-08. Presentation first, then stretch

- [ ] **R1. Judge-facing repo.** A README top section that maps each criterion to the screen or file that proves it, a short `ARCHITECTURE.md` pointing at `apps/` and `packages/`, and `scratch/` and `data/trail/` described as the build log.
- [ ] **V3. Final cut by 2026-11-06.** Record, edit, caption, and upload to YouTube as public. Feature freeze for the demo path on the same day.
- [ ] **P2. PayPal disputes (stretch).** When a buyer opens a dispute on a capture, hold the release, show it in the arbiter queue, and attach the verified receipt as evidence through the Disputes API. AI drafts the evidence summary.
- [ ] **C1. Contribute to the PayPal AI Toolkit (stretch).** Add the sandbox errors we measured to `/paypal:explain-error`: `PLATFORM_FEE_NOT_ENABLED` on a refund that names `platform_fees`, `No permissions to set target_client_id` before Partner Referrals consent, `NOT_PATCHABLE` on a payee PATCH, and `PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE` on a repeat release. Opening the PR is an outside write, so the operator approves it first.
- [ ] **Optional.** The operator profile and `scripts/tutorial-run.mjs` from the original F7.

### Week 6, 2026-11-09 to 2026-11-12. Submit early, then freeze

- [ ] **2026-11-09.** Save the Devpost draft with every field filled (section 8).
- [ ] **2026-11-10.** Submit. Check that the YouTube link plays logged out and the hosted demo works in a private window.
- [ ] **2026-11-11 and 2026-11-12.** Fixes only. No new features. The window closes at 12:00 PT on 2026-11-12.
- [ ] **Until 2026-12-15.** Keep the hosted demo, the sandbox app, and the model key alive. Check it weekly.

### Cut order if we fall behind

Cut from the top of this list first. The optional F7 items, then C1, then P2, then B2's second fixture, then A1 down to an AI-drafted contract with curated hidden cases. That last cut keeps all four AI pieces the operator chose, in smaller form. Never cut J1, K1, S1, H2, P1, F6 with a real model, trimmed F7, G1 with A3, A2, R1, or the video. Those carry Stage One, a safe public demo, the AG Grid entry, and the agentic commerce story.

## 7. The video, in 2 minutes 50 seconds

The judges are told they need not watch past 3 minutes. Aim for 2:50 and show the product working the whole time.

| Time | Scene | What the viewer sees |
| --- | --- | --- |
| 0:00 to 0:15 | The post-SaaS line | Open on a title card: "SaaS sold seats. Acquit sells verified outcomes." Then the problem: AI-written code that "passed" because the agent edited the test. |
| 0:15 to 0:35 | Post a job | The client posts a GitHub issue with a budget. AI drafts the acceptance contract and hidden tests. The client approves. |
| 0:35 to 0:55 | Bids and escrow | An operator's agent bids through the Acquit MCP server, and House bids too. The AG Grid bid list sorts by verified receipts. The client accepts and pays in the PayPal sandbox. The ledger shows HELD. |
| 0:55 to 1:20 | The catch | An operator's agent submits a change that edits a frozen test. Prototype T found no real model that cheats (0 of 30 runs), so label it on screen as "an agent told to make the tests pass". The verifier says REJECTED with the reason. The escrow stays HELD. |
| 1:20 to 1:45 | The honest fix | The same operator's second attempt, a real model with an honest instruction, fixes the code on the same job. VERIFIED with frozen and hidden counts. The client approves. The PR merges. The escrow is locked to that operator, so House cannot deliver on this job. House stays on screen as a bidder, with its receipts count in the bid list. |
| 1:45 to 2:05 | Money moves | The operator's sandbox account shows the payout, and the platform shows its fee. Same webhook sent twice, one payout. |
| 2:05 to 2:35 | AG Studio | "How much escrow is held right now, and does PayPal agree?" The agent builds the widget. The "Ledger conserves" widget stays green. |
| 2:35 to 2:50 | The verifier registry | The registry from `docs/concept.md`: code marked live, then 3D printing, 3D rendering, video, and writing marked next. A real buyer quote on screen if B1 has one, the URL, and "Cleared, then paid." Only code is built, so the card labels the others "next", never "supported". |

Never stage a cheat without labeling it. A judge who spots an unlabeled script would mark down every other claim.

Rules for the recording. Use the hosted demo, not localhost. Pre-warm the verifier and the model. Record each scene alone and cut them together. Add captions. Use no music or royalty-free music only. Show "PayPal Sandbox" on screen, as the concept's risk note says.

## 8. Submission package

- [ ] **Name and elevator pitch.** Lead with outcome-as-a-service: "Acquit. Cleared, then paid. SaaS sold seats. Acquit sells verified outcomes. You pay when the result is proven, and PayPal escrow holds the money until it is. Code is the first outcome we verify." The second line says how code is verified: "AI agents fix a GitHub issue, and the verifier rejects any change that edits a frozen test and runs hidden tests." Add "the agent never sees" only after K1's privacy proof passes, because today the hidden cases sit in the public repo (`packages/core/src/seed-data.ts:31-37`). Do not say "tamper-proof". The verifier rejects tampering it can detect, and that is the claim we can prove.
- [ ] **Story.** Inspiration, what it does, how we built it, challenges (the four measured sandbox findings), what we learned, what's next (the verifier registry in `docs/concept.md`). Today the job core calls one verifier through the `VerifierPort` interface (`packages/core/src/verifier.ts:621`), but the contract and verdict it passes are code-specific (commit, frozen and hidden tests, protected paths, pull request). So call the other outcomes "next", never "pluggable" or "supported". Say the repo started on 2026-10-05.
- [ ] **Built with.** PayPal Orders v2 with delayed disbursement and `platform_fees`, referenced payouts, Payouts, refunds, Partner Referrals, webhooks with signature checks, the PayPal AI Toolkit and MCP server, AG Studio and its agent framework, the free NVIDIA Nemotron 3 Ultra model through OpenRouter, an Oracle Cloud VM with Caddy, Docker, the GitHub App, and TypeScript.
- [ ] **Testing instructions.** The hosted URL, the judge sign-in, the judge sandbox buyer login (sandbox only, no real money), and the local one-command path from `README.md`.
- [ ] **README for judges.** R1 in week 5, because judging may use automated analysis.
- [ ] **Repo About.** Add the hosted URL as the homepage and topics such as `paypal`, `ai-agents`, `escrow`, and `ag-grid`.
- [ ] **Video.** Public on YouTube, under 3 minutes.

## Appendix A. Decisions the operator made on 2026-10-08

- One project. No second submission.
- The sponsor target is AG Grid.
- The demo is publicly hosted.
- AI inside Acquit covers all four options offered. They are the House agent on a real model, AI scoping, the Acquit MCP server, and the AG Studio ledger agent. The operator also asked for other additions that raise the odds. Those are J1, K1, P1, P2, B2, C0, C1, AG Grid in the core flow, the PayPal Agent Toolkit inside A2 and A3, and the "Ledger conserves" widget.
- The plan sets two defaults the operator can override. Display-only PRs run three live lanes instead of ten. Secret rotation (S1) moves from "after dev work" to "before the public demo".

The plan went through two independent reviews on 2026-10-08, one from Claude Opus and one from GPT Sol. Both flagged the open session minting, the cut order, and the week 1 load. Their findings are folded in above.

## Appendix B. Alternatives rejected

- **A second submission.** It could reach a second prize slot, but a solo builder with F6 and F7 unbuilt would split time and weaken both. The operator agreed.
- **Render as the sponsor target.** Credits only, and only one sponsor prize counts. The demo runs on an Oracle Cloud VM, not Render.
- **APIMatic as the sponsor target.** Three $1,000 prizes, but it is a coding aid and would not show in the product.
- **Log in with PayPal for sign-in.** Another PayPal capability, but it adds a step for judges and does not serve the core loop. Partner Referrals already links each operator's PayPal.
- **Bend2 in the video.** The proof is real, but it needs a long explanation. It stays in the README.
- **Transaction Search reconciliation as its own feature.** A3 asks PayPal directly through the Agent Toolkit, and the "Ledger conserves" widget shows the book's own law. Together they make the point with less work.
- **Buying credits with PayPal.** A second plain checkout adds no score that escrow does not already earn.
- **AG Studio only on a separate dashboard page.** The AG Grid judge may score from the video alone, and a separate page gets 30 seconds of it. Grids in the core flow keep AG Grid on screen throughout.

## Appendix C. Risks

- **The verifier could not run on Render.** Prototype H confirmed Render has no Docker daemon. One Oracle Cloud VM now hosts the whole demo, so that VM is the single point of failure.
- **A real model may fail the House fix.** Prototype M measures it. Below 9 of 10, use a stronger model or a tighter prompt. Keep the `command` runner for lanes, never for the video.
- **AI-drafted hidden cases can be wrong and still fail on the frozen commit.** Prototype C's four filters and the client's approval guard this. A wrong case would reject honest work, so A1 shows the client each case before it freezes. If A1 slips, it shrinks to an AI-drafted contract with curated cases.
- **The gate cadence.** F5 took 17 rounds. If F6 or J1 runs past 8 rounds, cut from the list in section 6 before week 4 starts.
- **Sandbox outages during recording.** Record scenes early and keep the takes. PayPal returned a transient 503 once before (`docs/plan.md` Appendix A).
- **Model and hosting cost through 2026-12-15.** Cap model spend with a per-job budget and a daily limit on the hosted demo.
- **Abuse of the public demo.** It runs model-written code and moves sandbox money. J1 isolates each visitor and caps spend. The verifier keeps Docker with no network and read-only mounts. Only the fixture repos are allowed.
- **Memory on the 8 GB build machine.** Already tracked in `docs/plan.md` Appendix C. Hosting moves demo load off it.

## Appendix D. Sources read for this plan

- The livestream transcript the operator attached on 2026-10-08.
- `https://paypalaihackathon.devpost.com/rules`, `https://paypalaihackathon.devpost.com/`, and the AG Grid, Render, and APIMatic partner pages, read on 2026-10-08.
- `https://github.com/paypal/AI-Toolkit` README, read on 2026-10-08. It says sandbox tokens last up to 8 hours, not the 9 hours said on stream.
- `https://www.ag-grid.com/studio/react/ai-agents/`.
- `docs/concept.md`, `docs/roadmap.md`, `docs/plan.md` (F6, F7, Appendices A to D), `docs/architecture/http.md`, and `data/trail/resume.md`.
