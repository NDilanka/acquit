# Recording runbook: "The Trial" (Acquit, 2:50)

This runbook is for the person who records and uploads the video. Read `docs/video-script.md` first. Its timeline is the cut. This file says how to make the one real story job, which shots to record and in what order, what to crop, how to collect the PayPal ids, how to make the two voices, what to ask openvids for, and the edit and upload checklist.

The hosted demo is `https://80-225-220-230.sslip.io`. Every command below passes `--api https://80-225-220-230.sslip.io`. Without it the CLI calls `http://127.0.0.1:4310` unless a stored login names another API. The order is set in `packages/acquit-cli/src/submit.ts:36`: `ACQUIT_API`, then the stored login, then localhost.

Budget: about 4 hours in total. The breakdown is at the end.

## 1. Gates to check before you record

Each gate is something this runbook could not confirm from the code alone, or something that depends on the hosted server's state. Check them on the hosted site first. If a gate fails, use the fallback in the script or cut the line it affects, then recount the words.

| Gate | What to check | If it fails |
| --- | --- | --- |
| G1 Hidden count | The hosted registry for issue 12 must say 8 hidden tests. The tutorial and the example registry say 8 (`packages/verifier/fixtures/fixtures.example.json:10`). Some test fixtures use 6. The hosted registry is not in the repository. | Change every "8 of 8" and "all 8 hidden" in the script to the hosted count. Recount. |
| G2 Hook and first attempt | The hook reads "Failed 8 of 8 hidden tests", which needs zero hidden tests passed on the real attempt (`apps/web/src/receipt-view.ts:56-64`). A real model may fail some hidden tests and pass others, or be rejected for a different reason. | Caption the take's own sentence. If the first attempt is VERIFIED, or rejected for a reason other than the tests, use the fallback in the script. |
| G3 Ask the ledger | Ask the ledger lives on the staff-only live platform Studio at `/studio` (`apps/web/src/studio/StudioPage.tsx:111-112`). It is off without a configured server model key (`StudioPage.tsx:389-390`). The Sample book at `/studio/sample` also has Ask, reading only seeded sample data, at viewport widths of at least 1200 CSS pixels (`StudioPage.tsx:69,294-327`). Record Sample Ask at that width or wider. | If Ask fails on both books, cut the Ask lines at 2:00 to 2:18. Use: "In AG Studio, the live book conserves money: payout plus fee equals paid." Recount. |
| G4 AI draft | The AI draft shows on the job page after Open job, in the Acceptance contract panel (`apps/web/src/pages/JobPage.tsx:431-575`). It is not on `/jobs/new`. Check whether operators can bid before or after the client approves the cases. | If the draft fails on the hosted server, the panel shows a failure line. Cut the AI lines at 0:16 to 0:35 and use the tutorial's plain flow. |
| G5 Hidden-case commitment | The receipt says "Committed <date>, before the work started." only when the job has committed hidden cases. Otherwise it says the fixture's hidden tests "are shared by every account, so they are never published" (`apps/web/src/pages/PublicReceipt.tsx:119-122`). | Make no commitment claim unless the receipt on screen shows one. The script does not make one. |
| G6 Platform role | The live Studio and the Sample book in the nav need the PLATFORM role (`apps/web/src/nav.ts:26`, `apps/web/src/account.ts:107`). The platform role is entered through "Platform staff sign in" on `/start` (`apps/web/src/account.ts:18`, `apps/web/src/pages/SignIn.tsx:104-112`). The key belongs to the deployment owner. | Do not type the key on camera. Record the Studio shots only after the owner signs you in. |
| G7 Daily caps | The deployment limits scenario runs per day (`CAP_SCENARIOS_DAY`, `apps/web/src/errors.ts:21`), verifier runs per day (`CAP_MODEL_RUNS_DAY`, `errors.ts:20`), and job budget per account (`CAP_SPEND_DAY`). The numbers were not checked here. | Plan three `/tour` runs and four real verifier runs (two chains, two attempts each). Ask the owner for the current limits before a second chain. |
| G8 Two visitors | Try Acquit gives one visitor both a client side and an operator side (`README.md:17`). Whether a visitor can bid on its own job was not checked here. | Use two visitors: one for the client (browser) and one for the operator (`acquit login` and MCP). |
| G9 Operator onboarding | `acquit operator init` runs PayPal sandbox onboarding and stores the Anthropic key in the OS keychain (`packages/acquit-cli/src/operator.ts`). Not run against the hosted API here. | Run it once before the recording day and note any change in the terminal wording. |
| G10 Tutorial commands | In `docs/tutorial.md`, `acquit run job_7Q2K` has no `--dir`. Without it the checkout goes to `<cwd>/invoice-app` (`packages/acquit-cli/src/run.ts:734`), but `acquit diff` and `acquit submit` read `.` (`diff.ts:24`, `submit.ts:34`). The runbook always passes `--dir`. | Not in this unit. Record as a follow-up to fix the tutorial. |

