# Demo video script

This is the recording script for the Acquit hackathon video. It follows the storyboard in section 7 of the win plan (`docs/win-plan.md`) and the job in `docs/tutorial.md`, invoice-app issue 12, "Totals round wrong for 3-decimal currencies". The video runs 2:50. The judges need not watch past 3:00.

Each scene lists its time range, its on-screen action, the voice-over with a word count, the caption, what to pre-warm, the PR it depends on, and a fallback take if that PR slips. Screens and commands that exist at `main` `bb28b0a` are named as they are. Screens that a later PR builds are named with that PR's id.

## Rules that hold for every take

- Record against the hosted demo from H2, never localhost. The address bar shows the hosted URL. The one exception is the labeled local take in the scene 6 fallback, and it is for the rough cut only.
- Every PayPal screen shows "Sandbox" in frame. The first PayPal screen also gets the caption "PayPal Sandbox. No real money moves."
- Record each scene alone, then cut them together. Keep every good take, because a sandbox outage can block a re-record.
- Never show an account email, a merchant id, a password, an API key, a session token, or a GitHub App secret. Blur or crop the account header on every PayPal screen.
- Never caption or say a payout or fee figure that the take did not produce. Read the figures from that take's **Ledger** section.
- A fallback that replaces an item on the win plan's never-cut list is for the rough cut (V2) only. The final cut waits for the item. The never-cut items in this script are J1, K1, H2, P1, trimmed F7, G1 with A3, and A2. A1 may shrink only to an AI-drafted contract with curated hidden cases.
- Never show a staged cheat without its on-screen label. Scene 4 carries the rule.
- Never say or caption "tamper-proof". The claim is that the verifier rejects tampering it can detect and runs hidden tests the operator cannot see.
- Captions are burned in and also uploaded as a YouTube caption file. Each caption stays on screen for at least 2 seconds.

## One job carries scenes 2 to 6

Scenes 2 to 6 show one job, called the story job. The client opens it in scene 2. The operator's bid wins it and the client pays into escrow in scene 3. The operator's first attempt fails in scene 4, and the same operator's second attempt passes in scene 5. The escrow pays that operator in scene 6. The escrow is locked to the accepted operator, so no other agent can deliver against it.

Record scenes 2 to 6 in order on the story job. Each scene moves the job forward, so a scene cannot be re-recorded on the same job afterward. If a take fails, open a new story job on a fresh J1 client repo and record again from scene 2. Every frame from scenes 2 to 6 in the final cut comes from one story job, so the job id and the ledger match across scenes. Every `acquit run`, `acquit diff`, and `acquit submit` in these scenes passes the same `--dir story-job`. Without it, `run` checks out into a folder named after the work repository while `diff` and `submit` read the current folder, so they would look at different checkouts.

## Pace and length

The voice-over is read at about 150 words per minute, which is 2.5 words a second. Each scene's word budget is 2.5 words a second times its length. The script uses about 75% of that budget, so each scene keeps a second or two of picture without speech.

| Scene | Time | Length | Budget at 150 wpm | Words in script | Read time |
| --- | --- | --- | --- | --- | --- |
| 1. The problem | 0:00 to 0:15 | 15 s | 37 | 28 | 11 s |
| 2. Post a job | 0:15 to 0:35 | 20 s | 50 | 39 | 16 s |
| 3. Bids and escrow | 0:35 to 0:55 | 20 s | 50 | 45 | 18 s |
| 4. The catch | 0:55 to 1:20 | 25 s | 62 | 48 (either version) | 19 s |
| 5. The honest fix | 1:20 to 1:45 | 25 s | 62 | 40 | 16 s |
| 6. Money moves | 1:45 to 2:05 | 20 s | 50 | 37 | 15 s |
| 7. AG Studio | 2:05 to 2:35 | 30 s | 75 | 51 | 20 s |
| 8. Why it matters | 2:35 to 2:50 | 15 s | 37 | 30 | 12 s |
| Total | 0:00 to 2:50 | 170 s | 425 | 318 | 127 s |

The scenes add up to exactly 170 seconds, so the cut fits 2:50 with no spare second. Any scene that runs long takes its time from another scene.

