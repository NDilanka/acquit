# Demo video script

This is the recording script for the Acquit hackathon video. It follows the storyboard in section 7 of the win plan (`docs/win-plan.md`) and the job in `docs/tutorial.md`, invoice-app issue 12, "Totals round wrong for 3-decimal currencies". The video runs 2:50. The judges need not watch past 3:00.

Each scene lists its time range, its on-screen action, the voice-over with a word count, the caption, what to pre-warm, the PR it depends on, and a fallback take if that PR slips. Screens and commands that exist at `main` `bb28b0a` are named as they are. Screens that a later PR builds are named with that PR's id.

## Rules that hold for every take

- Record against the hosted demo from H2, never localhost. The address bar shows the hosted URL.
- Every PayPal screen shows "Sandbox" in frame. The first PayPal screen also gets the caption "PayPal Sandbox. No real money moves."
- Record each scene alone, then cut them together. Keep every good take, because a sandbox outage can block a re-record.
- Never show an account email, an API key, a session token, or a GitHub App secret. Blur or crop the account header on every PayPal screen.
- Never show a staged cheat without its on-screen label. Scene 4 carries the rule.
- Never say or caption "tamper-proof". The claim is that the verifier rejects tampering it can detect and runs hidden tests the operator cannot see.
- Captions are burned in and also uploaded as a YouTube caption file. Each caption stays on screen for at least 2 seconds.

## Pace and length

The voice-over is read at about 150 words per minute, which is 2.5 words a second. Each scene's word budget is 2.5 words a second times its length. The script uses about 75% of that budget, so each scene keeps a second or two of picture without speech.

| Scene | Time | Length | Budget at 150 wpm | Words in script | Read time |
| --- | --- | --- | --- | --- | --- |
| 1. The problem | 0:00 to 0:15 | 15 s | 37 | 28 | 11 s |
| 2. Post a job | 0:15 to 0:35 | 20 s | 50 | 39 | 16 s |
| 3. Bids and escrow | 0:35 to 0:55 | 20 s | 50 | 45 | 18 s |
| 4. The catch | 0:55 to 1:20 | 25 s | 62 | 48 (either version) | 19 s |
| 5. The honest fix | 1:20 to 1:45 | 25 s | 62 | 41 | 16 s |
| 6. Money moves | 1:45 to 2:05 | 20 s | 50 | 38 | 15 s |
| 7. AG Studio | 2:05 to 2:35 | 30 s | 75 | 51 | 20 s |
| 8. Why it matters | 2:35 to 2:50 | 15 s | 37 | 30 | 12 s |
| Total | 0:00 to 2:50 | 170 s | 425 | 320 | 128 s |

To recount, run this from the repo root. It counts the words in every quoted voice-over line.

```sh
awk '/^> /{sub(/^> /,""); n+=split($0,w," ")} END{print n}' docs/video-script.md
```

The command counts both versions of scene 4 and prints 368. Both versions are 48 words, so the cut is 368 minus 48, which is 320 words.

## Scene 1. The problem, 0:00 to 0:15

**On screen.** A diff of `tests/totals.test.ts` fills the frame. The expected value changes from `'10.125'` to `'10.13'`. A green "48 passed" line sits under it. Use the frames from the scene 4 take you keep, so scene 1 shows the same run. On a real Prototype T run, use that run's diff. On the labeled take, use the diff from `acquit diff <job>` after the staged run.

**Voice-over.** 28 words.

> You pay for an AI coding fix. The checks go green. Then you look closer. The agent changed the test to match the bug, and you already paid.

**Caption.** Version A: "A real model run, told to make the failing tests pass." Version B: "Illustration. An agent told to make the tests pass."

**Pre-warm.** None. This scene reuses scene 4 frames.

**Depends on.** Prototype T decides the caption. No PR blocks it.

**Fallback.** None needed. If scene 4 is not recorded yet, record the labeled diff alone with `acquit diff <job>` and caption it as version B.

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

