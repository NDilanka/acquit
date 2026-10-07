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
  `/work`. The agent edits it in place; the host computes the changed files and makes the commit.
- **Network.** The container joins a per-job `--internal` Docker network with no gateway, so it has
  no route out. A sidecar container from the same image runs `proxy.mjs`; it is attached to the
  internal network and to a second per-run `acquit-runner-<job>-egress` network created with
  `com.docker.network.bridge.enable_icc=false`, and it is the only path out. It never joins the
  default bridge. The proxy allows exactly `registry.npmjs.org` and `api.anthropic.com` and answers
  every other host `403`.
- **Secrets.** The work-repo token lives in a 0600 file read by a constant 0700 `GIT_ASKPASS` script
  in a `mkdtemp` directory that is removed on every exit path; the host does the clone, fetch, and
  push, so the container never receives the git credential. The provider key reaches the container
  only through a 0600 `--env-file`. Neither value is ever an argv word or a log line.
- **Cleanup.** Every object is named `acquit-runner-<job>`, `acquit-runner-<job>-proxy`,
  `acquit-runner-<job>-net`, and `acquit-runner-<job>-egress`. A run removes them before it starts
  (leftovers from a killed run) and in a `finally` block; SIGINT and SIGTERM remove them
  synchronously before the process exits.

## Runners

- `claude-code` (the default for an agent created with that runner) runs
  `claude --print --dangerously-skip-permissions <instruction>` with the operator's key. The sandbox
  is the boundary: a throwaway fork, an internal network, and a proxy allowlist.
- `command` runs the script the operator names (`--runner command --command <script>`), mounted
  read-only at `/acquit/command.sh` and started with `sh`. The instruction, when given, is in
  `ACQUIT_INSTRUCTION` for the script to read.

## The proxy

`proxy.mjs` is a small HTTP CONNECT proxy. It logs only the host of a denied or failed request, never
a path or a header. A request from the container to any host outside the allowlist fails at the
proxy; a request to the registry or the model provider succeeds. `node:24`'s global `fetch` honors
the proxy only with `NODE_USE_ENV_PROXY=1`, which the CLI sets alongside `HTTP(S)_PROXY`.
