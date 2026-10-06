# Cloud handoff

This branch carries the gitignored state that the autopilot-stack session needs on a fresh Linux machine. Do not merge it into `main` or into the stack.

## Restore

From the repo root, run this once on a clone of `main`:

```
bash <(git show origin/handoff/cloud:handoff/restore.sh)
```

The script:

- fetches every branch, including `stack/h0-lanes`, `stack/f1-ledger`, and `stack/f3-verifier`
- copies `trail/` into `data/trail/` and refuses to overwrite
- restores the F3 fixtures into `scratch/verifier` and `scratch/verifier-judge`
- clones `invoice-app` from its bundle with all 7 branches, reinstalls the vitest toolchain, and regenerates the judge trees
- creates worktrees at `../acquit-worktrees/{h0,f1,f3}` and copies `.env` into each one if it exists

Put `.env` in the repo root before or after you run the script. Its keys are listed in `README.md`, plus `SANDBOX_BUYER_PASSWORD`. The secrets are not on this branch.

## Path map

`data/trail/resume.md` was written on Windows. Read its paths this way:

| Windows path | Linux path |
| --- | --- |
| `D:\dev\Apps\unnamed` | repo root |
| `D:\dev\Apps\acquit-worktrees\<pr>` | `../acquit-worktrees/<pr>` |
| `D:\dev\Apps\unnamed\scratch\verifier\invoice-app` | `scratch/verifier/invoice-app` |
| `C:\Users\A S U S\.factory\pvstack-models.md` | `~/.factory/pvstack-models.md` |
| `C:\Users\A S U S\.factory\plugins\...\autopilot-stack.md` | the same path under `~/.factory/plugins/` |

## What changed from the Windows session

- The worktrees are new, so no lane processes or perf-probe lanes (61, 62) exist. F1 lane 9's funded fixture lived in a Windows-only lane database and was not carried over. Don't rebuild it unless F2 needs it.
- The Windows-only blockers no longer apply here: the respawning `agent-browser.exe` daemon, the 8 GB memory cap, and the `taskkill` paths. Check `docker info` again, because Docker may work on this machine. If it does, F3's Docker subject is no longer blocked.
- The `verify-acquit` skill's commands are written for PowerShell at `D:\dev\Apps\unnamed`. Run them from the repo root, and translate `$env:X='v'` to `export X=v`. The cleanup port check becomes `ss -ltn '( sport = :4310 or sport = :5173 )'`.
- H0 lists "Unix ownership is unsupported" as a latent issue. Expect the lane control CLI's stop and ownership paths to behave differently on Linux. Check them before you trust a lane stop.
- `stack/f3-verifier` is at `6fec296`, the same commit as F1. F3 has no commits yet.
