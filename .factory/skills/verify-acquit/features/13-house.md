# The House agent: its own payee, its own receipts, and its own delivery

The deployment's own operator, `house-tsfix`, bids on every funded job once, below the operator bids, labeled `House (quality bar): tsfix`. Its payee is the deployment's `OPERATOR_HOUSE_MERCHANT_ID`, never Devon's. Its receipts line is counted from the `receipts` table, seeded rows marked `SEED`. When the client accepts the House bid and funds the job, the API's delivery loop runs the ruled model (`glm-5.3-flash` through the default `droid` provider) in the same sandbox the CLI uses and submits through the same Submit edge, so the job verifies like any operator's.

## Sub-features

- `house-row` shows the House section below the operator bids with `House (quality bar): tsfix`, `400.00 USD`, `1 day`, `house-ts-fixer`, and `41 fixes, 39 passed verified CI` on a freshly seeded lane. The line comes from the `receipts` rows (41 rows, 39 paid, all `source` = `SEED`), not from a counter.
- `house-once` places at most one House bid per job: a second bid attempt is refused with `HOUSE_ALREADY_BID`, and the House spends no credits placing it.
- `house-order` keeps every operator bid above the House section, even when Devon's paid receipts are fewer than the House's, and shows the House section with its label and an empty operators section (`No operator bids yet.`) on a job nobody bid on.
- `house-delivers` accepts the House bid, funds the job, and lets the delivery loop run the model. The API log names the model id at run start and logs the submission. The job reaches `VERIFIED`, and the verifier timeline shows a `House run diff` subsection: the submitted commit, one line per changed file, and the full patch collapsed. The diff is the submitted tree's own `git diff` against the frozen commit, not the scripted fix.
- `house-paid` approves the VERIFIED House job: the referenced payout item goes to the House merchant id, not Devon's, and the ledger reads the same RELEASED/FEE split any operator's job reads.
- `house-count` counts the new real receipt: after `house-paid`, opening a new job shows `42 fixes, 40 passed verified CI`, and a read-only query shows one new `receipts` row for the paid House job whose `source` is `JOB`.

## How to get to it (user POV)

- Open any job page on a seeded lane: the House section is there under the operator bids.
- As the client, accept the House bid, fund the job, and wait for the delivery (a couple of minutes on the free tier). The job page polls itself.
- Approve the verified work as you would any operator's, then open a new job to see the count move.

## Driving it with agent-browser

Preconditions:

- `OPERATOR_HOUSE_MERCHANT_ID` must be set for `seed-db --yes` and for the API start; without it the seed refuses by name. The House merchant must differ from Devon's.
- The House's live run needs Docker, the GitHub App, and the Factory API key on disk at `~/.config/acquit/factory-api-key` (read in-process by the API, never printed). Lanes that must not call the model run the command runner instead: set `ACQUIT_HOUSE_COMMAND=<script>` for the API start, and delivery runs that script with zero model calls under either provider.
- A lane that approves and merges points `ACQUIT_CLIENT_REPOSITORY` at a disposable repo (see the index), because the House's delivery pushes a real submission.

Steps:

- **The row.** Open a job page (`ab open $webUrl`, `ab wait --text 'House (quality bar)'`). Require the House section after the operator bids, the exact line `41 fixes, 39 passed verified CI`, and `400.00 USD`. Read-only check: `SELECT source, COUNT(*) FROM receipts WHERE operator='house-tsfix' GROUP BY source` shows `SEED|41`.
- **Once only.** Try a second House bid on the same job (the loop's own scan or a `POST /api/commands` PlaceBid as `house-tsfix`). Require exactly one House bid in `GET /api/jobs/:id` and the refusal `HOUSE_ALREADY_BID`.
- **Delivers.** Accept the House bid and fund with checkout and real buyer approval (the House merchant has no card-processing capability). Wait for the poll to turn the status `VERIFYING` then `VERIFIED` (median about two minutes; the API log carries `house: <job> submitted`). Require the `House run diff` subsection on the timeline and that its commit matches the submitted commit in the job JSON.
- **Paid.** Approve as in [07](07-approve-release.md). Require `Status: PAID` and read the referenced payout item from PayPal: the receiver is the House merchant.
- **The count.** Open a new job. Require `42 fixes, 40 passed verified CI`, and one new `receipts` row with `source` = `JOB` for the paid job's id.

## Gotchas

- The House line counts rows, and the counter in `operators.paid_receipts` still moves for every operator. A job paid to Devon never moves the House line.
- The delivery loop runs one job at a time and makes at most two model calls per job ever: a provider error retries once, and a 429 never loops. A spent job waits for nothing; its state lives under the state directory beside the database.
- The diff subsection hides when its commit is not the run the verifier is judging, so an older run's diff never masquerades as the current one.
- The seed marks its own 41 rows `SEED`; the migration backfills a `SEED` row for every PAID job an older database already settled. Only the House's own live settlements write `JOB` rows.