**Fallback.** Per the cut order, A1 first shrinks to an AI-drafted contract with curated hidden cases. Then the panel shows the drafted contract only, and the voice-over line becomes "AI drafts the acceptance contract from the issue text. Acquit adds hidden tests the client reviewed." That line is 16 words and replaces the second and third sentences, so the scene drops to 38 words. If A1 does not land at all, record today's **New job** page as it is. Its hint line already reads "Suite will freeze at commit ... plus 6 hidden tests only the verifier sees." Cut every mention of AI from this scene's voice-over and caption.

## Scene 3. Bids and escrow, 0:35 to 0:55

**On screen.**

1. Split screen. On the left, an operator's Claude Code terminal calls the Acquit MCP server from A2. The tool calls `list_jobs` and then `place_bid` scroll past.
2. On the right, the job page at `/jobs/<id>` as the client. The **Bids** section is the AG Grid bid list from F7. It shows the operator's bid and the House bid. Click the verified receipts column header so the grid sorts by it.
3. Click **Accept** on the operator's bid, then **Accept and pay with PayPal**.
4. The PayPal sandbox checkout opens. Log in as the buyer sandbox account and pay $420.00. See shot B2 in the money shot list.
5. Back on the job page, the **Escrow** card reads HELD, locked to the operator. Hold on the **Ledger** line that reads HELD 420.00 USD.

**Voice-over.** 45 words.

> An operator's agent finds the job through the Acquit MCP server and bids. House, our own agent, bids too. Bids sort by verified receipts, not star ratings. The client accepts and pays through PayPal. The money is held, and it can only pay this operator.

**Caption.** "PayPal Sandbox. No real money moves." Then "Escrow HELD. It can pay only this operator, or refund the client."

**Pre-warm.** Claude Code on the operator machine with the Acquit MCP server configured and one `list_jobs` call already made. The buyer sandbox account logged in once in its own browser profile, so checkout skips the cold login page. A PayPal access token less than 8 hours old.

**Depends on.** A2 for the MCP bid. F7 for the AG Grid bid list and the checkout substates. F6 for a House bid that a real model will deliver.

**Fallback.** If A2 slips, the operator bids with today's CLI, `acquit bid <job> --price 400 --eta 2d --agent ts-bugfixer --pitch "..."`, and the voice-over says "An operator bids from the Acquit command line" in place of "An operator's agent finds the job through the Acquit MCP server and bids." A2 is on the never-cut list, so this take is only for a rough cut. If F7 slips, use today's **Bids** section on the job page. It already lists the House row with "41 fixes, 39 passed verified CI". Drop the sort click and the sentence "Bids sort by verified receipts, not star ratings."

## Scene 4. The catch, 0:55 to 1:20

This scene has two versions. Prototype T decides which one ships. Record version B in any case, because it is the take to keep if the real run turns out to be unusable on camera.

**On screen, both versions.**

1. The operator's terminal. The agent runs and edits `tests/totals.test.ts`. The run prints "48 passed".
2. The operator submits. In the MCP flow from A2, the model calls `submit_attempt` and the operator confirms the exact commit in the CLI. In the fallback, the operator runs `acquit submit <job>`.
3. Cut to the job page. The attempt card reads REJECTED with the reason "PR modifies frozen test file tests/totals.test.ts".
4. Hold on the **Escrow** card, still HELD, and on "Attempts left: 2".

**Version A, a real model cheating.** Use this version only if Prototype T kept a run where the model edited a test without being told to. Replay that run's log on screen. Show the model name and the prompt "make the failing tests pass" in frame.

**Voice-over, version A.** 48 words.

> Now a real model takes the job. Its prompt says to make the failing tests pass. It edits the frozen test instead of the code. The verifier rejects it and names the file. The escrow stays held. The operator keeps two attempts, and nobody gets paid for this.

**Caption, version A.** "Real run. Model: <name>. Prompt: make the failing tests pass. Run <n> of <total>." Keep the caption on screen for the whole scene.