## 2. Accounts and sign-in

| Surface | Sign-in needed | Source |
| --- | --- | --- |
| `/`, `/start` | No | `apps/web/src/route.ts:45-71` |
| `/verifiers`, `/print`, `/receipts/<id>` | No (public, with or without a session) | `apps/web/src/App.tsx:72` |
| `/jobs/new`, `/jobs/<id>`, `/operator`, `/studio/sample`, `/studio` | Yes | `apps/web/src/route.ts:45-71` |
| `/tour` | Yes (a signed-out visit goes to `/start`) | `route.ts:45-53` |

Recommended accounts:

- Client visitor: created by Try Acquit at `/start`. Use its client side for posting, approving, accepting, paying, and approving the release.
- Operator visitor: a second Try Acquit visitor (G8). Use it for `acquit login`, `acquit operator init`, the bid, the runs, and the submits. Its browser is used only for the operator's own pages.
- Sandbox buyer: a PayPal sandbox Personal account, signed in once in its own browser profile, so the checkout does not show a cold login page.
- Sandbox operator payout account: a PayPal sandbox Business account, used by `acquit operator init` (tutorial, "Connect payouts").
- Platform staff: the owner signs you in (G6).

Use one browser profile for each account, so one account's session never appears in another's frame.

## 3. Pre-warm

Do this on the recording day, before the first take.

Browser and display

- Chrome or Edge, one profile for each account above. Extensions off. Bookmarks bar hidden (Ctrl+Shift+B).
- Windows display at 1920 by 1080, scale 100 percent. The browser window maximized.
- Zoom 125 percent: press Ctrl+= twice from 100 percent (110, then 125).
- Theme: Light. Light is the site's default (`apps/web/src/styles.css:1`, `apps/web/src/theme.ts:1`). Do not toggle it during recording.
- Windows Focus Assist on (alarms only). Close chat and mail apps.

OBS

- Canvas and output 1920 by 1080. 30 fps.
- Source: Display Capture, cropped to the 1920 by 1080 area. Cursor shown.
- Encoder x264 at a CRF of 18 (or NVENC at about 16 Mbps). Container MKV.
- One file per shot. Name files with the shot ID from the table in section 6, for example `S-C4-take1.mkv`.
- Desktop audio off, and no microphone. The narration is added in the edit.
- Save takes outside the repository, for example `D:\video\takes`.

Terminal

- Windows Terminal running PowerShell 7. A plain dark theme. Font 18 points. Window 120 columns by 30 rows.
- In each terminal session you record, run `function prompt { '$ ' }`. This changes only that session.
- Crop the Windows user name out of any path.

Operator machine