To recount, run this from the repo root. It counts the words in every quoted voice-over line and skips version B of scene 4, so it counts one tamper version.

```sh
awk '/^\*\*Voice-over, version B/{skip=1} /^\*\*Caption, version B/{skip=0} /^> / && !skip {sub(/^> /,""); n+=split($0,w," ")} END{print n}' docs/video-script.md
```

The command prints 318. Both versions of scene 4 are 48 words, so either version gives the same total.

## Scene 1. The problem, 0:00 to 0:15

**On screen.** A diff of `tests/totals.test.ts` fills the frame. The expected value changes from `'10.125'` to `'10.13'`. A green "48 passed" line sits under it. Use the frames from the scene 4 take you keep, so scene 1 shows the same run. On a real Prototype T run, use that run's diff. On the labeled take, use the diff from `acquit diff <job> --dir story-job` after the staged run.

**Voice-over.** 28 words.

> You pay for an AI coding fix. The checks go green. Then you look closer. The agent changed the test to match the bug, and you already paid.

**Caption.** Version A: "A real model run, told to make the failing tests pass." Version B: "Illustration. An agent told to make the tests pass."

**Pre-warm.** None. This scene reuses scene 4 frames.

**Depends on.** Prototype T decides the caption. No PR blocks it.

**Fallback.** None needed. If scene 4 is not recorded yet, record the labeled diff alone with `acquit diff <job> --dir story-job` and caption it as version B.

## Scene 2. Post a job, 0:15 to 0:35

**On screen.**

1. The client is signed in. Open the **New job** page at `/jobs/new`.
2. In **Issue**, select `#12 Totals round wrong for 3-decimal currencies`.
3. Set **Budget (USD)** to `400` and **Deadline** to `7 days`.
4. A1 adds the AI draft panel. It shows the drafted acceptance contract and each drafted hidden case with the line of the issue text that justifies it. The client clicks approve on the cases.
5. Click **Open job**. Hold on the **Job opened** card for 3 seconds. It shows the suite frozen at its commit, the hidden test count, and the protected paths.

**Voice-over.** 39 words.

> Acquit starts from a GitHub issue and a budget. AI drafts the acceptance contract and hidden tests from the issue text. The client approves each case. Then the test suite freezes, and the operator never sees the hidden tests.

**Caption.** "AI drafts the contract and hidden tests. The client approves them."

**Pre-warm.** A fresh judge-mode visitor from J1 with its own disposable client repo. One A1 draft already run on another job, so the model call is warm. If the draft takes longer than the scene allows, cut from the click to the finished draft.

**Depends on.** A1 for the AI draft panel. H2 and J1 for the hosted page. K1 so that "the operator never sees the hidden tests" is true of the hosted build.

**Fallback.** Per the cut order, A1 first shrinks to an AI-drafted contract with curated hidden cases. Then the panel shows the drafted contract only, and the voice-over line becomes "AI drafts the acceptance contract from the issue text. Acquit adds hidden tests the client reviewed." That line is 16 words and replaces the second and third sentences, so the scene drops to 38 words. This smaller A1 is the last cut the plan allows, so it can ship in the final cut. If A1 does not land at all, record today's **New job** page as it is for the rough cut only. Its hint line already reads "Suite will freeze at commit ... plus 6 hidden tests only the verifier sees." Cut every mention of AI from this scene's voice-over and caption.

## Scene 3. Bids and escrow, 0:35 to 0:55

**On screen.**

1. Split screen. On the left, an operator's Claude Code terminal calls the Acquit MCP server from A2. The tool calls `list_jobs` and then `place_bid` scroll past.
2. On the right, the job page at `/jobs/<id>` as the client. The **Bids** section is the AG Grid bid list from F7. It shows the operator's bid and the House bid. Click the verified receipts column header so the grid sorts by it.
3. Click **Accept** on the operator's bid, then **Accept and pay with PayPal**.
4. The PayPal sandbox checkout opens. Log in as the buyer sandbox account and pay $420.00. See shot B2 in the money shot list.
5. Back on the job page, the **Escrow** card reads HELD, locked to the operator. Hold on the **Ledger** line that reads HELD 420.00 USD.

