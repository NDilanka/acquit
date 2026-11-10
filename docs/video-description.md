# YouTube description template: "The Trial" (Acquit, 2:50)

Paste the block between the two rules into the video description. Replace every `<PLACEHOLDER>` with the value from the take, then delete the "Fill-in notes" section at the end of this file. The timestamps below are the cut's times from `docs/video-script.md`.

---

The Trial: an AI agent passes every test it can see, fails the hidden ones, and gets no pay.

Acquit is a marketplace for work done by AI agents. A client posts a job. An operator's agent does the work. Hidden tests that the operator cannot see decide payment, and PayPal holds the money in escrow until they pass. This video follows one real job from posting to payout on the hosted demo.

Everything runs in the PayPal Sandbox. No real money moves.

The two catches marked "Scripted agent (Simulated)" are scripted, and the verifier run that checked each one was real. The sample book is labelled "Simulated sample data."

Try it
Live demo: https://80-225-220-230.sslip.io/
Public receipt for the story job: https://80-225-220-230.sslip.io/receipts/<RECEIPT_ID>
Verifier card and print verifier: https://80-225-220-230.sslip.io/verifiers and https://80-225-220-230.sslip.io/print
Source: https://github.com/NDilanka/acquit

Chapters
0:00 Hook
0:15 Charge
0:35 Bail
0:55 Evidence
1:20 Retrial
1:40 Acquitted
2:00 Live Studio
2:18 Sample book
2:30 Verifier score card

The story job: <VISIBLE_COUNT> visible tests and <HIDDEN_COUNT> hidden tests. The attempt that passed every visible test and failed all hidden tests was rejected, and the escrow stayed held. The second attempt passed all of them, and the client released the escrow.

PayPal ids (Sandbox), with the time each first appears
Capture: <CAPTURE_ID> at <CAPTURE_TS>
Payout item: <PAYOUT_ITEM_ID> at <PAYOUT_TS>
Fee: <FEE_BATCH_ID> at <FEE_TS>
Order: <ORDER_ID> at <ORDER_TS>

The capture, payout item, and fee batch are listed on the public receipt above. The order id appears only if the Studio answer shows it.

Known gap: the print verifier accepts a replay of an earlier print of the same file. It is listed on the print page, which is public.

Narration: an AI text-to-speech voice, generated locally with <TTS_ENGINE> under <TTS_LICENSE>. Sound: procedural. No music.

Built for the PayPal AI Hackathon.

---

Pinned comment (same ids and times as the description; add nothing that is not in the video):
Capture <CAPTURE_ID> at <CAPTURE_TS>. Payout item <PAYOUT_ITEM_ID> at <PAYOUT_TS>. Fee <FEE_BATCH_ID> at <FEE_TS>. Receipt: https://80-225-220-230.sslip.io/receipts/<RECEIPT_ID>

---

## Fill-in notes (delete this section before upload)

- `<CAPTURE_TS>`: the first frame where the job page shows the PayPal capture id. It falls in the 0:36 to 0:55 window (Bail). Use the cut's time, not the clock time.
- `<PAYOUT_TS>` and `<FEE_TS>`: the first frame where the public receipt shows each id. Both fall in the 1:40 to 2:00 window (Acquitted). If the receipt reads "None" for the fee, delete the Fee line and keep the note in the video's caption.
- `<ORDER_TS>`: only if the Ask the ledger answer shows the order id on screen, in the 2:00 to 2:18 window. Otherwise delete the Order line.
- `<VISIBLE_COUNT>`, `<HIDDEN_COUNT>`: take these from the take's own job page. The script assumes 48 and 8; change the description if the hosted registry says otherwise.
- The story-job paragraph describes attempt 1 as "failed all hidden tests". If the real first attempt differed (runbook gate G2, or the judge-tour fallback in the script), rewrite that paragraph to match the take before upload.
- The Source link must point to a public repository. Check it logged out.
- `<RECEIPT_ID>`: the story job's receipt id, after the second attempt is paid.
- `<TTS_ENGINE>` and `<TTS_LICENSE>`: the engine and the voice's license as named on its model card, for the voices used in the render (see the runbook, section 9).
- Every id in the description must appear in the video, and every id in the video must appear here (runbook, section 8).
- Check the links logged out in a private window. Each receipt should open and list its ids.
- Do not paste any account email, merchant id, token, saved account link, or API key into the description.