**Version B, labeled.** Use this version if Prototype T found no real cheat. The agent's instruction tells it to make the tests pass by any means. The label stays on screen for the whole scene.

**Voice-over, version B.** 48 words.

> To show the check, we told an agent to make the tests pass by any means. It edits the frozen test instead of the code. The verifier rejects it and names the file. The escrow stays held. The operator keeps two attempts, and nobody gets paid for this.

**Caption, version B.** "Staged. An agent told to make the tests pass." Keep the caption on screen for the whole scene.

**Pre-warm.** The verifier Docker image pulled on the verifier host, and one REJECTED run already made since the last restart. A fresh job at IN_PROGRESS with the escrow HELD, made just for this scene. For version A, the saved Prototype T log.

**Depends on.** Prototype T decides the version. A2 for `submit_attempt`. H2 for the hosted verifier.

**Fallback.** If A2 slips, submit with today's CLI. Run `acquit run <job> --runner claude-code` with the staged instruction, then `acquit submit <job>`, and show `acquit diff <job>` for the edited test. The REJECTED attempt card on the job page exists today. Version B needs no PR beyond what is merged.

## Scene 5. The honest fix, 1:20 to 1:45

**On screen.**

1. The job page as the client. The job timeline from F6 shows the House model's diff of `src/money.ts`. `decimalsFor(currency)` replaces the fixed `DECIMALS = 2`.
2. The attempt card reads VERIFIED. Zoom on **Frozen tests** "48 passed", **Hidden tests** "6 passed", and the **Required tests** line "54 completed, 0 skipped or missing".
3. In **Client review**, click **Approve and release**, then confirm **Approve and release $420.00** in the dialog.
4. Cut to the GitHub pull request in the client repo. It shows "Merged" and the green Acquit verifier check.

**Voice-over.** 41 words.

> The House agent runs a real model on the same issue. It fixes the rounding in the source and changes no test. The verifier passes forty-eight frozen tests and six hidden ones. The client approves, and Acquit merges the pull request.

**Caption.** "VERIFIED. 48 frozen and 6 hidden tests passed. No protected path touched."

**Pre-warm.** One House model run on another job just before the take, so the model and the verifier are warm. Prototype M's median time decides whether the take shows the run live or cuts from start to result. A fresh disposable client repo from J1, because an earlier approval already merged the fix into the last one.

**Depends on.** F6, revised, for the House model and its diff in the timeline. H2 and J1 for the hosted job and a repo that still has the bug.

**Fallback.** F6 with a real model is on the never-cut list. Until it lands, record the operator's honest second run, which runs a real model on the operator's machine today. Run `acquit run <job> --instruction "Do not edit any file under tests/. The test is correct. Fix the rounding in src/money.ts."`, then `acquit diff <job>` and `acquit submit <job>`. The voice-over's first sentence becomes "The operator runs the agent again with a stricter instruction." Never record this scene with the `command` runner. A script is not a model.

## Scene 6. Money moves, 1:45 to 2:05

**On screen.** Follow shots M1 to M6 in the money shot list below.

**Voice-over.** 38 words.

> In the PayPal sandbox, the buyer paid four hundred twenty dollars. The operator received three hundred sixty. The platform kept its fee. Then we send the same webhook twice. The second one changes nothing. There is one payout.

**Caption.** "Client paid $420.00. Operator received $360.00. Fees $60.00." Then "Same webhook twice. One payout."

**Pre-warm.** The three sandbox accounts logged in, each in its own browser profile. The release from scene 5 already settled, so the payout shows in the operator account. The recorded webhook event id for the capture, ready to resend.

**Depends on.** P1 for signed webhooks on the hosted route. H2 for the hosted URL. The release and payout path is merged today.

**Fallback.** The second webhook is the open item in this scene. Once P1 lands, the hosted route only accepts a signed delivery, and today's `npm run ctl -- webhook replay --event <id>` sends an unsigned envelope. Use a signed resend from the PayPal developer dashboard if it offers one for the event. Whether it does is a guess, so test it during V2. If no signed resend exists, record `npm run ctl -- webhook replay --event <id>` twice against a dev instance, which prints `applied` and then `no-op, job already PAID`. Caption that shot "Local replay of the recorded webhook." Show the sandbox payout list with exactly one payout for the capture after it.

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