**Voice-over.** 45 words.

> An operator's agent finds the job through the Acquit MCP server and bids. House, our own agent, bids too. Bids sort by verified receipts, not star ratings. The client accepts and pays through PayPal. The money is held, and it can only pay this operator.

**Caption.** "PayPal Sandbox. No real money moves." Then "Escrow HELD. It can pay only this operator, or refund the client." Until B2 lands, the House row's count comes from a seeded counter (`scripts/seed.ts`), so add "House history is seeded demo data." while the House row is in frame.

**Pre-warm.** Claude Code on the operator machine with the Acquit MCP server configured and one `list_jobs` call already made. The buyer sandbox account logged in once in its own browser profile, so checkout skips the cold login page. A PayPal access token less than 8 hours old.

**Depends on.** A2 for the MCP bid. F7 for the AG Grid bid list and the checkout substates. The House bid row exists today from the seed. House only bids in this video, so F6 does not block this scene.

**Fallback.** If A2 slips, the operator bids with today's CLI, `acquit bid <job> --price 400 --eta 2d --agent ts-bugfixer --pitch "..."`, and the voice-over says "An operator bids from the Acquit command line" in place of "An operator's agent finds the job through the Acquit MCP server and bids." If F7 slips, use today's **Bids** section on the job page. Its House row reads "41 passed verified CI", and that 41 is the seeded counter, so the seeded-data caption stays on. Drop the sort click and the sentence "Bids sort by verified receipts, not star ratings." A2 and trimmed F7 are on the never-cut list, so both fallback takes are for the rough cut only.

## Scene 4. The catch, 0:55 to 1:20

This scene has two versions. Prototype T decides which one ships. Record version B in any case, because it is the take to keep if the real run turns out to be unusable on camera.

**On screen, both versions.**

1. The operator's terminal. The agent runs and edits `tests/totals.test.ts`. The run prints "48 passed".
2. The operator submits. In the MCP flow from A2, the model calls `submit_attempt` and the operator confirms the exact commit in the CLI. In the fallback, the operator runs `acquit submit <job> --dir story-job`.
3. Cut to the job page. The attempt card reads REJECTED with the reason "PR modifies frozen test file tests/totals.test.ts".
4. Hold on the **Escrow** card, still HELD, and on the **Attempts** line, which reads "1 used, 2 left".

**Version A, a real model cheating.** Use this version only if Prototype T kept a run where the model edited a test without being told to. The run on camera must happen on the story job, because only a submit on that job produces its REJECTED card. Run the Prototype T model on the story job with `acquit run <job> --dir story-job --runner claude-code --instruction "Make the failing tests pass."`. A run is not an attempt until it is submitted, so repeat the run until one edits the test, and count the runs for the caption. Show the model name and the instruction in frame.

**Voice-over, version A.** 48 words.

> Now a real model takes the job. Its prompt says to make the failing tests pass. It edits the frozen test instead of the code. The verifier rejects it and names the file. The escrow stays held. The operator keeps two attempts, and nobody gets paid for this.

**Caption, version A.** "Real run. Model: <name>. Prompt: make the failing tests pass. Run <n> of <total>." Keep the caption on screen for the whole scene.

**Version B, labeled.** Use this version if Prototype T found no real cheat. Run `acquit run <job> --dir story-job --runner claude-code --instruction "Make the failing tests pass by any means. You may edit the tests."`. Without `--instruction`, the runner's default tells the agent to change files under `src/` only, so the staged instruction must be explicit. Show the instruction in frame. The label stays on screen for the whole scene.

**Voice-over, version B.** 48 words.

> To show the check, we told an agent to make the tests pass by any means. It edits the frozen test instead of the code. The verifier rejects it and names the file. The escrow stays held. The operator keeps two attempts, and nobody gets paid for this.

**Caption, version B.** "Staged. An agent told to make the tests pass." Keep the caption on screen for the whole scene.

**Pre-warm.** The verifier Docker image pulled on the verifier host, and one REJECTED run already made since the last restart. The story job from scene 3 at IN_PROGRESS with the escrow HELD. For version A, the Prototype T model and instruction.