- Docker running. Build the runner image once before the first run: `docker build -t acquit/runner-node20 packages/runner` (`README.md:56`). The CLI starts its containers with `--pull=never` (`packages/acquit-cli/src/run.ts:543`), so a missing image stops the run instead of downloading one.
- The CLI is not published: `packages/acquit-cli/package.json` marks `@acquit/cli` as `"private": true`, so `npm i -g` will not work. Run it from the repository, as `README.md:95` describes. In each terminal you record, define the command once before the take: `function acquit { node <repo>\packages\acquit-cli\src\main.ts @args }`, with `<repo>` the absolute path to the checkout. Keep the path out of frame.
- Sign in: `acquit login --api https://80-225-220-230.sslip.io`. The browser opens. Crop the URL bar.
- Set up payouts and the key: `acquit operator init --provider anthropic --api https://80-225-220-230.sslip.io`. Enter the Anthropic key only at the prompt, with the screen off camera. The key goes to the OS keychain and is never printed (`packages/acquit-cli/src/operator.ts`).
- Create the agent: `acquit agent create ts-bugfixer --runner claude-code --prompt prompts/ts-bugfixer.md --allow-tools Read,Edit,Bash --api https://80-225-220-230.sslip.io`. Write `prompts/ts-bugfixer.md` first, using the text in `docs/tutorial.md`.

MCP server (for the bid)

- Register the server in Claude Code with the command `node` and the absolute path of `packages/mcp/src/main.ts` as its argument (`README.md:95`). Set the environment variable `ACQUIT_API` to `https://80-225-220-230.sslip.io`. The MCP server defaults to `127.0.0.1:4310` otherwise (`packages/mcp/src/main.ts:21`).
- The server takes the operator's token from `ACQUIT_TOKEN`, or from the stored `acquit login` (`packages/mcp/src/main.ts:22-26`). Do not write a token into the MCP configuration.
- Check Claude Code's MCP settings for the exact registration syntax in your version.

## 4. The one real story job

The story job is one job, posted and worked on in order. Every real shot in the video comes from this chain. A state-changing step cannot be repeated on the same job, so the second take of the chain uses a new job and a new empty folder (`story-job-2`).

Rules for the folder: `acquit run --dir <path>` clones into `<path>`. The path must be empty or already hold this job's checkout (`packages/acquit-cli/src/run.ts:310-353`). Use a new empty folder for each job.

Step 1. Post the job (client visitor, browser)

1. `/jobs/new`. In Issue, select `#12 Totals round wrong for 3-decimal currencies`. Budget 400. Deadline 7 days. Click Open job.
2. The job page opens. The Acceptance contract panel shows the drafted cases with their citations (`JobPage.tsx:431-575`). Keep the cases you want. Click Approve the kept cases. The status reads Approved and frozen.
3. Check the job id from the URL or from `acquit jobs list`.

Expected: the job timeline shows "Acceptance contract frozen" (`apps/web/src/job-timeline.ts:71`) and "48 visible and 8 hidden tests. Hidden cases sealed." (`job-timeline.ts:72`). Captions use the take's counts.

Step 2. Bid (operator visitor)

Through MCP, in Claude Code: call `list_jobs`, then `place_bid` with the job id, `priceUsd` 400, `etaHours` 48, `agent` ts-bugfixer, and a one-sentence pitch (`packages/mcp/src/server.ts:94-103`).

Or through the CLI:

```
acquit jobs list --api https://80-225-220-230.sslip.io
acquit bid <job> --price 400 --eta 2d --agent ts-bugfixer --pitch "TypeScript currency fix with a dedicated bug-fix agent. Source changes only." --api https://80-225-220-230.sslip.io
```

`--eta` takes hours or days, from 1 to 336 hours (`packages/acquit-cli/src/bid.ts:48`).

Step 3. Accept and pay (client visitor, browser)

1. On the job page, click Accept on the operator's bid (`apps/web/src/pages/JobPage.tsx:646`).
2. Click Accept and pay with PayPal (`JobPage.tsx:367`). The sandbox checkout opens. Pay with the sandbox buyer. Crop the buyer's account and any payee name.
3. Back on the job page: Escrow HELD, locked to the operator. The ledger shows the HELD line.

Caption the first PayPal screen with `PayPal Sandbox. No real money moves.` Caption the PayPal capture id on the first frame where the job page shows it (section 8).

Step 4. Attempt 1: the real run (operator terminal)

```
acquit run <job> --dir story-job --api https://80-225-220-230.sslip.io
acquit submit <job> --dir story-job --api https://80-225-220-230.sslip.io
```

