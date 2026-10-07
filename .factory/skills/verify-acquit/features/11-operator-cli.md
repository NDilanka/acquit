# The operator CLI, from sign-in to receipts

The published operator CLI (`packages/acquit-cli`) carries the tutorial's commands: `login`,
`operator init`, `agent create`, `jobs list`, `bid`, `run`, `diff`, `receipts`, and `submit`. Every
block below is asserted against `docs/tutorial.md` character for character by
`packages/acquit-cli/test/cli.test.ts`, except ids, times, and durations.

## Sub-features

- `cli-login` asks the API for a one-time code, prints and opens `<web>/cli?code=...`, polls until a
  signed-in browser approves, and stores the session token at
  `$XDG_CONFIG_HOME/acquit/cli.json` (`%APPDATA%\acquit\cli.json` on Windows) with mode 0600. The row
  keeps only the code's digest, the code is bound to the CLI's own verifier (`POST /api/cli/codes`
  takes `challenge = base64url(sha256(verifier))`, every poll presents `X-Acquit-Verifier`, and a
  missing or wrong verifier is 403 `VERIFIER_MISMATCH`), and the token is handed over exactly once —
  approval and delivery each claim the row with a conditional update inside a transaction, so two
  raced approvals mint one session and two raced polls hand it over once. The session lives seven days.
- `cli-operator-init` reads `GET /api/me/onboarding` for the merchant status the server already holds,
  opens PayPal onboarding when it is still pending, waits for `READY`, then reads the provider key from
  a prompt or from stdin (`--provider-key-stdin`) and stores it in the OS keychain. `--provider
  openrouter` (or answering `openrouter` at the provider prompt, which then asks for the model) also
  stores the model it pins as `acquit:provider-model`, defaulting to `deepseek/deepseek-v4.1-flash`.
  The key never reaches a file, a log line, argv, the environment, or the API.
- `cli-agent-create` reads the prompt file, sends its SHA-256 digest and the tool list to
  `POST /api/me/agents`, and prints the line count. The prompt stays on the operator's machine.
