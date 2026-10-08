# Submit work and get it verified

As Devon, submit a commit for a locked job. The verifier judges it on the frozen inputs, the job
stays with the client on a rejection, and a clean run opens the pull request.

## Sub-features

- `submit-reserve` records one attempt and dispatches exactly one verifier run.
- `submit-reject-protected` rejects a diff that touches a frozen test or a protected path.
- `submit-reject-hidden` rejects a run whose hidden cases fail.
- `submit-reject-framework` rejects submitted source that imports a test framework, and refuses a diff
  that changes more non-binary source paths than the screen reads.
- `submit-verify` verifies a clean run, opens the pull request, and starts the 72 hour review window.
- `submit-replay` answers a repeated request key with REPLAY and starts no second run.
- `submit-denied` refuses a submission from an operator the job is not locked to.
- `submit-timeout` returns the attempt slot when a run never reports, without burning the attempt.
- `submit-run-failed` returns the attempt slot with a named reason when a run ends without a verdict.
- `submit-exhausted` moves the job to REFUND_PENDING after the third rejection.

## How to get to it (user POV)

- Fund a job to HELD and accept Devon's bid. The job shows IN_PROGRESS with escrow HELD.
- In a work directory checked out at the commit to submit, run `acquit submit <job>`. Submit mints the
  scoped work-repo credential from the API (`POST /api/jobs/:id/work-repo-token`) for its push, so the
  operator needs no GitHub credential for the fork. GitHub answers "Repository not found" for two
  causes, and the refusal names both as `WORK_REPO_NOT_READY`: the job's work repo is created shortly
  after funding (the same command works about 30 seconds later), or the App installation cannot see
  the private repo (check the installation on the org).

## Driving it with agent-browser

Preconditions:

- Use a funded IN_PROGRESS job from feature 04. Sign in as `devon-ops` for the CLI and as
  `maya-client` for the job page.
- Prepare the work directory for this lane:
  `node .factory/skills/verify-acquit/scripts/lane-repo.mjs <lane> tamper-test` prints the repository
  path, its HEAD, and the exact CLI command for that lane's API port. Use its `--force` to reset. With
  `--jobs <jobId>` the printed command also carries `--remote <the job's work repo>`; submit pushes the
  lane's HEAD there as its own `refs/heads/submissions/<commit>` ref before it starts the run. A retry
  names its own ref, so it never moves the publisher's `acquit/<jobId>` branch or the pull request that
  branch heads; the verifier reads the commit by SHA, and the publisher creates `acquit/<jobId>` at the
  judged commit itself. With `--jobs <jobId> --askpass` lane-repo mints an
  App installation token for the work repo's organization and prints the command with
  `ACQUIT_LANE_ASKPASS_TOKEN_FILE=<path> GIT_ASKPASS=<path> GIT_CONFIG_GLOBAL=/dev/null`, every path
  shell-quoted: the 0700 askpass script reads the token from the 0600 file the command names, in its
  own `/tmp/acquit-lane-askpass-*` directory, or from `ACQUIT_LANE_GIT_TOKEN` when set. The token is
  valid for one hour, and the directory is the operator's to delete. The product CLI now mints its own
  scoped credential for a push into the job's work repo, so `--askpass` is only for commands that run
  without that route.
- The form and the contract name the deployment's client repository (`ACQUIT_CLIENT_REPOSITORY`; the
  demo default is `maya-client/invoice-app`). This doc writes `<client repo>` for it.
- `ACQUIT_TOKEN` holds Devon's session token. Never print it.
- The judge decides with the deployment's private case file: `ACQUIT_HIDDEN_CASES` is the absolute
  path to a JSON `{"version":1,"cases":[...]}` file holding six `hidden:N` cases. A boot without it
  refuses `VERIFIER_CONFIG_MISSING`; `ACQUIT_DEV=1` falls back to the committed example
  `packages/verifier/fixtures/hidden-cases.example.json`. The API derives the contract's manifest
  digest from that file at boot, so the file and the deployment's contract move together. The file is
  gitignored and is never mounted into the subject. Never print it or copy it into the repository.

- **Reject a tampered test.** Run the printed `acquit submit` command with `--dir <lane repo>`. Require
  stdout to match the tutorial's block: `Submitted job_X (attempt 1 of 3)`, `Verifier result: REJECTED`,
  `\tPR modifies frozen test file tests/totals.test.ts`, `Job status: IN_PROGRESS`,
  `Escrow: HELD, locked to devon-ops`, `Attempts left: 2. Deadline: ...`. Save `reject-tamper.png` and
  the CLI transcript.
- **Confirm the job page agrees.** Run `ab open "$webUrl/jobs/JOB_ID"` and require IN_PROGRESS, escrow
  HELD, one attempt used, and the rejection reason on the page.
- **Verify the honest fix.** Reset the lane repo to `fix-honest` (`lane-repo.mjs <lane> fix-honest
  --force`) and submit again. Require `Verifier result: VERIFIED`, `Frozen tests: 48 passed`,
  `Hidden tests: 6 passed`, `Required tests: 54 completed, 0 skipped or missing`,
  `Pull request opened: <client repo>#<n>`, and `Client review window: 72 hours`. Save
  `verified-pr.png`.
- **Confirm the pull request.** The client repository has the branch and the PR, and the `Acquit
  verifier` check is green. The PR body names the frozen commit and the tallies.
- **Replay the same submission.** Send the same `Submit` twice with one request key. Require `REPLAY`
  on the second answer and exactly one run for that commit.
- **Deny a stranger.** Repeat with an operator the job is not locked to. Require a denial that names
  the locked operator, and no new verifier run.

## Gotchas