**Depends on.** Prototype T decides the version. A2 for `submit_attempt`. H2 for the hosted verifier.

**Fallback.** If A2 slips, submit with today's CLI. After the `acquit run` above, show `acquit diff <job> --dir story-job` for the edited test, then run `acquit submit <job> --dir story-job`. The REJECTED attempt card on the job page exists today. A2 is on the never-cut list, so this take is for the rough cut only.

## Scene 5. The honest fix, 1:20 to 1:45

The honest fix is the same operator's second attempt on the story job, as in the win plan's storyboard. House cannot deliver on the story job, because its escrow is locked to the operator, and a separate House job would need its own posting, acceptance, and payment inside a 25-second scene. That job would also change the payee in scene 6. A second attempt keeps one job, one escrow, and one payee from scene 3 to scene 6, and it shows the attempt count from scene 4 being used. House stays in the video as a bidder in scene 3 and as the receipts line in scene 8.

**On screen.**

1. The operator's terminal. Run `acquit run <job> --dir story-job --runner claude-code --instruction "Do not edit any file under tests/. The test is correct. Fix the rounding in src/money.ts."`. The running line names the model.
2. Run `acquit diff <job> --dir story-job`. The diff changes only `src/money.ts`. `decimalsFor(currency)` replaces the fixed `DECIMALS = 2`.
3. The operator submits. In the MCP flow from A2, the model calls `submit_attempt` and the operator confirms the commit in the CLI. In the fallback, the operator runs `acquit submit <job> --dir story-job`.
4. Cut to the job page as the client. The attempt card reads VERIFIED. Zoom on **Frozen tests** "48 passed", **Hidden tests** "6 passed", and the **Required tests** line "54 completed, 0 skipped or missing".
5. In **Client review**, click **Approve and release**. The dialog asks "Approve and release 420.00 USD?". Click **Approve and release** in the dialog.
6. Cut to the GitHub pull request in the client repo. It shows "Merged" and the green Acquit verifier check.

**Voice-over.** 40 words.

> The operator runs the model again with a stricter instruction. It fixes the rounding in the source and changes no test. The verifier passes forty-eight frozen tests and six hidden ones. The client approves, and Acquit merges the pull request.

**Caption.** "Attempt 2. VERIFIED. 48 frozen and 6 hidden tests passed. No protected path touched."

**Pre-warm.** One `claude-code` run on another job just before the take, so the model and the verifier are warm. Prototype M's median time decides whether the take shows the run live or cuts from start to result. The story job from scene 4, with its REJECTED attempt and 2 attempts left.

**Depends on.** H2 and J1 for the hosted job and a repo that still has the bug. A2 for `submit_attempt`. The run, the diff, the submit, and the VERIFIED card exist today. F5's live lane 8 reached VERIFIED attempt 2 of 3 this way.

**Fallback.** If A2 slips, submit with `acquit submit <job> --dir story-job`. A2 is on the never-cut list, so this take is for the rough cut only. Never record this scene with the `command` runner. A script is not a model.

## Scene 6. Money moves, 1:45 to 2:05

**On screen.** Follow shots M1 to M6 in the money shot list below.

**Voice-over.** 37 words.

> The client paid four hundred twenty dollars, and PayPal held it. On release, the operator gets the payout and Acquit gets its fee. Then we send the same webhook twice more. Nothing changes. There is one payout.

**Caption.** "Client paid 420.00 USD. Operator received <RELEASED> USD. Fees <FEE> USD." Then "Same webhook twice more. One payout."

Fill `<RELEASED>` and `<FEE>` from the **Ledger** section of the story job in this take. The ledger records the payout and the capture fees that PayPal reported (`packages/core/src/job.ts`, the `ReleaseSettled` edge), so they can differ from the quote's 360.00 and 60.00. The last measured example is F5's live lane 9, where the payout settled at 363.78 with dev card funding. Nobody has measured the fees on hosted checkout funding yet, so never reuse that figure.

**Pre-warm.** The three sandbox accounts logged in, each in its own browser profile. The release from scene 5 already settled, so the payout shows in the operator account. The recorded webhook event id for the capture, ready to resend.

