# Post a job, accept a bid, and fund escrow

Post a `400` USD job as Maya, bid as Devon, and accept Devon's bid. Acquit creates a real PayPal sandbox order for `420.00` USD. Buyer approval can then hold escrow for Devon.

## Sub-features

- `fund-post-bid` creates the job and Devon bid through web forms.
- `fund-confirm` shows the chosen operator and 5% client fee before acceptance.
- `fund-checkout` redirects to the real sandbox order and freezes the correct payee and quote.
- `fund-resume` reopens an awaiting-approval checkout from the job page.
- `fund-held` completes buyer approval when credentials are available.

## How to get to it (user POV)

- Choose `Accept` on Devon's bid at `/jobs/:id`, then `Accept and pay with PayPal`.
- Reopen a funding job and choose `Resume PayPal checkout`.
- Finish payment in PayPal sandbox and return to the job page.

## Driving it with agent-browser

Preconditions:

- Follow Launch and Doctor in the skill. Start with 30 Devon credits.
- Real sandbox merchant configuration is present. Do not print its values.

- **Run the complete checkout drive.** Set `$env:DATABASE_PATH='./data/verify/acquit.db'`. Run `node .factory/skills/verify-acquit/scripts/fund-escrow.mjs drive RUN_STAMP`. Require exit code zero and `passed:true`. The script uses the forms and picker, not command API shortcuts.
- **Confirm acceptance.** Inspect `07-accept-confirm.png`. Require `Accept devon-ops?`, `400.00 USD` budget, `20.00 USD` fee, and `420.00 USD` total.
- **Confirm checkout.** Inspect `08-paypal-checkout.png`, its snapshot, and `summary.json`. Require host `www.sandbox.paypal.com` and path `/checkoutnow`. No live PayPal checkout is allowed.
- **Confirm funding side effects.** Read `job-funding.json` and `funding-checks.json`. Require `OPEN`, `FUNDING`, `AWAITING_APPROVAL`, total `42000`, platform fee `4485`, operator net `36000`, and `payeeMatchesConfiguredDevon:true`. The API exposes only the public state. The helper reads the omitted quote and checkout substate from SQLite in read-only mode.
- **Prove resume separately.** Reopen the saved job URL without approving. Run `ab wait --text 'Resume PayPal checkout'`, capture the funding screen, and run `ab find role link click --name 'Resume PayPal checkout' --exact`. Require the same sandbox host and order. Do not report resume as proved by the initial redirect.
- **Optionally complete approval.** Follow the skill's optional buyer approval step if `SANDBOX_BUYER_PASSWORD` is set. Require `Escrow: HELD, locked to devon-ops`, a `HELD 420.00 USD` ledger line, and matching API state. Otherwise stop at checkout and record approval as skipped.
- **Retain proof.** Run Cleanup from the skill. Confirm the evidence directory still lists the screenshots, API JSON, summary, and cleanup record.

## Gotchas

- `Accept` immediately creates a real sandbox order. It is not a dry-run.
- Select Devon's row, not the House row. The helper uses a fresh Accept ref from the snapshot's Operators section.
- The helper proves checkout creation, not HELD escrow. Approval requires the buyer password.
- The buyer password is not stored in the repo. Do not seek it in the PayPal dashboard.
- Public `lockedTo` stays null until money is held. The stored funding choice proves the payee before approval.
- Do not manually invoke `/paypal/return` to fake approval. Return must follow the real purchase.