- `cli-jobs-list` renders `GET /api/jobs` as the tutorial's table. `cli-bid` sends one `PlaceBid`
  through `POST /api/commands` and prints the bid as the client sees it. `cli-diff` prints the job's
  patch from the frozen commit to the judged submission (or to the checkout's HEAD) with one line of
  context. `cli-receipts` prints the operator's paid receipts and the next week's allowance.
- `cli-submit-window` prints the client review window as what remains on the API's own clock
  (`GET /api/jobs/:id` answers `now`), not as what the local attempt recorded.
- `cli-run` runs the agent in a network-limited sandbox. See **Run the agent in a sandbox** below.

## How to get to it (user POV)

- `acquit login` → `Signed in as devon-ops (operator)`.
- `acquit operator init` → the three steps, ending `Operator profile ready: acquit.dev/o/devon-ops` and
  `Bid credits: 30 (weekly allowance)`.
- `acquit agent create ts-bugfixer --runner claude-code --prompt prompts/ts-bugfixer.md --allow-tools Read,Edit,Bash`
  → `Prompt: prompts/ts-bugfixer.md (5 lines)`.
- `acquit jobs list` → the `ID MODE BUDGET DEADLINE TITLE` table.
- `acquit bid job_7Q2K --price 400 --eta 2d --agent ts-bugfixer --pitch "..."` →
  `Credits spent: 10 (20 left this week)`.
- `acquit diff job_7Q2K` → the tutorial's test diff.
- `acquit receipts` → `rcpt_9F3D  job_7Q2K  maya-client/invoice-app#13  VERIFIED  paid 360.00 USD` and
  `Weekly bid credits: 40 from Monday (30 + 10 for 1 receipt)`.

## Driving it with the CLI

Preconditions:

- Follow Launch and Doctor in the skill. Every call needs `ACQUIT_LANE=<n>`; use the URLs from
  `ctl status`.
- `npm run -s ctl -- seed-db --yes` gives `devon-ops` a READY merchant, 30 credits, and
  `ts-bugfixer`; it does not open a job, so post one (the browser, or `POST /api/commands` as
  `maya-client`) before `jobs list` and `bid`.
- The token never goes in argv and never gets printed. `acquit login` writes it under the user profile;
  a drive can sign in over HTTP and pass it as `ACQUIT_TOKEN` to the CLI process instead, which is what
  `scripts/perf/cli.mjs` does.
- `ACQUIT_CLI_CONFIG=<path>` points the login file somewhere disposable, so a drive never touches the
  real profile.

- **Sign in.** `POST /api/session {handle:"devon-ops"}` gives a token; `acquit jobs list --api <url>`
  with `ACQUIT_TOKEN` prints the table. Save `jobs-list.png`. For the browser half, run `acquit login`
  with `--no-open`, open the printed URL in the lane's browser session, and require
  `Signed in as devon-ops (operator)` on the terminal. Save `login.png`.
- **Initialize the operator.** Run `acquit operator init --provider anthropic --provider-key-stdin`
  with a key on stdin. Require the three steps and `Bid credits: 30 (weekly allowance)`, then search
  the lane's data folder for the key: it must not be there. On Linux, `keyctl search @u user
  acquit:provider-key` names the entry. An OpenRouter run is the same command with `--provider
  openrouter` and optionally `--model <id>`; the model lands in `acquit:provider-model`. Save
  `operator-init.png`.
- **Create the agent.** Write the tutorial's five-line prompt and run `acquit agent create`. Require
  `Prompt: prompts/ts-bugfixer.md (5 lines)`. Save `agent-create.png`.
- **Bid.** Run the tutorial's `acquit bid`. Require `Credits spent: 10 (20 left this week)` and
  `GET /api/me/credits` to read 20. Save `bid.png`.
- **Diff.** After a run changes `tests/totals.test.ts`, run `acquit diff job_7Q2K` in the operator's
  checkout. Require the tutorial's test diff. Save `diff.png`.
- **Receipts.** After the client approves, run `acquit receipts`. Require the receipt line, the
  `Frozen tests 48/48, hidden tests 6/6, attempts 2 of 3` line, and
  `Weekly bid credits: 40 from Monday (30 + 10 for 1 receipt)`. Save `receipts.png`.

## Run the agent in a sandbox

As `devon-ops`, run the agent on a funded, locked job. `acquit run` asks the API for the job's
work-repo credential, clones the fork, runs the agent in a network-limited container, commits what
it changed, and pushes the commit to the work repo `acquit submit` reads.

### Sub-features

- `run-prepare` asks `POST /api/jobs/:id/work-repo-token` for a token scoped to the job's work repo
  only, clones the work repo, and prints the tutorial's `Preparing sandbox for job_X` block. The
  clone's git directory lives in the CLI's state location
  (`$XDG_STATE_HOME/acquit/work/<job>.git`, `~/.local/state/acquit/work/<job>.git` by default, and
  `%LOCALAPPDATA%\acquit\work\<job>.git` on Windows), outside the work tree the sandbox mounts; the
  work tree's `.git` is an empty directory the sandbox mounts a readable read-only tmpfs over, so the
  agent never sees git metadata.
- `run-claude-code` runs Claude Code with the operator's key, read from the OS keychain that
  `acquit operator init` filled. Anthropic is the default and behaves exactly as before; an operator
  who stored an OpenRouter key runs the same runner through `https://openrouter.ai/api`, with the
  stored model pinned on every Claude Code model variable and the key in `ANTHROPIC_AUTH_TOKEN`.
- `run-command` runs the script the operator names, mounted read-only at `/acquit/command.sh`.
- `run-egress` keeps the container on an internal network whose only route out is the allowlisting
  proxy: `registry.npmjs.org` and the run's provider host only (`api.anthropic.com`, or
  `openrouter.ai` when the operator stored an OpenRouter key; the proxy refuses any other
  `ACQUIT_PROVIDER_HOST`), CONNECT to port 443 and plain HTTP to port 80. The proxy joins a dedicated
  per-run `acquit-runner-<job>-egress` network created with
  `com.docker.network.bridge.enable_icc=false`; it never joins the shared bridge.
