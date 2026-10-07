# Bid credits, the weekly grant, and the return

An operator's bid costs 10 credits from a weekly allowance of 30, the client's cancel returns them, a
bid nobody answers comes back after 72 hours, and every ISO week Acquit grants a fresh allowance of 30
plus 10 per verified receipt, capped at 100, at the week's first tick.

## Sub-features

- `credits-charge` spends exactly `BID_COST` (10) from allowance first, then purchased. House bids
  never spend.
- `credits-cancel-return` returns the spent split with `CLIENT_CANCEL` when the client cancels an open
  job, so 30 reads 20 after the bid and 30 again after the cancel.
- `credits-no-response` returns a `PENDING` bid past `bidReviewHours` (72) with `NO_CLIENT_RESPONSE`
  through `tick`, and marks the bid `RETURNED`.
- `credits-grant` runs from `tick` once per ISO week, at that week's first tick at or after Monday
  00:00 UTC: allowance = `min(100, 30 + 10 per verified receipt counted when the grant is written)`,
  keyed `grant:<ISO week>`. A Monday the process was down for is caught up by the week's next tick; a
  week no tick ran in is never back-filled.
- `credits-expire` writes `expire:<ISO week>` for the unspent allowance in the same move. Purchased
  credits never expire.
- `credits-cap` holds the allowance at 100 however many receipts the operator has.
- `credits-idempotent` checks each move's key first, so a replayed tick appends nothing and a receipt
  earned after the week's grant is written never grows that week's allowance.
- `credits-denial` serves `GET /api/me/credits` as `{ available, weeklyAllowance, nextGrantAt }`, and a
  `PlaceBid` refused `INSUFFICIENT_CREDITS` answers with the same view so the bid form can say when
  credits return.

## How to get to it (user POV)

- Devon's operator dashboard shows the balance and the weekly allowance line, for example
  `Weekly bid credits: 40 from Monday (30 + 10 for 1 receipt)`.
- Post and bid on a job: the bid form shows the balance fall from 30 to 20.
- The client cancels the job: the balance returns to 30.
- Leave a bid unanswered for 72 hours: the balance returns to 30 and the bid reads `RETURNED`.
- Come back on Monday: the balance is the new week's allowance, not the old one plus a bonus.

## Driving it with agent-browser

Preconditions:

- Follow Launch and Doctor in the skill. Sign in as `devon-ops` for the operator dashboard, and keep
  `maya-client` for the client side. Never print a token.
- `npm run -s ctl -- clock advance <duration>` moves the development clock and runs due work, including
  the weekly grant and the bid-return scan.
- Bidding and cancelling move no money and create no work repo, so any lane works.

- **Read the seeded balance.** `GET /api/me/credits` returns `{ credits: { available: 30,
  weeklyAllowance: 30, nextGrantAt } }` for `devon-ops` after a seed. Require `nextGrantAt` to be the
  coming Monday 00:00 UTC.
- **Bid and read the debit.** Bid on an open job as `devon-ops`. Require the bid response's
  `creditsLeft` to be 20 and `GET /api/me/credits` to read 20. Save `bid-charge.png`.
- **Cancel and read the return.** Cancel the job as `maya-client`. Require `GET /api/me/credits` to
  read 30, the job `CLOSED`, and the bid `RETURNED`. This is lane 1's head assertion.
- **Let a bid go unanswered.** Bid on another job and advance the clock 73 hours
  (`npm run -s ctl -- clock advance 73h`). Require the balance back at 30, the bid `RETURNED`, and the
  job still `OPEN` in `BIDDING`. Save `no-response-return.png`.
- **Watch the Monday grant.** With one receipt, advance the clock from Thursday to Monday. Require the
  balance to read 30 before Monday and 40 after, with a `GRANT` line of 40 and an `EXPIRE` line of the
  unspent allowance. Save `weekly-grant.png`.
- **Watch the cap.** Seed an operator with eight receipts, grant nothing mid-week, and advance to
  Monday. Require the balance to read 100, not 110. Save `grant-cap.png`.
- **Read a denial.** Spend the balance (three bids, or advance a week and spend again), then bid once
  more. Require the bid form to show the denial with the next grant time and no bid to be added.
  `GET /api/me/credits` and the `409` body both carry `nextGrantAt`. Save `no-credits.png`.

## Gotchas

- The count is read when the week's grant is written. A receipt that settles after the grant was
  written raises a later week's allowance, never the balance the week already granted.
- The allowance is expired, not carried over: an unspent 20 becomes 30 on Monday, not 50. A returned
  bid's allowance can exceed the cap, because the cap limits grants, not balances.
- House never spends and never receives a grant. Its receipt count is display data for the quality-bar
  label.
- A returned bid stays `RETURNED` on the job; the operator cannot re-bid on that job.
- A `PENDING` bid past 72 hours is returned even while the job is still `OPEN` and bidding continues.
- The `nextGrantAt` the API serves is computed from the development clock, so a lane that advances the
  clock sees the next Monday move with it.