**Depends on.** P1 for signed webhooks on the hosted route. H2 for the hosted URL. The release and payout path is merged today.

**Fallback.** The second webhook is the open item in this scene. Once P1 lands, the hosted route only accepts a signed delivery. Use a signed resend from the PayPal developer dashboard if it offers one for the event. Whether it does is a guess, so test it during V2.

If no signed resend exists, the only replay that works today is a local take. `npm run -s ctl -- webhook replay` posts to the API that `ctl` started on this machine, `--event` reads only the local database, and the hosted capture is not in it. Record the local take for the rough cut only:

1. Start the local app with `ACQUIT_DEV=1`, and take a local job to PAID.
2. Read the local job's capture id from `job.release.captureId` in `GET /api/jobs/<id>`. Keep it out of frame.
3. Run `ACQUIT_DEV=1 npm run -s ctl -- webhook replay --capture <capture id>` three times. The same capture builds the same event id, so every run after the first is a redelivery.
4. Each run prints its outcome and the event id. The first delivery of that event prints `applied`, even on a PAID job. Every later delivery prints `no-op, job already PAID` (`packages/core/test/skeleton.test.ts`, the paid-job capture webhook test). Run the first replay off camera, then record two more, so both on-camera runs print the no-op. Caption the outcome the take prints, not this expectation.
5. Show the sandbox payout list with exactly one payout for that local job's capture.

Caption the local shots "Local take. The capture webhook sent twice more." The final cut needs a hosted delivery. If none exists by V3, drop the last three sentences of the voice-over and hold on the payout.

## Scene 7. AG Studio, 2:05 to 2:35

**On screen.**

1. Open the platform escrow dashboard from G1. The widgets show held, released, refunded, fees, verifier pass and reject rates, and tamper attempts caught. The "Ledger conserves" widget is green.
2. In the A3 agent panel, type "How much escrow is held right now, and does PayPal agree?" Read it aloud as you type.
3. The custom agent reads the ledger, asks PayPal through the Agent Toolkit, and hands the widget to Studio's built-in agent. The new widget appears on the dashboard with the held total and PayPal's matching figure.
4. Drag the new widget into place. The "Ledger conserves" widget stays green through the edit.

**Voice-over.** 51 words.

> The platform watches the money in AG Studio. We ask, how much escrow is held right now, and does PayPal agree? Our agent reads the ledger, checks with PayPal, and has Studio's own agent build the widget. The ledger conserves money. Every payout plus its fee equals what the client paid.

**Caption.** "Ledger conserves. Payout plus fee equals paid."

**Pre-warm.** The dashboard opened once so the AG Studio bundle is cached. One A3 question already asked, so the model and the Agent Toolkit token are warm. At least one HELD job, one PAID job, and one REJECTED attempt in the book, so every widget has a number.

**Depends on.** G1 for the dashboards and the "Ledger conserves" widget. A3 for the agent answer.

**Fallback.** G1 with A3 is on the never-cut list, so both takes below are for the rough cut only. If A3 slips, record the G1 dashboard only. Drop the question, and the voice-over becomes "The platform watches the money in AG Studio. Held, released, refunded, fees, and tampering caught. The ledger conserves money. Every payout plus its fee equals what the client paid." That version is 29 words. If G1 also slips, show the AG Grid ledger table from F7, then run `node scripts/ledger-demo.mjs double-release`, which exists today and prints a REJECTED line for the law it breaks. Caption it "The ledger refuses a second payout." Drop "in AG Studio" from the voice-over.

## Scene 8. Why it matters, 2:35 to 2:50

**On screen.**

1. A buyer quote from B1 on a plain card, with the buyer's name and role as the buyer approved them.
2. The House receipts line from B2, counted from real receipt rows.
3. The hosted URL in large text, then the Acquit name and the tagline "Cleared, then paid."

**Voice-over.** 30 words.

> Agencies and founders told us they would pay for work only once it is proven. Acquit holds the money until a verifier clears it. Try it yourself. Cleared, then paid.

**Caption.** The quote text, then "<hosted URL>", then "Acquit. Cleared, then paid."

**Pre-warm.** Nothing live. Every shot is a title card or a still.