- `run-changed-files` counts added lines against the frozen commit and pushes the commit to
  `refs/heads/submissions/<sha>`, the ref `acquit submit` expects. Uncommitted work is folded into
  the pushed commit first, so the count and the push are the same tree.
- `run-rerun` resets the fork to the frozen commit and prints the tutorial's reset block.
- `run-cleanup` removes `acquit-runner-<job>`, `acquit-runner-<job>-proxy`,
  `acquit-runner-<job>-net`, and `acquit-runner-<job>-egress` on every exit path, including a failed
  agent start and a signal, and the run's secret directory with them.

### Driving it from a lane

Preconditions:
- A funded IN_PROGRESS job from feature 04.
- `devon-ops`'s session token in `ACQUIT_TOKEN`, or a stored `acquit login`.
- The runner image, built once with `docker build -t acquit/runner-node20 packages/runner`.

The CLI is `node packages/acquit-cli/src/main.ts` with `--api http://127.0.0.1:<lane API port>`.

- **First run, command runner.** Write a script, kept outside `--dir`, that does three things:
  - Edits `tests/totals.test.ts`, for example `printf '\texpect(2).toBe(2);\n' >> tests/totals.test.ts`.
  - Probes `curl -sS --max-time 15 -o /dev/null https://example.com`, which must fail with
    `CONNECT tunnel failed, response 403`.
  - Probes `curl -sS --max-time 30 -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/`,
    which must print `200`, and `curl -sS --max-time 15 -o /dev/null https://registry.npmjs.org:81/`,
    which must fail: the proxy allows CONNECT only to port 443.
  - Probes the git metadata: `ls -A /work/.git && echo GITDIR_LISTED` must print `GITDIR_LISTED`
    (the shadow is readable), then `[ -z "$(ls -A /work/.git)" ] && [ -r /work/.git ] && echo
    GITDIR_EMPTY` must print `GITDIR_EMPTY` (it lists nothing), and `touch /work/.git/probe` must
    fail with `Read-only file system`. Nothing under `/work/.git` names the fork, the token, or a
    remote.

  Run `acquit run <job> --runner command --command <script> --dir <empty path>`. Require the
  tutorial's first block and `Changed files: tests/totals.test.ts (1 line)`.
- **No leftovers.** After every run, `docker ps -a --filter name=acquit-runner` and
  `docker network ls --filter name=acquit-runner` must be empty, so neither the internal network nor
  `acquit-runner-<job>-egress` survives.
- **Re-run with an instruction.** Run again on the same job with `--instruction "..."` and a script
  that fixes `src/money.ts`. Require the reset fork line, then `Changed files: src/money.ts (<n> lines)`.
- **Submit what run pushed.** `acquit submit <job> --dir <the same --dir>`. Submit reads the
  submitted commit and pushes through the job's state git directory when `--dir` is the work tree
  that directory records, so a run checkout needs no discovery of its own; any other `--dir` is the
  operator's own checkout and keeps discovery. It mints the scoped work-repo credential itself
  (`POST /api/jobs/:id/work-repo-token`) and pushes through an askpass script in a 0600 temp dir it
  removes, so the operator needs no GitHub credential for the fork. The push target is the job's work
  repo by default; `--remote origin` (or a `--remote` URL) that resolves to the work repo takes the
  same path, and any other remote keeps the operator's own credential. A named remote also falls back
  to the operator's own credential when the mint answers `NOT_OWNER`, `WORK_REPO_NOT_READY`, or
  `GITHUB_NOT_CONFIGURED`; the default target surfaces the latter two with their own hint, and a
  `WORK_REPO_TOKEN_FAILED` mint is never a fallback. Run already pushed the commit to its submission
  ref, so submit's push is an up-to-date no-op.
- **claude-code.** Run `acquit run <job> --runner claude-code` with a stored key. Without a key, the
  CLI refuses `PROVIDER_KEY_MISSING` before it starts anything. An operator who stored an OpenRouter
  key runs the same command through OpenRouter: the run line names
  `OpenRouter key, model <id>`, and the proxy allows `openrouter.ai` instead of `api.anthropic.com`.
