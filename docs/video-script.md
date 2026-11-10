# The Trial: Acquit video script (2:50)

This is the final script for the Acquit submission video, "The Trial". The frame is a courtroom: the agent is the defendant, the hidden tests are the jury, and PayPal holds the bail. The picture is real screen footage from the hosted demo, the operator's terminal, and the judge tour, except six one-second chapter cards and one two-second freeze frame. Narration is an AI voice: the Agent speaks in the first person, and the Verifier answers in a dry, factual voice.

The script runs 2:50. Read at 150 words per minute, the spoken lines take about 116 seconds (289 words), so every beat has room for the picture. The runbook for recording, the voices, and the upload is in `docs/video-runbook.md`. The YouTube description template is in `docs/video-description.md`.

## Rules that hold for every take

- Record against the hosted demo, `https://80-225-220-230.sslip.io`, never localhost. The one exception is a labelled local take, and it is for a rough cut only.
- Anything scripted or staged carries its label in frame for the whole shot: `Scripted agent (Simulated)` for a `/tour` scenario, `Simulated sample data` for the sample book, `Simulated` for the sample book's figures. Never show a scripted catch as the real model's story.
- Every PayPal screen shows `Sandbox` in frame. The first PayPal screen also gets the caption `PayPal Sandbox. No real money moves.`
- Never show an account email, a merchant id, a password, an API key, a session token, or a saved account link. Crop them. See the runbook's crop list.
- Never caption or say a payout or fee figure that the take did not produce. Read every amount from that take's own ledger and receipt.
- Never say or caption "tamper-proof". The claim is that the verifier rejects tampering it can detect, and that hidden tests the operator cannot see decide payment.
- Captions are burned in, and an SRT file with the same captions is uploaded to YouTube. Each caption stays on screen for at least 2 seconds.
- The story job is one job for every real shot. Each real shot is recorded twice as a full chain on a new story job, because a state-changing step cannot be re-recorded on the same job.

## The timeline

Times are the cut's times. The chapter cards are one second each. `VO` is the spoken line, word for word, with the speaker. Words are counted from the `Voice line` column only, not from the speaker label. Numbers in the spoken lines are written in words, so the text-to-speech reads them correctly.

