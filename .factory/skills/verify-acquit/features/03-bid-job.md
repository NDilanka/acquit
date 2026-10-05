# Bid on a job

As `devon-ops`, bid `400` USD with an ETA of two days and agent `ts-bugfixer`. A successful bid spends 10 credits, so the seeded balance changes from 30 to 20.

## Sub-features

- `bid-job-page` sends a bid from the job's Place a bid form.
- `bid-dashboard` opens the inline form from the operator list's Bid button.
- `bid-result` shows the sent bid and remaining credits.
- `bid-client-view` shows the same bid to the client.

## How to get to it (user POV)

- Sign in as the operator and choose `Bid` beside an open job on `/` or `/operator`.
- Choose the job title in Open jobs to reach `/jobs/:id`.
- Open a saved job URL as `devon-ops`.

## Driving it with agent-browser

Preconditions:

- A fresh verification database has a Maya job from feature 02 and Devon has 30 credits.
- Sign in as `devon-ops`. Use `ab` from the index.

- **Read the starting credits.** Use a captured `login --test-user devon-ops --save` result with `ACQUIT_LANE=<n>`. Read `GET /api/me/credits` with its saved Bearer token. Require `credits.available:30`.
- **Open the job form.** Run `ab open "$webUrl/jobs/JOB_ID"` and `ab wait --text 'Place a bid'`.
- **Prove the dashboard entry separately.** Run `ab open "$webUrl/operator"`, snapshot the list, and click the fresh `Bid` ref beside the target job. The inline form appears. Choose `Close` to dismiss it. Use a new job and seeded credits to prove submission through this entry.
- **Enter the bid.** Run `ab find label 'Price (USD)' fill 400`, `ab select 'select:has(option[value="48"])' 48`, `ab select 'select:has(option[value="ts-bugfixer"])' ts-bugfixer`, and `ab find label Pitch fill 'TypeScript currency fix with a dedicated bug-fix agent. Source changes only.'`.
- **Send the bid.** Capture the filled form. Run `ab find role button click --name 'Send bid' --exact`. On the job page, run `ab wait --fn "Array.from(document.querySelectorAll('.bidrow')).some(row => row.textContent.includes('devon-ops'))"`. Capture the Devon bid row and ARIA snapshot. On the dashboard's inline form, wait for `Credits spent: 10 (20 left this week)` and capture that receipt.
- **Verify the debit.** Read `GET /api/me/credits` again and require `credits.available:20`. Save both sanitized credit responses.
- **Confirm the client view.** Sign out, choose `maya-client`, and reopen the job URL. Require a Devon bid with `400.00 USD`, `2 days`, `ts-bugfixer`, and zero verified receipts. Read `GET /api/jobs/:id` and confirm those values.

## Gotchas

- Devon must have READY payouts and an agent. The seed supplies both.
- A bid above the budget fails validation.
- A second bid from the same operator on the same job is not a fresh success case.
- Job-page bidding and inline dashboard bidding are separate entry points. The escrow helper submits only from the job page.
- The job page refresh removes the form and its transient receipt after success. Wait for Devon's persisted bid row, not the receipt text.
- House bids do not spend Devon's credits.