- **Strangers are refused.** A session that is not the job's locked operator gets
  `403 { error: "NOT_OWNER" }` from the token route before any clone or container.

### Gotchas

- An existing `--dir` is only accepted when it is the work tree the job's state git directory
  records (`DIR_NOT_WORK_REPO` otherwise), so a run never resets an unrelated checkout. An empty path
  is adopted when that recorded work tree is gone, and an older checkout with an in-tree `.git` is
  refused by name: pass a fresh `--dir`, or remove `$XDG_STATE_HOME/acquit/work/<job>.git` to clone
  afresh. The CLI never removes a state git directory by itself: after a job is done, delete
  `$XDG_STATE_HOME/acquit/work/<job>.git` (on Windows `%LOCALAPPDATA%\acquit\work\<job>.git`) to
  reclaim it.
- Every run checks out the frozen commit and runs `git clean -fd` first, so uncommitted work in
  `--dir` is lost.
- The work tree's `.git` is re-made as an empty real 0700 directory immediately before every sandbox
  mount, so a symlink a previous run planted there (`.git -> /etc`) is unlinked rather than mounted
  through, the read-only tmpfs always lands on the work tree's own `.git`, and the link's target is
  never touched. The mount names mode 0555: Docker would otherwise copy the host shadow's 0700, which
  the container's own user cannot read. Host-side `git add -A`, status, and the changed-file count
  never record anything under `.git`.
- Host-side git names a job's state checkout explicitly — the state git directory and the work tree —
  and never reads the operator's global or system config there: every command sets an empty
  `core.hooksPath` and disables the fsmonitor, credential helper, and ssh command, and settles TLS
  verification and any proxy with its own `-c` overrides. An own checkout (a `--dir` the state git
  directory does not record) is read through discovery with those guard overrides still applied; a
  push with the operator's own credential keeps the operator's git environment and credential helper,
  minus the `ACQUIT_*` variables, while a push driven by the scoped token is hardened. A git directory
  that holds config the CLI did not write refuses the scoped push (`GIT_CONFIG_UNSAFE`) instead of
  letting the scoped token meet a URL rewrite, an http proxy, a TLS verification git reads as false,
  a planted CA bundle, or a credential helper; the refusal names the directory and its remedy. The
  off-github `remote.*.url` rule applies to the state checkout alone: the scoped push names the
  work-repo URL explicitly, so an operator's own remotes cannot steer it, while every
  `insteadOf`/`pushInsteadOf`/`pushurl` rewrite refuses everywhere.
- `--runner command` needs `--command`, and a missing script refuses `COMMAND_MISSING`.
- The first run right after funding can answer `WORK_REPO_NOT_READY` while GitHub creates the work
  repo. Rerun in about 30 seconds.
- The work-repo token is never printed. The session token never comes from argv (`--token` reads
  stdin), and both are stripped from the git and docker children's environments; the askpass script
  names its own token file, so no token-path variable rides in the git child's environment either.
  `submit` mints the same scoped token for a push into the job's work repo; a mint the API refuses to
  a stranger falls back to the operator's own credential and lets `Submit` name the denial.
- On Linux the provider key lives in the kernel user keyring, which a reboot clears. Run
  `acquit operator init` again after a reboot.
- The claude-code runner starts Claude Code with `--dangerously-skip-permissions`. The sandbox is the
  boundary: a throwaway fork, an internal network, and the proxy allowlist.

## Perf

`node scripts/perf/cli.mjs --rounds 5` boots a detached trunk worktree and the head worktree on two
lanes, seeds the head lane, and reports:

- `help`: one `acquit submit --help` process at each side, trunk's median recorded first as the
  baseline. Trunk carries no per-command help, so it answers that argv with `USAGE: Unknown flag
  --help.` and exit 1; the work is the same and each side's exit codes are in the report.
