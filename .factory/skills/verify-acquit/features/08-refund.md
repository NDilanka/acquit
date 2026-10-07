# Refund the escrow

The client's money comes back when the work never landed. Acquit refunds the whole capture to the
client, and pays the operator back the processing fee PayPal kept and debited them for.

## Sub-features

- `refund-deadline` refunds unverified work once the delivery deadline passes.
- `refund-exhausted` refunds after the third rejected attempt.
- `refund-cutoff` refunds unverified work at the day-21 capture-age cutoff, and releases verified work
  instead, because the verifier passed.
- `refund-settle` books the `REFUND` line and the treasury's `REFUND_FEE_RETAINED` and
  `OPERATOR_REIMBURSEMENT_OWED` entries from the observed refund.
- `refund-reimburse` pays the retained fee back to the operator's merchant as a Standard Payout and
  records PayPal's `0.25` payout fee as a `PAYOUT_FEE_PAID` treasury line.
- `refund-replay` answers a replay of the capture webhook after settlement with `no-op, job already
  REFUNDED`, and answers nothing else.
- `refund-uncertain` never turns an uncertain release into a refund, and never a refund into a release.

## How to get to it (user POV)

- Fund a job to HELD (feature 04) and let the deadline pass without a verified submission.
- The job page shows `Status: REFUNDED` with the reason, the refunded ledger line, and no receipt.
- Devon's merchant receives a separate sandbox payout of the fee PayPal retained.

## Driving it with agent-browser

Preconditions:

- Follow Launch and Doctor in the skill. Sign in as `maya-client` for the page, `devon-ops` for the CLI.
- Use the lane's own database. `npm run -s ctl -- clock advance <duration>` moves the development clock
  and runs due work; the delivery deadline is the job's `deliveryEndsAt`.
- The refund path never merges a pull request, so it never moves the client repository's `main`. A lane
  that also approves and merges (feature 07) must still point `ACQUIT_CLIENT_REPOSITORY` at a disposable
  repo (`NDilanka/invoice-app-f2-perf`, created or reset by
  `node --env-file=<worktree>/.env /home/factory-user/repos/acquit/scratch/client-repo.mjs f2-perf`).
  **Never approve or merge against the shared `NDilanka/invoice-app` fixture.** The job's work repo fork
  is created at funding and must be deleted afterwards.

- **Refund at the deadline.** Fund a job and submit nothing. Advance the clock past `deliveryEndsAt`
  (`npm run -s ctl -- clock advance 8d`). Require the job to reach `REFUNDED` with reason
  `DELIVERY_DEADLINE`, and the ledger to read `HELD 420.00 USD` then `REFUND 420.00 USD  refunded to
  client`. Require `receipt: null` and `escrow: "REFUNDED"`.
- **Refund after three rejections.** Submit a tampered test three times (feature 06). Require the third
  verdict to leave `REFUND_PENDING` with `ATTEMPTS_EXHAUSTED` and the job to settle `REFUNDED`, with
  exactly one sandbox refund for the capture.
- **Read the refund back.** The sandbox lists exactly one refund for the capture, for the full capture
  gross. Assert on that per-transaction refund; never assert on an account balance.
- **Read the reimbursement.** The refund debits the operator the processing fee PayPal kept. The job
  owes it back: read the lane's SQLite in read-only mode and require `REFUND_FEE_RETAINED` and
  `OPERATOR_REIMBURSEMENT_OWED` for the same cents, then a `PAYOUT_FEE_PAID` line once the payout
  settles. Read the payout item from PayPal (`GET /v1/payments/payouts-item/<item id>`, and its batch
  through `GET /v1/payments/payouts/<batch id>`) and require a terminal success. Record the `0.25`
  payout fee from the batch.
- **Replay the capture webhook.** `npm run -s ctl -- webhook replay --capture <capture id>` prints the
  event id it recorded and the outcome; require `no-op, job already REFUNDED` and an unchanged ledger.
  Replay the recorded body with `npm run -s ctl -- webhook replay --event <recorded id>` and require the
  same. The route's re-read of the capture is the recovery path when the inline refund answer was lost:
  a job left in `REFUND_PENDING` settles from that delivery.
- **Clean up.** Delete the job's work repo, stop the lane, and leave the client repository as you found
  it.

## Ledger

- `HELD 420.00 USD  client payment (400.00 job + 20.00 escrow fee)`
- `REFUND 420.00 USD  refunded to client`

The refund is the full capture. The operator's share never moved, so no `RELEASED` and no `FEE` line is
booked. What the operator does carry is the processor fee PayPal keeps on a refund and debits them for:
that is why `REFUND_FEE_RETAINED` and `OPERATOR_REIMBURSEMENT_OWED` carry the same cents, and why a
Standard Payout follows. A card capture's observed fee is `11.37` and a checkout capture's is `15.15`
(measured), so the reimbursement is the capture's own observed fee, never a fixed number.

## Gotchas

- A refund is full-amount only. The provider's refund route takes the whole capture, and a partial
  refund is not part of the skeleton.
- The refund and the release are one disposition per job. An observation that does not match the
  disposition the row selected is an alert, not a state change.
- A job left in `REFUND_PENDING` or `RELEASE_PENDING` at the day-21 cutoff is not switched: it alerts
  `SETTLEMENT_UNCONFIRMED_AT_CUTOFF` for a person.
- The deadline refund waits for a run that is still `VERIFYING`: the slot returns when the run's own
  deadline passes, and only a job still unverified at `deliveryEndsAt` refunds.
- A rejection keeps escrow HELD. It is not a refund, and the deadline is untouched.
- `PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE` on a release, and a fully refunded capture, are settled
  states. Reconcile by lookup instead of resending.
- The buyer's money and the operator's money are different accounts in the sandbox: check the refund on
  the capture and the reimbursement on the operator's merchant, one transaction at a time.