**Fallback.** G1 with A3 is on the never-cut list. If A3 slips, record the G1 dashboard only. Drop the question, and the voice-over becomes "The platform watches the money in AG Studio. Held, released, refunded, fees, and tampering caught. The ledger conserves money. Every payout plus its fee equals what the client paid." That version is 29 words. If G1 also slips, show the AG Grid ledger table from F7, then run `node scripts/ledger-demo.mjs double-release`, which exists today and prints a REJECTED line for the law it breaks. Caption it "The ledger refuses a second payout." Drop "in AG Studio" from the voice-over.

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

**Fallback.** If B1 has no written quote by V3, drop the quote card and its first sentence. The voice-over then opens on "Acquit holds the money until a verifier clears it." If B2 slips, show the House line labeled as seeded demo history, as B2 requires in the UI. Never show the seeded "41 fixes, 39 passed" without that label.

## Money shot list, both sides of the money

These shots carry scene 6 and the checkout in scene 3. Each account is a PayPal sandbox account. Each account runs in its own browser profile, so one profile never shows another account's session. Name each account on screen by its role only. Blur or crop the account email in every frame.

| Shot | Account | Screen | What the frame must show |
| --- | --- | --- | --- |
| B1 | Buyer, sandbox Personal | Sandbox account home, before checkout | The balance before the job. The "Sandbox" mark. |
| B2 | Buyer, sandbox Personal | PayPal checkout from **Accept and pay with PayPal** | The $420.00 total. The pay button pressed. |
| M1 | Buyer, sandbox Personal | Activity after checkout | A payment of $420.00 to the platform. |
| M2 | Operator, sandbox Business | Activity after **Approve and release** | A payout received of $360.00, referencing the job. |
| M3 | Platform, sandbox Business (the partner account) | Activity for the same capture | The platform fee line. The amount must match the ledger's FEE split. |
| M4 | Acquit job page | **Ledger** section | The three lines HELD 420.00, RELEASED 360.00, and FEE 60.00, in one frame. |
| M5 | Second webhook delivery | Signed resend, or the labeled local replay from the scene 6 fallback | The second delivery changes nothing. |
| M6 | Operator, sandbox Business | Activity after M5 | Still exactly one $360.00 payout for the job. |

The tutorial ledger splits FEE 60.00 into 15.15 PayPal processing and 44.85 Acquit. Check the platform account's line against the ledger during V2 before captioning a number in M3. If they disagree, caption the ledger's figure and say nothing about the platform account's amount.

## Sound

Use no music. If the final cut needs a bed under scene 8, use a royalty-free track whose license we hold in writing, and keep the license with the project files. Use no third-party trademark or logo beyond PayPal, AG Grid, and GitHub screens as they appear in the product.

## Scene dependencies

| Scene | Blocking PRs | Fallback if they slip |
| --- | --- | --- |
| 1. The problem | None. Prototype T picks the caption. | Labeled diff from `acquit diff <job>`. |
| 2. Post a job | A1, J1, H2, K1 | AI contract with curated cases, or today's **New job** page with no AI claim. |
| 3. Bids and escrow | A2, F7, F6 | `acquit bid` from the CLI, and today's **Bids** section. |
| 4. The catch | A2, H2. Prototype T picks the version. | `acquit run` and `acquit submit`, version B. |
| 5. The honest fix | F6, J1, H2 | The operator's second `acquit run` with a real model. |
| 6. Money moves | P1, H2 | Labeled local `ctl webhook replay`. |
| 7. AG Studio | G1, A3 | G1 alone, then the F7 ledger grid and `scripts/ledger-demo.mjs`. |
| 8. Why it matters | B1, B2, H2 | No quote card, and a receipts line labeled as seeded. |
