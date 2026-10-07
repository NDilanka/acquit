# Open a dispute and let the arbiter decide

As Maya, open a dispute inside the 72-hour review window instead of approving. The review clock pauses,
the arbiter has 48 hours, and a missed deadline releases to the operator with an alert.

## Sub-features

- `dispute-open` sends `Dispute` with the judged commit from `AWAITING_CLIENT`. The view serves
  `reviewEndsAt` and `viewerCanDispute` for the owning client; a moved head is refused
  `ARTIFACT_CHANGED` and a closed window is refused `REVIEW_CLOSED`.
- `dispute-pause` stores `resolveBy = now + 48h` in `DISPUTED`. `job.phase` reads `DISPUTED`,
  `job.dispute` carries `reason`, `openedAt`, and `resolveBy`, and the old review deadline no longer
  fires: the timer index holds `resolveBy`.
- `arbiter-uphold` releases with authority `ARBITER_UPHELD`; the settled view serves
  `releaseAuthority: "ARBITER_UPHELD"` and one referenced payout item.
- `arbiter-refund` selects `ARBITER_REFUND` and settles one sandbox refund through the existing refund
  path, with the retained-fee reimbursement that follows it (feature 08).
- `arbiter-rework` returns the work to `READY` with the pass kept in history, while a slot and the
  delivery deadline remain; otherwise it is refused `WRONG_STATE`.
- `arbiter-missed` releases with `ARBITER_SLA_MISSED` at `resolveBy` and raises the
  `DISPUTE_SLA_MISSED` alert (an outbox row the deployment's alert sink receives).
- `dispute-cutoff` keeps the day-21 capture-age cutoff first: a dispute past it releases with
  `CAPTURE_CUTOFF`, never `ARBITER_SLA_MISSED`.

## How to get to it (user POV)

- Fund a job to HELD (feature 04) and get a verified pull request (feature 06).
- The job page shows the **Client review** section with the review deadline, the judged commit, and
  **Open dispute** next to **Approve and release**.
- Confirm the dispute with a reason. The page shows the dispute phase, the reason, and the arbiter's
  deadline, and it stops offering Approve.
- An arbiter resolves it through the hackathon route. The job then shows `PAID` (uphold or missed
  deadline) or `REFUNDED` (refund).

## Driving it with agent-browser

Preconditions:

- Follow Launch and Doctor in the skill. Sign in as `maya-client` for the page, `devon-ops` for the CLI.
- The dispute path releases or refunds through PayPal, so a lane must point `ACQUIT_CLIENT_REPOSITORY`
  at a disposable repo when it also approves or merges (feature 07). A refund never merges. Reset the
  disposable repo after each merging job and delete each job's work repo afterwards.
- `npm run -s ctl -- clock advance <duration>` moves the development clock and runs due work.

- **Open the dispute.** On a verified job, require the Client review section with the review deadline,
  the judged commit, **Open dispute**, and **Approve and release**. `GET /api/jobs/<id>` serves
  `reviewEndsAt`, `viewerCanDispute: true`, `dispute: null`, and `releaseAuthority: null` for the owning
  client, and `viewerCanDispute: false` as `devon-ops`. Choose **Open dispute**, enter a reason, and
  confirm. Require `phase: "DISPUTED"` with `dispute.reason`, `dispute.openedAt`, and
  `dispute.resolveBy` 48 hours after the clock's now. The page no longer offers Approve.
- **See the pause.** Advance the clock 73 hours with no arbiter action. Require the job to stay
  `VERIFIED` in `DISPUTED` (not `PAID`) while now is before `resolveBy`, and `reviewEndsAt: null`.
- **Resolve to release.** Send the arbiter verdict through the dev route (any signed-in session):

  ```bash
  # API port is 4310 + 10n for lane n, from `ctl status`.
  curl -s -X POST http://localhost:<api port>/api/dev/arbiter \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"jobId":"<id>","verdict":"UPHOLD","note":"The artifact met the frozen contract."}'
  ```

  Require the job to reach `PAID` with `releaseAuthority: "ARBITER_UPHELD"` and one referenced payout
  item, read back from PayPal as feature 07 does. A second verdict is refused `WRONG_STATE`; an unknown
  verdict is `400 BAD_REQUEST`.
- **Resolve to refund.** On another disputed job, send `verdict: "REFUND"`. Require `REFUNDED` with
  reason `ARBITER_REFUND`, one sandbox refund for the capture, and no receipt. The retained-fee
  reimbursement follows exactly as in feature 08.
- **Miss the arbiter deadline.** Open a dispute and advance the clock 49 hours without a verdict.
  Require `PAID` with `releaseAuthority: "ARBITER_SLA_MISSED"` and one payout item. Require the alert
  row to exist: read the lane's SQLite in read-only mode and require a row in `outbox` whose `json`
  carries `"reason":"DISPUTE_SLA_MISSED"` (the effect key is a digest, so match on the reason). The
  page reads the authority from the paid view.
- **Rework.** Send `verdict: "REWORK"`. Require the job to return to `IN_PROGRESS` in `READY` with the
  judged attempt kept in history and `attempts.left` reduced by the pass it keeps. Submit again and
  require the next run to reserve ordinal 2. A rework past the delivery deadline is refused
  `WRONG_STATE` and the deadline refunds instead.
- **Clean up.** Delete the job's work repo, stop the lane, and leave the client repository as you found it.

## Gotchas

- A dispute is not a refund. The escrow stays HELD and the release or refund happens only when the
  arbiter decides or the deadline fires.
- `resolveBy` is 48 hours from the dispute, not from the verifier's pass. The old 72-hour window is
  paused, not restarted.
- The arbiter route is a development control: it needs `ACQUIT_DEV=1` and a session, and it exists
  because the skeleton has no staff console. It cannot open a dispute.
- The alert is durable before it is delivered: `TimerDue` commits the `ALERT` outbox row in the same
  write as the release selection, so a crash after the release still leaves the alert.
- The day-21 cutoff outranks the arbiter: a dispute past the cutoff releases `CAPTURE_CUTOFF` and does
  not report a missed SLA.
- A row stored before F4 serves `releaseAuthority: null` even when it is PAID.