- Use the default instruction. Do not pass `--instruction`. Without it the runner gets `defaultInstruction` (`packages/acquit-cli/src/run.ts:757`, `run.ts:682-684`): "Fix the issue ... change files under src/ only, and run the tests before you finish."
- The runner comes from the accepted agent, claude-code (`run.ts:714`).
- `acquit submit` sends the attempt straight through. It has no confirm step. The confirm step is only in the MCP path (`packages/acquit-cli/src/confirm.ts`).
- Record the terminal lines the take prints. Use the tutorial's output only as a guide.

Step 5. The rejected card (client visitor, browser)

Open the job page. The attempt card reads "Attempt 1 of 3 rejected." with the counts and "Escrow still held." (`apps/web/src/job-timeline.ts:550-551`). The status reads "Rejected (escrow still held)" (`apps/web/src/job-status.ts:52`).

Record this shot wide (for the 1:12 hold) and as a tight crop of the attempt card (for the 0:00 hook). The hook and the pull-back at 0:05 come from this same take.

Step 6. Attempt 2: the honest fix (operator terminal)

```
acquit run <job> --dir story-job --instruction "Do not edit any file under tests/. The test is correct. Fix the rounding in src/money.ts." --api https://80-225-220-230.sslip.io
acquit diff <job> --dir story-job --api https://80-225-220-230.sslip.io
acquit submit <job> --dir story-job --api https://80-225-220-230.sslip.io
```

- The second run resets the checkout to the frozen commit, because the job already has an attempt (`run.ts:737`).
- The diff should change only `src/money.ts`. Show it in frame.

Step 7. Approve and release (client visitor, browser)

1. The job page: the attempt card reads "Attempt 2 of 3 verified" with the counts (`job-timeline.ts:531-532`).
2. In Client review (`JobPage.tsx:254`), click Approve and release (`JobPage.tsx:318`). The dialog reads "Approve and release <amount> USD?" (`JobPage.tsx:377`). Click Approve and release (`JobPage.tsx:412`).

Step 8. Ledger and receipt (both visitors)

1. The job page's Ledger (`apps/web/src/pages/job/MoneyCard.tsx:30`). Show the HELD, RELEASED, and FEE lines in one frame.
2. The receipt. The job page shows the receipt id after PAID. `acquit receipts --api https://80-225-220-230.sslip.io` also lists it (the CLI prints a line with "Frozen tests 48/48, hidden tests 8/8", `packages/acquit-cli/src/receipts.ts:52`).
3. Open `/receipts/<receipt id>`. Show the PayPal ids section (Capture, Payout, Fee) and the Sandbox mark (`apps/web/src/pages/PublicReceipt.tsx:155-168`, `apps/web/src/receipt-view.ts:103-115`).

Step 9. Studio (platform staff, after the chain)

After the chain, sign in as platform staff (G6). Record the Studio shots in section 6 (R7). The live Studio needs the chain's payout to show the story job.

## 5. Fallback: the real model passes the hidden tests

If the real attempt passes, or is rejected for a different reason (G2), the catch cannot come from the real run. Use the judge tour and label it.

1. Sign in as a signed-in account and open `/tour`. Pick "Hidden test fail" (`apps/web/src/judge-tour.ts:16-21`). Record the scenario labelled `Scripted agent (Simulated)` for the whole shot. The scenario's step text says "Scripted agent writes the shortcut" (`apps/web/src/scenario-run.ts:73`). Its end state reads "Rejected on hidden tests. The escrow stays held."
2. Use the lines in `docs/video-script.md`, section "Fallback". The Evidence line changes. It must not say the scripted agent edited a test: the Hidden test fail scenario hard-codes the visible values (`packages/core/src/scenarios.ts:525`). Use "Test tamper" for an edited test (`scenarios.ts:526`).
3. The hook changes as well, to the scripted job page, with its own labels.
4. The Retrial stays real. It must pass for real, so keep the chain's second attempt.

Record `/tour` "Hidden test fail" once as insurance even if it is not used, because each `/tour` run counts against the scenario cap (G7).

## 6. Shot list, in recording order

Recording order is not story order. Shots that change server state come after shots that do not. Every shot is recorded twice, except where a state change needs a new job. Then the second take is a second full chain.

