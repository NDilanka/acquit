# The runner sandbox

`acquit run <job>` delivers one attempt: it asks the API for a work-repo credential, clones the
job's fork, runs the operator's agent in the container below, commits what the agent changed, and
pushes the commit to the work repo the way `acquit submit` expects. The CLI itself lives in
`packages/acquit-cli/src/run.ts`.

## Build

```sh
docker build -t acquit/runner-node20 packages/runner
```

The CLI refuses to start a container from a missing image; it never pulls one implicitly
(`--pull=never`).

## What the sandbox is

- **Image.** `acquit/runner-node20` (override with `ACQUIT_RUNNER_IMAGE`). Node 24, git, and the
  Claude Code CLI.
- **Clone.** The job's work repo is cloned on the host with a scoped credential and bind-mounted at
  `/work`. The git directory lives in the CLI's state location
  (`$XDG_STATE_HOME/acquit/work/<job>.git`, `~/.local/state/acquit/work/<job>.git` by default, and
  `%LOCALAPPDATA%\acquit\work\<job>.git` on Windows), outside the bind mount: the agent never sees
  git metadata, and the work tree's `.git` is an empty directory the sandbox mounts a readable
  read-only 0555 tmpfs over. The CLI re-makes that shadow as an empty real 0700 directory immediately
  before every mount, so a symlink a previous run left at `.git` is unlinked rather than mounted
  through; the tmpfs names mode 0555 because Docker would otherwise copy that 0700, which the
  container's own user cannot read. Host git names a job's state checkout explicitly — the state git
  directory and the work tree — and runs there with hooks, the fsmonitor, the credential helper, the
  ssh command, TLS verification, and any proxy all settled by its own `-c` overrides plus an empty
  global config. An own checkout (a `--dir` the state git directory does not record) is read through
  discovery with those guard overrides still applied; a push with the operator's own credential keeps
  the operator's git environment and credential helper, minus the `ACQUIT_*` variables, while a push
  driven by the scoped token is hardened. The CLI never removes a state git directory: delete
  `$XDG_STATE_HOME/acquit/work/<job>.git` after a job is done. The agent edits the work tree in
  place; the host computes the changed files and makes the commit.
- **Network.** The container joins a per-job `--internal` Docker network with no gateway, so it has
  no route out. A sidecar container from the same image runs `proxy.mjs`; it is attached to the
  internal network and to a second per-run `acquit-runner-<job>-egress` network created with
  `com.docker.network.bridge.enable_icc=false`, and it is the only path out. It never joins the
  default bridge. The proxy allows exactly `registry.npmjs.org` and the run's provider host:
  `api.anthropic.com`, or `openrouter.ai` when the operator stored an OpenRouter key. The CLI passes
  that host as `ACQUIT_PROVIDER_HOST`, and `allowlist.mjs` refuses any value outside the provider
  table's hosts, so the environment cannot widen egress; every other host is answered `403`.
- **Secrets.** The work-repo token lives in a 0600 file named by a constant 0700 `GIT_ASKPASS` script
  in a `mkdtemp` directory that is removed on every exit path; no token path travels in a child's
  environment. The host does the clone, fetch, and push, so the container never receives the git
  credential. The provider key reaches the container only through the docker child's environment:
  `-e ANTHROPIC_API_KEY` names it with no value for Anthropic, `-e ANTHROPIC_AUTH_TOKEN` for
  OpenRouter, and no other child gets it. Neither value is ever an argv word or a log line.
- **Cleanup.** Every object is named `acquit-runner-<job>`, `acquit-runner-<job>-proxy`,
  `acquit-runner-<job>-net`, and `acquit-runner-<job>-egress`. A run removes them before it starts
  (leftovers from a killed run) and in a `finally` block; SIGINT and SIGTERM remove them and the
  run's secret directory synchronously before the process exits.

## Runners

- `claude-code` (the default for an agent created with that runner) runs
  `claude --print --dangerously-skip-permissions <instruction>` with the operator's key. The sandbox
  is the boundary: a throwaway fork, an internal network, and a proxy allowlist. The provider is
  whichever key `acquit operator init` stored: Anthropic runs against `api.anthropic.com` unchanged,
  while OpenRouter runs against `https://openrouter.ai/api` with the stored model pinned on every
  Claude Code model variable and the key in `ANTHROPIC_AUTH_TOKEN`. Every claude-code run also sets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so the CLI makes no call the proxy would refuse.
- `command` runs the script the operator names (`--runner command --command <script>`), mounted
  read-only at `/acquit/command.sh` and started with `sh`. The instruction, when given, is in
  `ACQUIT_INSTRUCTION` for the script to read.

## The proxy

`proxy.mjs` is a small HTTP CONNECT proxy. It logs only the host of a denied or failed request, never
a path or a header. Its allowed hosts are the registry plus the one provider host the CLI passed as
`ACQUIT_PROVIDER_HOST`; `allowlist.mjs` accepts only a host from the provider table (`api.anthropic.com`
or `openrouter.ai`) and exits rather than listen on anything else. The allowlist is a scheme, a host,
and a port: a CONNECT is allowed only to 443, and a plain HTTP forward only to an absolute-form
`http:` URL with no userinfo on port 80, so the right host on another port or scheme is refused too. A
forward copies no hop-by-hop header, no header `Connection` names, and never the caller's `host`: the
proxy dials the allowlisted host itself and lets Node name it. A repeated or comma-joined
`content-length` is dropped too, and the body is framed by this hop instead, so a request cannot
smuggle a second one. A request from the container to any host outside the allowlist fails at the
proxy; a request to the registry or the run's model provider succeeds. A host process can reach the
proxy through its egress bridge IP, but host processes already have unrestricted network access, so
the proxy grants them nothing new; the threat model is the sandboxed container, which has no other
route out. `node:24`'s global `fetch` honors the proxy only with `NODE_USE_ENV_PROXY=1`, which the
CLI sets alongside `HTTP(S)_PROXY`.