- The lexical screen claims exactly five things: a protected path is refused by name under every git
  status (add, modify, delete, rename on both names, mode change, type change), an added line of a
  source file that imports a test framework (`vitest`, `expect`, `node:test`) is refused, a diff past
  4096 changed paths is refused by name (`DIFF_TOO_LARGE`) rather than screened in part, a diff
  that changes more than 256 non-binary source paths is refused by name (`SOURCE_PATHS_OVER_READ_BOUND`)
  because the screen reads added text for only that many, and a tree that carries a submodule
  gitlink is refused by name (`TREE_GITLINK`).
- Below both bounds every changed path is screened, and every changed non-binary source path is
  screened on its added lines. A diff that changes more than 256 non-binary source paths is refused
  whole, so a framework import deep in a large diff cannot go unread.
- It does not read non-source files (a `.yml` workflow or `.json` fixture change trips it only if a
  protected glob names the path; note `vitest.config.ts` ends in `.ts`, so its added lines are read
  like any other source file), it does not resolve module graphs (a re-exported or aliased framework import is
  invisible), it does not see a string built at runtime (`import("vit" + "est")`), it never reads a
  binary diff, and it never runs the submitted tests. The hidden suite, not the screen, is what
  refuses a wrong implementation.
- The subject never sees an expected value. If a hidden expected value appears in the subject's input
  log, that is a failure of the run, not a passing test.
- A module inside the subject process shares the subject's stdin and stdout, so it can read the run
  nonce and write frames of its own. What it cannot reach is an expected value: the 48 frozen values
  are in the submitted tree by construction, and the six hidden values live in the deployment's
  private case file, which is not in the repository and is never mounted into the subject. A
  forged transcript therefore has to answer the hidden cases correctly, which is the same thing as
  fixing the code. The judge refuses any frame that does not echo the run nonce, and the duplicate-id
  rule refuses a forged reply that races the bootstrap.
- A missing or malformed reply counts as missing, and a duplicate id invalidates that id for the whole
  run. A first-reply-wins transcript must never verify.
- A rejection keeps escrow HELD. It is not a refund, and the deadline is untouched.
- A run that ends without a verdict posts its signed callback at once, so the job leaves VERIFYING and
  charges no attempt. The attempt carries a named failure: `PUBLISH_FAILED` (the judgment was clean and
  the pull request or check run could not be made), `SOURCE_UNAVAILABLE`, `SUBJECT_UNSTARTABLE`,
  `SUBJECT_KILLED`, `CONTRACT_MISMATCH`, or `RUN_DEADLINE_EXCEEDED`. The CLI prints
  `RUN_FAILED: <name>: <detail>` and the operator resubmits; the publisher reuses the branch, the pull
  request, and the check run it already made. `GET /runs/<runId>` on the verifier reports the same
  outcome plus the timings of each step, which is how a late verdict is explained rather than guessed
  at. A publish of a commit the client repository has never seen waits, bounded, for the client
  repository to take it before opening the pull request there: GitHub exposes a fresh fork commit to
  the rest of the fork network only after a delay, and no token this App holds can open a
  cross-repository pull request (the client installation is refused 422 `head invalid`, the fork
  owner's installation 403 by the base repository). A commit the client repository never takes is
  refused with GitHub's own text.
- `SUBJECT_KILLED` is the subject stopped from outside the run. The child launcher reads the signal the
  judge did not send; the child-mode submission runs as the same user and can signal itself, so a
  self-signal reads as external too, which is why that launcher is the dev-only path. The Docker
  launcher asks the daemon for the container's kill event, because an exit code of 137 looks the same
  for a `docker kill` and a submission's own `process.exit(137)`; the query names the container by the
  id the client wrote for `--cidfile` (falling back to the run's unique name), and its window closes
  two seconds after the client exits because the daemon logs the kill 300-800 ms late. When the daemon
  cannot answer that query at all, the run is `SUBJECT_KILLED` too, with a detail saying the daemon
  could not report how the subject ended: the submission cannot stop the daemon, so the attempt slot
  returns. A kill event that carries no signal attribute still reports an external kill, named "an
  external signal".
- A container that hits its memory cap is OOM-killed by the kernel: that is the submission's fault and
  stays a REJECTED verdict with a `MEMORY_LIMIT` subject fault, never `SUBJECT_KILLED`. A container
  the judge stops itself (its deadline or a frame limit) stays a verdict fault too; the launcher
  removes that container by name whether the client died by a signal or the judge stopped it, so a
  run's own container cannot be left behind. A judge process that dies between the container's start
  and that removal can still leave a container up: an operator lists them with
  `docker ps -a --filter name=acquit-subject-` and removes them with `docker rm --force <name>`.
- The plain child-process subject is the unit-test path only. The API and `acquit` refuse it with
  `SUBJECT_CHILD_REFUSED` unless `ACQUIT_DEV=1`, and live lanes run the Docker subject, which mounts
  only the submitted tree and a minimal bootstrap and has no network.
- The verdict enters the state machine through the authenticated callback route. The verifier service
  is `packages/verifier/server.ts`; a lane starts it beside the API and the web app, and the API
  reaches it only when `ACQUIT_VERIFIER_CI_URL` names it with the shared run and callback secrets.
  With no CI URL the route answers 503 `VERIFIER_CI_NOT_CONFIGURED`, and `Submit` reserves an attempt
  whose run nothing starts. The route accepts only a body signed with the callback secret; an
  unsigned or malformed report is dropped, and a report for a run the job is not waiting on records
  nothing.
- The job's contract names the deployment's client repository: `ACQUIT_CLIENT_REPOSITORY`, default
  `maya-client/invoice-app`. `OpenJob` accepts only that repository and freezes it into the contract,
  so a lane whose client repo is another account sets the variable and opens a job against it; any
  other repository is denied `NOT_FOUND` by name.
