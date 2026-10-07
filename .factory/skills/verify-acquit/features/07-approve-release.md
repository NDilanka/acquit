# Approve the verified work and release the escrow

As Maya, approve the commit the verifier judged. PayPal releases the escrow to Devon's merchant with a
referenced payout, the job goes PAID with a receipt, and Acquit merges the pull request.

## Sub-features

- `approve-gate` serves the ownership gate: `job.client` names the owner and `job.viewerCanApprove` is
  the API's own answer for this session, so a page can gate the control on ownership, not on role. The
  edge still refuses a stranger with `NOT_OWNER`.
- `approve-artifact` binds the approval to the judged commit. Approving a moved head is refused with
  `ARTIFACT_CHANGED`, and a review window that has closed is refused with `REVIEW_CLOSED`.
- `approve-release` emits exactly one RELEASE whose effect key is the `PayPal-Request-Id`, and settles
  from the referenced payout item: `ReleaseSettled` builds the receipt and the paid book.
- `approve-evidence` serves `job.release`: `payoutItemId`, `captureId`, `paid`, and `at`, so a lane can
  read the payout back from PayPal (`GET /v1/payments/referenced-payouts-items/<item id>`).
- `approve-ledger` books `RELEASED`, `FEE`, and a `PROCESSOR_FEE_VARIANCE` treasury line when PayPal's
  observed fee differs from the quote.
- `approve-merge` emits MERGE after PAID. `job.merge` is `PENDING`, `MERGED` with `at`, or
  `NEEDS_HUMAN` with a reason; `job.pullRequest` and `job.mergeCommit` name the pull and the tree.
- `approve-replay` answers a replay of the capture webhook `applied` and then `no-op, job already PAID`.
- `approve-twice` makes a second approval a refusal the page reads as success, never a second payout.

## How to get to it (user POV)

- Fund a job to HELD (feature 04) and get a verified pull request (feature 06).
- The job page shows the **Client review** section with the judged commit and **Approve and release**.
- Confirm in the dialog: PayPal releases the escrow, the operator is paid, and Acquit merges the commit.
- The page then shows `Status: PAID`, the merged pull request, the receipt id, and the ledger.

## Driving it with agent-browser

Preconditions:

- Follow Launch and Doctor in the skill. Sign in as `maya-client` for the page, and keep Devon's session
  token for the CLI. Never print a token.
- The client repository is the deployment's `ACQUIT_CLIENT_REPOSITORY`. This feature approves and
  merges, so a lane must point it at a disposable repo: start the lane with
  `ACQUIT_CLIENT_REPOSITORY=NDilanka/invoice-app-f2-perf` and create or reset it with
  `node --env-file=<worktree>/.env /home/factory-user/repos/acquit/scratch/client-repo.mjs f2-perf`.
  That prints the repository, its `main` (the frozen commit `a3b6ead`), and whether the App installation
  can see it. **Never approve or merge against the shared `NDilanka/invoice-app` fixture.** Reset the
  disposable repo after each merging job, and delete the per-job work repos afterwards.

- **See the gate.** Open the verified job as `maya-client`. Require the Client review section, the
  judged commit, the pull request number, and the **Approve and release** button. As `devon-ops`, require
  no approve control. The page shows the control only when `job.viewerCanApprove` is true. `GET /api/jobs/<id>` serves `viewerCanApprove: true` only for the owning client.
- **Approve and release.** Choose the button and confirm. Require the page to reach `Status: PAID` with
  the merged pull request, `Receipt rcpt_<id>`, and the ledger lines below. The page reloads the view
  after the command, so a refusal that means "another tab already approved" must not surface as an error.
- **Read the receipt.** Require frozen tests `48/48`, hidden tests `6/6`, `attemptsUsed: 1`, the pull
  request number, and the judged commit. A PAID job serves the attempts its receipt used, not zero.
- **Read the payout back.** `job.release.payoutItemId` names the referenced payout item and
  `job.release.captureId` the escrow capture. Mint a client-credentials token and read
  `GET https://api-m.sandbox.paypal.com/v1/payments/referenced-payouts-items/<item id>`: require
  `processing_state.status` `SUCCESS` and record its `payout_amount`. Assert on that per-transaction
  amount; never assert on an account balance.
- **Replay the capture webhook.** `npm run -s ctl -- webhook replay --capture <capture id>` delivers an
  envelope the route re-reads, and prints the event id it recorded. Replay that body with
  `npm run -s ctl -- webhook replay --event <recorded id>`: require `no-op, job already PAID`, the same
  ledger, and no second payout item for the capture.
- **Confirm the merge.** `job.merge` reaches `MERGED` and the disposable repo's `main` carries the merge
  commit. A merge GitHub refuses parks as `NEEDS_HUMAN` with the reason instead of retrying. The receipt
  panel reads `Merge pending`, then `Merged <time> UTC: pull request #<n>, commit <judged short sha>`
  without a reload (the page polls every 4 seconds while the merge is pending), or
  `Needs a person: <reason>`. The commit is the judged tree, not GitHub's merge commit. Below it the
  panel shows `Payout item <id>, capture <id>` from `job.release`.
- **Clean up.** Reset the disposable repo, delete the job's work repo (`<org>/invoice-app-<tag>-<job id
  without job_>`), and stop the lane.

## Ledger and the card-funding difference

A checkout-funded job books:

- `HELD 420.00 USD  client payment (400.00 job + 20.00 escrow fee)`
- `RELEASED 360.00 USD  payout to devon-ops`
- `FEE 60.00 USD  fees (15.15 PayPal processing + 44.85 Acquit)`

A **card-funded** job (`npm run -s ctl -- fund-mode card`, the dev source) pays out `363.78` USD, not
`360.00`. The card capture's observed PayPal fee is `11.37`, not the `15.15` the checkout quote
predicted, so the referenced payout is the capture's net (`420.00 - 11.37 - 44.85`) and the job records a
`PROCESSOR_FEE_VARIANCE` treasury line with `predicted: 15.15` and `observed: 11.37`. Its ledger reads
`RELEASED 363.78 USD` and `FEE 56.22 USD  fees (11.37 PayPal processing + 44.85 Acquit)`. Expect that
difference whenever the sandbox is funded by card, and read the treasury from the lane's SQLite in
read-only mode when a check needs it.

## Gotchas

- The approval is a real sandbox payout. It cannot be undone from the app.
- One release per job, ever: the effect key is deterministic and PayPal dedupes on the same
  `PayPal-Request-Id`. A repeat returns the same item, never a second payout.
- The release settles from the referenced payout item. If PayPal answers before it is `SUCCESS`, the row
  reconciles by lookup; an uncertain release is never turned into a refund.
- `job.merge` is a separate effect from the release. PAID can be served while the merge is still
  `PENDING`, and that is not a failure.
- An operator approving from the API is denied `NOT_OWNER`; an arbiter is denied the same way.
- The App must be able to see both repositories: the client repo (PR base and the `acquit/<job id>`
  branch) and the work repo fork. A repo created after the installation was selected is not visible
  until it is added; the helper reports `installed`.