| Order | Shot | Route or command | Account | Takes | State change | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | Verifier card | `/verifiers`, cropped to the code card | none needed | 2 | none | Public. Caption its sentences unchanged. |
| R2 | Sample book | `/studio/sample`: Explain, verdict grid, Undo to here | platform staff (G6) | 2 | none on the server; the change log is kept in the browser | Label "Simulated sample data" for the whole shot. |
| R3 | Test tamper (scripted) | `/tour`, Test tamper | signed-in account | 2 | creates a scripted job | Label "Scripted agent (Simulated)" for the whole shot. Counts against the scenario cap. |
| R4 | Hidden test fail (scripted) | `/tour`, Hidden test fail | signed-in account | 1 | creates a scripted job | Fallback insurance only. |
| R5 | Story chain, take 1 | Steps 1 to 8 in section 4 | client and operator | a full chain | yes | Shots C1 to C8 below. |
| R6 | Story chain, take 2 | Same steps on `story-job-2`, a new job | client and operator | a full chain | yes | Second take of every chain shot. |
| R7 | Live Studio with Ask the ledger | `/studio`: the Ledger conserves widget, then Ask: "How much escrow is held right now, and does PayPal agree?" | platform staff (G6) | 2 | yes, the widget is saved to the platform layout (`apps/web/src/api.ts:134`) | Needs the server's model key (G3). Remove the test widget afterwards. |

Chain shots (R5 and R6)

| Shot | Where | Frame |
| --- | --- | --- |
| C1 | Browser, client | `/jobs/new` to Open job, then Approve the kept cases |
| C2 | Claude Code terminal, operator | MCP `list_jobs` and `place_bid` |
| C3 | Browser, client, then sandbox checkout | Accept, Accept and pay with PayPal, the checkout, Escrow HELD |
| C4 | Operator terminal | `acquit run` (default instruction) and `acquit submit` |
| C5 | Browser, client | The rejected card, wide and tight. The hook comes from this shot. |
| C6 | Operator terminal | `acquit run` with the stricter instruction, `acquit diff`, `acquit submit` |
| C7 | Browser, client | Attempt 2 verified, Approve and release, the dialog |
| C8 | Browser, both | The ledger, then `/receipts/<receipt id>` |

## 7. What to crop

- Email addresses: the account menu, the sign-in fields, and the PayPal sandbox account headers.
- Merchant ids and payee names: the PayPal checkout and activity screens. Never show the operator's merchant id from `.env`.
- The saved account link. Try Acquit tells visitors to "Save your account link to come back from any browser" (`apps/web/src/account.ts:12`). The link carries a token in its address (`apps/web/src/pages/WelcomeBack.tsx`). Crop the address bar on any page whose URL has a `#` token.
- Tokens and keys: the `acquit login` browser page's URL, the `acquit operator init` key prompt (keep it off camera), the MCP token, any output that names a secret.
- `.env`: never open it on camera.
- The platform staff key: record the Studio after sign-in, not the sign-in modal.
- Windows notifications, other tabs, the Windows user name in a path.

## 8. How to collect the PayPal ids

The receipt is the source of truth. The job page's verdict grid shows the same capture and payout ids and is the cross-check.

1. After the chain is final, open the receipt for the story job at `/receipts/<receipt id>`.
2. Copy each id in the PayPal ids section. The three rows are Capture, Payout, and Fee (`apps/web/src/receipt-view.ts:104-115`). The Fee row reads "None" when PayPal took its processing fee out of the capture. It then reads "No separate fee payout: PayPal took its processing fee out of the capture."
3. Cross-check the Capture and Payout ids against the job page's verdict grid, which shows "PayPal capture" and "PayPal payout item" (`apps/web/src/verdict-grid.ts:131-137`).
4. Write them into a notes file outside the repository, for example `D:\video\ids.txt`. Do not commit that file. The description template has placeholders for the ids.
5. Open each receipt link logged out, in a private window. Confirm the ids are listed.
6. Caption only the ids that are on screen in the take. The order id appears only in an Ask the ledger answer (`apps/web/src/ask-ledger.ts:539-540`), so caption it only if the answer shows it.
7. Every id in the video must appear in the description with its timestamp, and every id in the description must appear in the video.

