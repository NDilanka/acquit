# Judge mode: Start my demo, the account switch, and a visitor's own job controls

In public mode (`ACQUIT_DEV` unset) a visitor starts a demo and gets its own client, its own operator, and, when the GitHub App is configured, its own fork of the deployment's repository. The demo lasts 24 hours. Two job controls reach only the visitor's own client, on that client's own job.

## Sub-features

- `judge-start` shows `Start my demo` on the sign-in page and lands on `Your jobs` as `guest-<hex>-client`.
- `judge-restore` keeps the demo across a reload through `GET /api/session`, whose `mode` (`public` or `dev`) also chooses the sign-in page.
- `judge-bar` shows the demo bar under the top bar: `Your demo`, the `Act as client` / `Act as operator` switch (the active one is pressed and disabled), `Signed in as <handle>`, `Repository <owner/name>` (or `the deployment's shared repository` without an App), and `Ends in <h> h <m> min`.
- `judge-switch` moves the session between the visitor's two accounts with `POST /api/demo/switch`. The page remounts as the new account.
- `judge-funding` shows `Payment method` to the visitor's client on its own job while it is `OPEN` / `BIDDING`, with radios `Sandbox test card` (the default for a visitor's job) and `PayPal checkout`.
- `judge-clock` shows `Job clock` to the visitor's client on its own job while it is `OPEN`, `IN_PROGRESS`, or `VERIFIED`, with buttons `Advance 1 hour`, `Advance 1 day`, and `Advance 3 days`. The card names the running total from `job.clockShiftMs`: `This job's clock runs on real time.` before any step, then for example `This job's clock is 2 days ahead.` or `This job's clock is 1 day 1 hour ahead.`. Each step also shows `Moved this job forward <step>.`. A `JOB_CHANGED` answer is sent again up to three times before it is shown.
- `judge-hidden` hides both cards for the visitor's operator, for any other visitor's job, and for every dev-mode session. The API refuses the operator with `403 NOT_VISITOR_JOB` (`Only the demo's client can change this job. (NOT_VISITOR_JOB)`).
- `judge-refusals` shows each refusal as a sentence followed by its code, for example `Today's demos are all taken: the daily limit is reached. Try again tomorrow. (CAP_VISITORS_DAY)` `GitHub could not create your demo repository. Try again in a moment. (DEMO_REPOSITORY_FAILED)`, a late funding choice as `The payment method was fixed when a bid was accepted. (FUNDING_BOUND)` (the card then reloads and closes), and a capped command such as `This demo has opened as many jobs as a demo can. (CAP_VISITOR_JOBS)`.
- `judge-leave` labels the sign-out button `Leave demo` and asks for confirmation, because a demo cannot be re-entered.

## How to get to it (user POV)

- Open `/` without a session on a public-mode lane and choose `Start my demo`.
- Choose `Act as operator` or `Act as client` in the demo bar.
- Open a job as the visitor's client and use `Payment method` and `Job clock` in the right column.

## Driving it with agent-browser

Preconditions:

- Start the lane with `ACQUIT_DEV` unset. Public mode refuses the committed example hidden cases, so set `ACQUIT_HIDDEN_CASES` to the absolute path of `packages/verifier/fixtures/hidden-cases.test.json` for both `seed-db --yes` and `start`. Never point it at `data/private/`.
- With the App configured, `Start my demo` forks `ACQUIT_CLIENT_REPOSITORY` into the App's organization. Unset, that is `maya-client/invoice-app`, which does not exist, and the drive stops at `DEMO_REPOSITORY_FAILED` (`POST /repos/maya-client/invoice-app/forks answered 404`). To drive the UI without creating a GitHub repository, start the lane with `ACQUIT_GITHUB_APP_ID=`, `ACQUIT_GITHUB_APP_PRIVATE_KEY=`, and `ACQUIT_GITHUB_APP_ORG=` set empty in the environment. The visitor's repository is then null and its jobs open on the deployment's repository.
- Use the `ab` function from the feature index with the lane's own session.

Steps:

- **Start.** `ab open $webUrl`, `ab wait --text 'Start my demo'`, `ab find role button click --name 'Start my demo'`, `ab wait --text 'Your demo'`. Require `Act as client` disabled and `Signed in as guest-…-client`.
- **Restore.** `ab reload`, `ab wait --text 'Your demo'`. Require the same handle.
- **Switch.** `ab find role button click --name 'Act as operator'`, wait for the `-ops` handle, then `Open jobs`. Switch back with `Act as client` and wait for `Your jobs`.
- **Open a job.** Post one through [Post a job](02-post-job.md) and open its page. Require `Payment method` with `Sandbox test card` checked, and `Job clock`.
- **Change funding.** `ab find role radio click --name 'PayPal checkout'`. Read `GET /api/jobs/:id` in the browser (`ab eval "fetch('/api/jobs/<id>').then(r=>r.json()).then(b=>b.job.funding)"`) and require `checkout`.
- **Advance the clock.** Note `Deadline` in the header, `ab find role button click --name 'Advance 1 day'`, `ab wait --text 'Moved this job forward 1 day'`. Require `This job's clock is 1 day ahead.`, the deadline one day earlier and `GET /api/jobs/:id` `now` unchanged apart from wall time. Advance again (for example `Advance 1 hour`) and require the total to grow, `This job's clock is 1 day 1 hour ahead.`.
- **Hidden for the operator.** Switch to `Act as operator` on the same page. Require `Place a bid` and no `Payment method` or `Job clock`.
- **Capture proof.** Screenshot each step. Save the sanitized job reads.

## Gotchas

- The page shows the controls only when the signed-in handle is the visitor's client and `job.client` names it. `job.client` and `job.clockShiftMs` are null for every other viewer, and the API refuses the operator with `403 NOT_VISITOR_JOB`.
- `Payment method` closes once a bid is accepted; the API answers `409 FUNDING_BOUND` after that.
- The clock moves only this job's stored instants. The deployment clock and every other job keep their time.
- Each `Start my demo` creates a visitor and counts against `CAP_VISITORS_IP_DAY` and `CAP_VISITORS_DAY`. A refused fork creates none.
- With the App configured, each demo leaves a real repository that `ctl sweep` removes only after the visitor expires.