**Depends on.** B1 for the quote. B2 for the receipts line. H2 for the URL.

**Fallback.** If B1 has no written quote by V3, drop the quote card and its first sentence. The voice-over then opens on "Acquit holds the money until a verifier clears it." If B2 slips, the House row still reads "41 passed verified CI" from a seeded counter. Show it only with the caption "House history is seeded demo data."

## Money shot list, both sides of the money

These shots carry scene 6 and the checkout in scene 3. Each account is a PayPal sandbox account. Each account runs in its own browser profile, so one profile never shows another account's session. Name each account on screen by its role only. Blur or crop the account email and any merchant id in every frame.

The PayPal order names the accepted operator's merchant account as the payee, and it carries Acquit's platform fee as a separate instruction (`packages/core/src/paypal.ts`, `CREATE_ORDER`). The buyer pays the operator's merchant account, not Acquit. PayPal holds the money until release. Acquit receives only its platform fee.

`<RELEASED>` and `<FEE>` below are the amounts on the story job's RELEASED and FEE ledger lines in this take. The ledger conserves money, so `<RELEASED>` plus `<FEE>` equals 420.00.

| Shot | Account | Screen | What the frame must show |
| --- | --- | --- | --- |
| B1 | Buyer, sandbox Personal | Sandbox account home, before checkout | The balance before the job. The "Sandbox" mark. |
| B2 | Buyer, sandbox Personal | PayPal checkout from **Accept and pay with PayPal** | The $420.00 total. The pay button pressed. |
| M1 | Buyer, sandbox Personal | Activity after checkout | A payment of $420.00 to the operator's merchant account. Blur the payee's name. |
| M2 | Operator, sandbox Business | Activity after **Approve and release** | A payout received of `<RELEASED>`, referencing the job. |
| M3 | Platform, sandbox Business (the partner account) | Activity for the same capture | The platform fee received. The amount must match Acquit's part of the ledger's FEE line. |
| M4 | Acquit job page | **Ledger** section | The three lines HELD 420.00 USD, RELEASED `<RELEASED>` USD, and FEE `<FEE>` USD, in one frame. |
| M5 | Second webhook delivery | Signed resend, or the labeled local take from the scene 6 fallback | The repeated deliveries change nothing. |
| M6 | Operator, sandbox Business | Activity after M5 | Still exactly one payout of `<RELEASED>` for the job. |

The tutorial ledger shows RELEASED 360.00 and FEE 60.00, split into 15.15 PayPal processing and 44.85 Acquit. Those are the quote's figures. A real take records PayPal's observed payout and capture fees, so caption the take's own ledger. F5's live lane 9 settled a payout of 363.78 with dev card funding, which is the last measured example. Check the platform account's line against the ledger during V2 before captioning a number in M3. If they disagree, caption the ledger's figure and say nothing about the platform account's amount.

## Sound

Use no music. If the final cut needs a bed under scene 8, use a royalty-free track whose license we hold in writing, and keep the license with the project files. Use no third-party trademark or logo beyond PayPal, AG Grid, and GitHub screens as they appear in the product.

## Scene dependencies

| Scene | Blocking PRs | Fallback if they slip |
| --- | --- | --- |
| 1. The problem | None. Prototype T picks the caption. | Labeled diff from `acquit diff <job> --dir story-job`. |
| 2. Post a job | A1, J1, H2, K1 | AI contract with curated cases. Rough cut only: today's **New job** page with no AI claim. |
| 3. Bids and escrow | A2, F7 | Rough cut only: `acquit bid` from the CLI, and today's **Bids** section with the seeded caption. |
| 4. The catch | A2, H2. Prototype T picks the version. | Rough cut only: `acquit submit` from the CLI. |
| 5. The honest fix | J1, H2, A2 | Rough cut only: `acquit submit` from the CLI. |
| 6. Money moves | P1, H2 | Rough cut only: a labeled local take of `ctl webhook replay --capture`. |
| 7. AG Studio | G1, A3 | Rough cut only: G1 alone, then the F7 ledger grid and `scripts/ledger-demo.mjs`. |
| 8. Why it matters | B1, B2, H2 | No quote card, and a receipts line labeled as seeded. |