| Time | Chapter card | On screen | Route or command | Voice | Voice line | Captions and labels | PayPal ids to caption |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0:00 to 0:05 | none (no title card first) | The live story job page, tight on the attempt card: "Passed all 48 visible tests. Failed 8 of 8 hidden tests. Escrow still held." Hold on the 420.00 USD hold. | `/jobs/<story job>`, real | Agent | I passed every test I could see. I did not get paid. | "Passed all 48 visible tests. Failed 8 of 8 hidden tests." Then "420.00 USD held in escrow. PayPal Sandbox." | none on this frame |
| 0:05 to 0:15 | none | Pull back to the job's timeline. The caption sits over the timeline. | `/jobs/<story job>`, real | Verifier | Acquit is for teams that hire AI agents to write code. Hidden tests decide payment. PayPal holds the money until they pass. | "Acquit. Cleared, then paid." | none |
| 0:15 to 0:16 | Charge | Chapter card, one second. | openvids card | none | none | none | none |
| 0:16 to 0:35 | Charge | `/jobs/new`: select `#12 Totals round wrong for 3-decimal currencies`. Budget 400. Deadline 7 days. Open job. On the job page, hold on the Acceptance contract panel with its drafted cases and citations. Keep the cases. Click Approve the kept cases. Status shows Approved and frozen. | `/jobs/new` (client), then the job page | Verifier | The client opens the job on issue twelve. AI drafts the acceptance contract and the hidden cases from the issue text. The client approves the cases it keeps, and the suite freezes. The hidden cases are not in the code the operator receives. | "AI drafts the contract and hidden tests. The client approves them." Then "48 visible and 8 hidden tests. Hidden cases sealed." (the take's counts) | none |
| 0:35 to 0:36 | Bail | Chapter card, one second. | openvids card | none | none | none | none |
| 0:36 to 0:55 | Bail | Split screen. Left: the operator's Claude Code terminal calls the Acquit MCP tools `list_jobs` and `place_bid` (400, 48 hours, agent ts-bugfixer, one sentence of pitch). Right: the job page's bid list. The client clicks Accept on the operator's bid, then Accept and pay with PayPal. The sandbox checkout opens (buyer's account cropped). Back on the job page: Escrow HELD, locked to the operator, and the ledger line HELD. | Claude Code with the `acquit` MCP server; `/jobs/<story job>` | Agent | I found the job through the Acquit server and placed a bid. The client accepted and paid four hundred twenty dollars into PayPal escrow. It can pay only me, or refund the client. | "PayPal Sandbox. No real money moves." on the checkout. Then "Escrow HELD. It can pay only this operator, or refund the client." | PayPal capture: caption its id on the first frame where the job page shows it |
| 0:55 to 0:56 | Evidence | Chapter card, one second. | openvids card | none | none | none | none |
| 0:56 to 1:02 | Evidence | Scripted catch, from the judge tour's Test tamper scenario. The scenario card shows the step "Scripted agent edits the frozen test". The end state reads "Rejected for changing a protected test file. The escrow stays held." | `/tour`, scenario Test tamper | Verifier | A scripted agent, labelled Simulated, edited the frozen test. The verifier refused it. | "Scripted agent (Simulated)" on screen for the whole shot. Then "Rejected for changing a protected test file. The escrow stays held." | none |
| 1:02 to 1:09 | Evidence | The real run on the story job, attempt 1. Terminal: `acquit run` with the default instruction, then `acquit submit`. Cut to the job page: the attempt card reads "Attempt 1 of 3 rejected." with the counts and "Escrow still held." | `acquit run <job> --dir story-job`, `acquit submit <job> --dir story-job`, then `/jobs/<story job>`, real | Agent, then Verifier | I passed the visible tests and submitted. / The hidden tests fail. | "Real run. Agent ts-bugfixer, claude-code." Then "Attempt 1 of 3 rejected. Escrow still held." (the take's words) | none |
| 1:09 to 1:11 | none | Freeze on the attempt card. Overlay text: "Pause. Would you pay this agent?" No narration for these two seconds. | Freeze frame of 1:02 to 1:09 | none | (silence) | "Pause. Would you pay this agent?" as the overlay | none |
| 1:11 to 1:12 | Verdict | Chapter card, one second. | openvids card | none | none | none | none |
| 1:12 to 1:20 | Verdict | The job page: status Rejected (escrow still held). Hold on the attempt card and the timeline's rejected event. | `/jobs/<story job>`, real | Verifier | The escrow stays held. The operator has two attempts left. | "Rejected (escrow still held)." | none |
| 1:20 to 1:21 | Retrial | Chapter card, one second. | openvids card | none | none | none | none |
| 1:21 to 1:31 | Retrial | Terminal: `acquit run` with the stricter instruction, then `acquit diff`. The diff changes only `src/money.ts`: `decimalsFor(currency)` replaces the fixed two decimals. | `acquit run <job> --dir story-job --instruction "..."`, `acquit diff <job> --dir story-job` | Agent | I ran again with a stricter instruction. I fixed the rounding in the source and left the tests alone. | Show the instruction in frame: "Do not edit any file under tests/." | none |
| 1:31 to 1:40 | Retrial | Terminal: `acquit submit`. Cut to the job page as the client: the attempt reads "Attempt 2 of 3 verified", with the counts. Client review: Approve and release. The dialog reads "Approve and release 420.00 USD?". Click Approve and release. | `acquit submit <job> --dir story-job`, then `/jobs/<story job>` | Verifier | Verified. All forty-eight visible tests and all eight hidden tests passed. The client approves, and the escrow releases. | "Attempt 2 of 3 verified. 48 of 48 visible and 8 of 8 hidden tests passed." (the take's counts) | none |
| 1:40 to 1:41 | Acquitted | Chapter card, one second. | openvids card | none | none | none | none |
| 1:41 to 2:00 | Acquitted | The job page's ledger in one frame: HELD, RELEASED, and FEE lines. Then the public receipt, `/receipts/<receipt id>`, with the PayPal ids section and the Sandbox mark. | `/jobs/<story job>` (Ledger), then `/receipts/<receipt id>` | Verifier | Paid in: four hundred twenty dollars. Released to the operator: three hundred sixty dollars. Fee: sixty dollars. Payout plus fee equals paid. Every id on screen is listed on the public receipt. | "Client paid 420.00 USD. Operator received 360.00 USD. Fee 60.00 USD." (replace with the take's figures) Then "Payout plus fee equals paid." | PayPal capture, PayPal payout item, and the fee batch id if the receipt shows one. If the receipt reads "None" for the fee, caption "No separate fee payout: PayPal took its processing fee out of the capture." |
| 2:00 to 2:08 | none | The live platform Studio at `/studio`, signed in as platform staff. The Ledger conserves widget is green. Then the Ask the ledger panel: type "How much escrow is held right now, and does PayPal agree?" | `/studio` (platform staff) | Verifier | In AG Studio, Ask the ledger reads the live book and checks PayPal. | "Live platform book." Then "Ledger conserves: payout plus fee equals paid." | PayPal order id only if the answer shows it on screen |
| 2:08 to 2:18 | none | The answer delegates a widget. The widget appears on the dashboard, and the Ledger conserves widget stays green. | `/studio`, Ask the ledger | Verifier | It builds a widget from the answer. The ledger still conserves money. | "Ledger conserves" stays visible. | none |
| 2:18 to 2:30 | none | The sample book at `/studio/sample`. Click Explain on a figure: the lines open. Show the verdict grid. Make a change and click Undo to here on the Changes panel. | `/studio/sample` | Verifier | Explain opens the lines behind any figure. The verdict grid shows each checked attempt. Undo reverts a change. This is the sample book, labelled Simulated. | "Simulated sample data: a seeded set of escrow jobs." Keep on screen for the whole shot. | none. Sample ids are labelled sample and are not captioned as real. |
| 2:30 to 2:42 | none | The public `/verifiers` page, cropped to the code card: "Caught 11 of 11 known cheats. Passed 20 of 20 honest submissions. No known gaps." | `/verifiers` (public, no sign-in) | Verifier | Eleven of eleven known cheats caught. Twenty of twenty honest submissions passed. The honest limit: the verifier rejects the tampering it can detect. | The card's own sentences, unchanged. Then "The honest limit: the verifier rejects the tampering it can detect." | none |
| 2:42 to 2:50 | none | The hosted landing page, then the closing card: "Pause on any id and open it." | `https://80-225-220-230.sslip.io/` | Agent | Cleared. Then paid. | "https://80-225-220-230.sslip.io" then "Pause on any id and open it." (on screen at least 3 seconds) | none |

## Word budget

The budget is 2.5 spoken words per second, which is 150 words per minute. Each beat's line count must stay under its budget. The count below covers the Voice line column. Speaker labels are not counted.

| Beat | Window | Seconds | Words | Budget at 150 wpm | Words per second |
| --- | --- | --- | --- | --- | --- |
| Hook | 0:00 to 0:05 | 5 | 12 | 12.5 | 2.4 |
| Thesis | 0:05 to 0:15 | 10 | 22 | 25 | 2.2 |
| Charge | 0:16 to 0:35 | 19 | 43 | 47.5 | 2.3 |
| Bail | 0:36 to 0:55 | 19 | 33 | 47.5 | 1.7 |
| Evidence, scripted | 0:56 to 1:02 | 6 | 13 | 15 | 2.2 |
| Evidence, real run | 1:02 to 1:09 | 7 | 11 | 17.5 | 1.6 |
| Verdict hold | 1:12 to 1:20 | 8 | 10 | 20 | 1.3 |
| Retrial, terminal | 1:21 to 1:31 | 10 | 19 | 25 | 1.9 |
| Retrial, verified | 1:31 to 1:40 | 9 | 18 | 22.5 | 2.0 |
| Acquitted | 1:41 to 2:00 | 19 | 32 | 47.5 | 1.7 |
| Studio, live | 2:00 to 2:08 | 8 | 13 | 20 | 1.6 |
| Studio, widget | 2:08 to 2:18 | 10 | 12 | 25 | 1.2 |
| Studio, sample | 2:18 to 2:30 | 12 | 25 | 30 | 2.1 |
| Score card | 2:30 to 2:42 | 12 | 23 | 30 | 1.9 |
| Close | 2:42 to 2:50 | 8 | 3 | 20 | 0.4 |
| Total | 0:00 to 2:50 | 170 | 289 | 425 | 1.7 |

The Acquitted count uses the tutorial's quote (360.00 released, 60.00 fee), written in words. When the take's amounts differ, the spoken numbers change. Recount the beat from the table after the take, and keep it under its 47-word budget. The count above came from a script that counts the Voice line column of this table, skipping the speaker labels, the separators, and "none".

## Pause and close

The beat "Pause. Would you pay this agent?" runs for two seconds on a freeze frame, with no narration, before the Verdict card. It is an overlay on the attempt card. It is not product text.

The closing caption "Pause on any id and open it." stays on screen for at least three seconds, after the URL. The YouTube description lists the same ids with their timestamps, and the pinned comment repeats the list.

## Fallback: the real model passes the hidden tests

The real model may pass every hidden test on its first attempt, or fail in a different way from the script. Then the catch cannot come from the real run. Use the judge tour, label it, and change the lines below. Do not change the other beats.

- Hook, 0:00 to 0:05, becomes the `/tour` Hidden test fail job page, labelled `Scripted agent (Simulated)`. Voice line: A scripted agent passed every visible test. It did not get paid. (12 words.) Caption: the scenario's own end state, "Rejected on hidden tests. The escrow stays held." The count shown is the take's.
- Evidence, 1:02 to 1:09, becomes the `/tour` Hidden test fail scenario, labelled `Scripted agent (Simulated)` for the whole shot. Voice line: A scripted agent, labelled Simulated, hard-coded the visible answers. The hidden tests caught it. (14 words.) The scripted shortcut is "hard-coded visible values" in the scenario, so the line must not say it edited the test. Use Test tamper for an edited test.
- Retrial, 1:21 to 1:40, is unchanged. It must be a real run that passes, so keep the real attempt for the verified card.

## Claims this script makes, and where the product shows them

| Claim in the video | Where the product shows it |
| --- | --- |
| Escrow holds until the work is verified | Job status "Rejected (escrow still held)" (`apps/web/src/job-status.ts`) and the timeline's "Escrow still held." |
| Hidden tests decide payment | Attempt detail "Passed all 48 visible tests. Failed 8 of 8 hidden tests." (`apps/web/src/receipt-view.ts`, `apps/web/src/job-timeline.ts`) |
| Payout plus fee equals paid | Studio widget "Ledger conserves" and the line "payout + fee = paid" (`apps/web/src/studio/dashboards.tsx`) |
| 11 of 11 known cheats caught, 20 of 20 honest passed | `/verifiers`, the code card (`packages/core/src/score-card-data.ts`, `apps/web/src/verifiers-view.ts`) |
| Scripted runs are labelled and their verifier run was real | Receipt note "Scripted agent (Simulated) did this work in a scenario. The verifier run that checked it was real." (`apps/web/src/receipt-view.ts`) |
| AI drafts the contract and hidden tests; the client approves them; the suite freezes | Acceptance contract panel and "Approve the kept cases" on the job page (`apps/web/src/pages/JobPage.tsx:431-575`, `:568`), timeline "Acceptance contract frozen" (`apps/web/src/job-timeline.ts:71-72`) |
| The hidden cases are not in the code the operator receives | Timeline "Hidden cases sealed" (`apps/web/src/job-timeline.ts:72`), and the public receipt's note that the fixture's hidden tests "are never published" (`apps/web/src/pages/PublicReceipt.tsx:119-122`) |
| The verifier rejects the tampering it can detect (the honest limit) | Authored caveat, not on-screen text. The code card at `/verifiers` reads "No known gaps." The print verifier's card lists its known gap, `replay-same-file` (`packages/verifier-print/src/score-card.ts:16`). Confirm the wording against that gap before upload. |