## 9. AI voice

Two options. Both are free and run on your own computer. Check each license before the first render, and save a copy of the license page with the project files.

Option A: Kokoro-82M. The model is published with an Apache-2.0 license on Hugging Face (`hexgrad/Kokoro-82M`). It runs on CPU. Pick two preset voices, one for the Agent and one for the Verifier. Confirm the license on the model card before use.

Option B: Piper TTS. The engine is MIT-licensed. Pick two voices whose model cards name a license that allows public, commercial use. Some voices carry non-commercial terms, so check each one.

Procedure

1. Make a text file for each voice. Each line is `ID<TAB>line`. The lines come from the Voice line column of the timeline in `docs/video-script.md`, with IDs such as `V01`. Use the words, not digits: "four hundred twenty dollars", not "420".
2. Generate one WAV per line. Do not generate per scene. Generating per line keeps edits from forcing a regeneration.
3. Check each clip's length against its beat window in the timeline. If a clip is too long, cut words from the script. Do not speed the voice up.
4. Leave the deliberate silence from 1:09 to 1:11 empty. No voice there.
5. Normalise every clip to the same loudness, about -16 LUFS.

## 10. What to ask openvids for

Ask the openvids skill for the chapter cards and the procedural sound only. The product footage is real. Captions and labels come from the SRT in the editor, not from openvids.

Request, to paste into openvids:

> Make six one-second title cards for the Acquit video "The Trial", in this order: Charge, Bail, Evidence, Verdict, Retrial, Acquitted. 1920 by 1080, 30 fps. Plain courtroom styling in a neutral palette, uppercase titles, no people, no logos, no PayPal marks, no generated footage, no stills. Add procedural sound only: one soft gavel knock on each card. No music and no licensed audio. Render each card as its own clip, and export the sound as a separate WAV of the same total length.

The "Pause. Would you pay this agent?" prompt is a text overlay on a freeze frame. Add it in the editor, not in openvids.

## 11. Edit and upload checklist

Edit

1. Import every take. Name each clip by its shot ID.
2. Cut the timeline to the table in `docs/video-script.md`. Check each row's length against its window.
3. Make the 1:09 freeze frame and the overlay for two seconds.
4. Build the SRT from the Captions column of the table. Each caption stays on screen for at least 2 seconds. Import it as a subtitle track and burn it in.
5. Check every frame with a label: `Scripted agent (Simulated)`, `Simulated sample data`, `PayPal Sandbox`. Check the PayPal ids against the table's PayPal column.
6. Render 1920 by 1080, 30 fps, one render at a time. Close other apps first.

Check

7. Duration is 2:50 or less, and no more than 3:00.
8. Watch muted, then on a phone. Check the numbers, the ids, the labels, and that no email is visible.
9. No third-party mark other than the PayPal sandbox screens, the GitHub screens, and the AG Grid screens as they appear in the product.

Upload

10. Upload to YouTube as Unlisted first. Add the SRT as the caption file.
11. Add chapters. The first must start at 0:00, and each must be at least 10 seconds long. The chapters are in `docs/video-description.md`.
12. Fill the description template in `docs/video-description.md`: the ids with their timestamps, the receipt link, and "AI voice".
13. Check the video logged out, in a private window: it plays, the description's links open, each receipt opens and lists its ids.
14. Set the video to Public. Check it logged out again.
15. Thumbnail: a real frame of the rejected card or the receipt. No generated logos.

Upload early. YouTube processing can take hours. Target: unlisted by 2026-11-10 13:00 local time. Public before the submission deadline of 2026-11-12.

## 12. Times

| Step | Time |
| --- | --- |
| Check the gates and lock the script | 0:20 |
| Make the two voices and check the clip lengths | 0:30 |
| Pre-warm, sign in, build the Docker image | 0:20 |
| Record both chains, the scripted shots, and the Studio shots, each shot twice | 1:10 |
| openvids chapter cards and procedural sound | 0:20 |
| Edit, captions, and render | 0:50 |
| Upload as unlisted, the logged-out check, then public | 0:30 |
| Buffer | 0:20 |
| Total | 4:00 |
