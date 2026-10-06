# Submit work and get it verified

As Devon, submit a commit for a locked job. The verifier judges it on the frozen inputs, the job
stays with the client on a rejection, and a clean run opens the pull request.

## Sub-features

- `submit-reserve` records one attempt and dispatches exactly one verifier run.
- `submit-reject-protected` rejects a diff that touches a frozen test or a protected path.
- `submit-reject-hidden` rejects a run whose hidden cases fail.
- `submit-reject-framework` rejects submitted source that imports a test framework, and refuses a diff
  that changes more source paths than the screen reads.
- `submit-verify` verifies a clean run, opens the pull request, and starts the 72 hour review window.
- `submit-replay` answers a repeated request key with REPLAY and starts no second run.
- `submit-denied` refuses a submission from an operator the job is not locked to.
- `submit-timeout` returns the attempt slot when a run never reports, without burning the attempt.
- `submit-exhausted` moves the job to REFUND_PENDING after the third rejection.

## How to get to it (user POV)

- Fund a job to HELD and accept Devon's bid. The job shows IN_PROGRESS with escrow HELD.
- In a work directory checked out at the commit to submit, run `acquit submit <job>`.

## Driving it with agent-browser

Preconditions:

- Use a funded IN_PROGRESS job from feature 04. Sign in as `devon-ops` for the CLI and as
  `maya-client` for the job page.
- Prepare the work directory for this lane:
  `node .factory/skills/verify-acquit/scripts/lane-repo.mjs <lane> tamper-test` prints the repository
  path, its HEAD, and the exact CLI command for that lane's API port. Use its `--force` to reset.
- `ACQUIT_TOKEN` holds Devon's session token. Never print it.

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
  `Pull request opened: maya-client/invoice-app#<n>`, and `Client review window: 72 hours`. Save
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
  source file that literally mentions `vitest`, `expect(`, or `node:test` is refused, a diff past
  4096 changed paths is refused by name (`DIFF_TOO_LARGE`) rather than screened in part, a diff
  that changes more than 256 source paths is refused by name (`SOURCE_PATHS_OVER_READ_BOUND`)
  because the screen reads added text for only that many, and a tree that carries a submodule
  gitlink is refused by name (`TREE_GITLINK`).
- Below both bounds every changed path is screened, and every changed source path is screened on its
  added lines. A diff that changes more than 256 source paths is refused whole, so a framework import
  deep in a large diff cannot go unread.
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
  are in the submitted tree by construction, and the six hidden values exist only in the judge. A
  forged transcript therefore has to answer the hidden cases correctly, which is the same thing as
  fixing the code. The judge refuses any frame that does not echo the run nonce, and the duplicate-id
  rule refuses a forged reply that races the bootstrap.
- A missing or malformed reply counts as missing, and a duplicate id invalidates that id for the whole
  run. A first-reply-wins transcript must never verify.
- A rejection keeps escrow HELD. It is not a refund, and the deadline is untouched.
- The plain child-process subject is the unit-test path only. The API and `acquit` refuse it with
  `SUBJECT_CHILD_REFUSED` unless `ACQUIT_DEV=1`, and live lanes run the Docker subject, which mounts
  only the submitted tree and a minimal bootstrap and has no network.
- The verdict enters the state machine through the authenticated callback route. While
  `createAcquit` still builds the H0 verifier stub, the route answers 503 `VERIFIER_PORT_NOT_WIRED`
  and the live lanes cannot complete; see `data/evidence/f3-r1-build/acquit-ts-wiring.patch`.
