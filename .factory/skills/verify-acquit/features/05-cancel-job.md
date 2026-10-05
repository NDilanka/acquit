# Cancel an open job

As Maya, cancel an unfunded open job. The job closes, and Devon receives the credits spent on its bid.

## Sub-features

- `cancel-confirm` asks before cancellation.
- `cancel-dismiss` preserves the open job when the dialog is dismissed.
- `cancel-close` closes the job without moving money.
- `cancel-credits` returns Devon's spent bid credits.

## How to get to it (user POV)

- Open an unfunded job from the client dashboard.
- Choose `Cancel job` in the job header.

## Driving it with agent-browser

Preconditions:

- Use an OPEN BIDDING job from features 02 and 03. Do not accept its bid.
- Devon has 20 credits after bidding. Sign in as `maya-client`.
- Use `ab` from the index. Close only this run's browser with `ab close`. Run `ab --no-auto-dialog open http://localhost:5173` to relaunch the same owned session, then choose `maya-client` from the picker.

- **Reach cancellation.** Run `ab open http://localhost:5173/jobs/JOB_ID` and `ab wait --text 'Cancel job'`. Save the pre-action screenshot and OPEN job API response.
- **Dismiss the dialog.** With automatic dialog handling disabled, run `ab find role button click --name 'Cancel job' --exact`, `ab dialog status`, and `ab dialog dismiss`. Require the message `Cancel this job? Bidders get their credits back.`. Confirm the job remains OPEN and credits remain 20 through read-only API checks.
- **Confirm cancellation.** Run `ab find role button click --name 'Cancel job' --exact` and `ab dialog accept`. Run `ab wait --text CLOSED`. Save the screenshot and snapshot.
- **Confirm persisted state.** Read `GET /api/jobs/:id` as Maya. Require `status:CLOSED`, `escrow:NONE`, and an empty ledger. Read `GET /api/me/credits` as Devon and require `credits.available:30`. Save sanitized responses.
- **Confirm another view.** Return to the client dashboard and reopen the job. The closed state persists. Switch to the operator and require the job to be absent from Open jobs.

## Gotchas

- The UI hides `Cancel job` while funding is active. Use an unfunded job for this feature.
- Default agent-browser dialog handling can accept the confirm automatically. It cannot prove the dismiss branch.
- A House bid alone does not prove credit return. Include a real Devon bid.
- Cancellation is not a refund. No payment has moved on this path.
