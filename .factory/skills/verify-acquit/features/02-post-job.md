# Post a job

As `maya-client`, open a Bid job for issue `#12` with a budget of `400` USD and a seven-day deadline. Opening a job does not charge the client.

## Sub-features

- `post-open` reaches the form from each New job link.
- `post-configure` selects the issue, budget, and deadline.
- `post-submit` shows a persisted OPEN job and its frozen suite.
- `post-draft-cancel` leaves the form without creating a job.

## How to get to it (user POV)

- Choose `New job` in the top navigation.
- Choose `New job` in the client dashboard header or empty state.
- Open `/jobs/new` while signed in as the client.

## Driving it with agent-browser

Preconditions:

- Doctor passes. Sign in as `maya-client`.
- Use `ab` from the feature index. Save the new job ID for later features.

- **Open the form.** Run `ab open "$webUrl/jobs/new"` and `ab wait --text '#12 Totals round wrong for 3-decimal currencies'`. To test a link entry, snapshot first and click that link's fresh ref instead of navigating directly.
- **Configure the job.** The form lists the deployment's client repository (`ACQUIT_CLIENT_REPOSITORY`; the demo default is `maya-client/invoice-app`, so `<client repo>` below is `maya-client/invoice-app` on the demo). Run `ab select 'select:has(option[value="<client repo>#12"])' '<client repo>#12'`, `ab find label 'Budget (USD)' fill 400`, and `ab select 'select:has(option[value="7"])' 7`. Bid is the only available mode.
- **Capture the action.** Run `ab screenshot --full data/evidence/verify-acquit/RUN_STAMP/post-form.png` and save `ab snapshot` before submission.
- **Open the job.** Run `ab find role button click --name 'Open job' --exact` and `ab wait --text 'Open job page'`. Require `OPEN`, `400.00 USD`, commit `a41c9e2`, 48 visible tests, six hidden tests, and protected paths.
- **Confirm persistence.** Run `ab find role link click --name 'Open job page'`. Run `ab get url` and retain its `job_...` ID. Require a House bid using `house-ts-fixer`. Reopen this URL and save a screenshot.
- **Confirm the stored result.** Use the saved Maya CLI session to read `GET /api/jobs/:id`. Require `status:OPEN`, `phase:BIDDING`, `budget:40000`, and a House bid. Save the sanitized JSON.
- **Cancel a draft.** Open `/jobs/new` again, fill a different budget, and run `ab find role link click --name Cancel --exact`. Require the dashboard and unchanged job count through a read-only jobs query.

## Gotchas

- Several `New job` links can appear at once. Choose a fresh snapshot ref to prove a particular link.
- The opened receipt stays on `/jobs/new` until `Open job page` is chosen.
- The frozen suite text is skeleton metadata. This drive does not run a verifier.
- Opening another job adds another fixture. Do not silently count it as the same proof.