- `jobsList`: one `acquit jobs list` process against the seeded head lane, after one warm-up.
- `runStart`: one `acquit run --runner command` process from start to the agent-start line
  `renderRunning` prints just before the sandbox starts, warm: one untimed warm-up that clones the
  job's fork, then one timed sample per round on the same `--dir`. It needs a funded IN_PROGRESS job
  locked to `devon-ops` in the head lane, Docker, and the `acquit/runner-node20` image. The seed opens
  no job (it does give `devon-ops` the `ts-bugfixer` agent, so the metric needs no agent created) and
  this probe creates nothing on GitHub and moves no money, so a lane without one is reported as
  blocked — `RUN_NEEDS_FUNDED_JOB`, `RUN_DOCKER_UNAVAILABLE`, `RUN_IMAGE_MISSING`,
  `RUN_WORK_REPO_NOT_READY`, `RUN_GITHUB_NOT_CONFIGURED`, `RUN_START_FAILED`, `RUN_AGENT_FAILED` —
  never as a number. A blocked metric does not fail the probe.

`ACQUIT_TOKEN=<lane session> node scripts/perf/cli.mjs --run-lane 16 --run-job job_<id>` measures only
`runStart`, against a lane the operator already runs: the probe boots, seeds, and stops nothing, reads
`GET /api/jobs` with the token from `ACQUIT_TOKEN` (never argv), and writes `<evidence>/run-start.json`
instead of `cli.json`. `--run-lane` must be 1 or more (lane 0 is the real database) and the pair is
required together. Blockers it can meet alone: `RUN_TOKEN_MISSING`, `RUN_LANE_UNREACHABLE`,
`RUN_TOKEN_REJECTED`, `RUN_JOB_UNKNOWN`, `RUN_JOB_NOT_FUNDED`. Every sample of one measurement shares the probe's own `XDG_STATE_HOME`
(`LOCALAPPDATA` on Windows) under the probe's temp root, so it never meets the measured lane's state
git directory, and the sweep removes that root with the state home in it. It sweeps only the
`acquit-runner-<job>` objects and temp roots its own samples made.

Rules: fail if the head `--help` median exceeds the trunk median by more than 20 percent, or if the
`jobs list` median exceeds 800 ms, or if the warm run-start median exceeds 30 seconds. A live-lane run
is judged on the run-start rule alone.

## Gotchas

- `login` prints and opens the web app's `/cli?code=...` page. The API half is here; the page itself is
  `apps/web/**`, which is outside this round's file scope, so a drive approves through
  `POST /api/cli/approve` with the browser's session and the code until that page lands. A drive that
  polls the code must present the same verifier the CLI minted (`X-Acquit-Verifier`); a poll without
  it is 403 `VERIFIER_MISMATCH`.
- The keychain is the OS store, per platform: Windows Credential Manager through the WinRT
  PasswordVault, the Linux kernel user keyring through `keyctl` (`padd`/`pipe`, the secret on stdin),
  and the macOS login keychain through `security`. The Linux user keyring is memory only, so a reboot
  clears it and `acquit operator init` is re-run. A restricted container may allow `keyctl padd` but
  deny `keyctl pipe` on `@u`; the store is still the user keyring, and the CLI reports a refusal by
  name rather than falling back to a file.
- `operator init` prints `Connected: sandbox Business account (payouts enabled)` from the API's
  onboarding view. The operator row holds the merchant id, not a display name; the route synthesizes
  that one phrase for the sandbox tutorial.
- `diff` compares against the frozen commit in the operator's own checkout. When the judged submission
  is not in the local object database it falls back to HEAD, and the patch is whatever git prints with
  one line of context, without git's own `diff --git` and `index` header lines.
- `jobs list` uses the tutorial's fixed column widths. A real job id is the `job_<uuid>` shape and is
  longer than the tutorial's `job_7Q2K`, so a row with a live id reads raggedly while the header and
  the columns stay the tutorial's.
- The review window is measured against the API's `now`. A lane that advances the development clock
  after the verdict sees the remaining window shrink; it never grows.
- `receipts` reads PAID job rows and the `operators.paid_receipts` count, so it is empty until a job is
  released, and the allowance line spells the count as `1 receipt` or `N receipts`.
- `agent create` sends the prompt's digest, never the prompt. A prompt whose digest changes registers
  under the same name only if the name is free; a duplicate name is refused with `AGENT_EXISTS`.
