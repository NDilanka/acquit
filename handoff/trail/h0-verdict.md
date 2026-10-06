**Verifier verdict: CLEAN at `2a27d597d21f6195ef346aa9ae6d9e496bbcc7d8`** (stack root, base `main` at `e156bc5`).

This PR gives each verification lane its own ports, database, browser and memory budget. It also adds a control CLI that only stops processes it can prove it started.

**How it was verified.** Eight verification rounds ran, each with a live lane worker and two independent audits from different model families. The final round covered `cc42aad..879380c`. Both audits were clean, and every live behaviour check passed. `2a27d59` only raises one test's timeout from 30 s to 60 s. It was checked with 5 green `npm test` runs (65/65) and 3 boot perf runs (ratios 0.92, 0.97, 1.03, limit 1.15).

**Live evidence at the final code head:**
- **Lane 1.** Trunk and head give the same checkout quote (42000 / 4485 / 36000).
- **Lane 6.**
  - Stopping an owned process works.
  - A process that only carries the nonce in its command line is refused.
  - So is a pipe squatter that answers with a victim's PID, and the victim survives.
  - Two concurrent starts produce one winner.
  - The suspended-process report is empty and prints no kill command.
- **Lane 8.** Dev controls refuse without `ACQUIT_DEV`. After `restart`, card funding reaches HELD without a buyer login.
- **Lane 9.** Sandbox buyer approval reaches "Escrow: HELD, locked to devon-ops" and "HELD 420.00 USD" on the first attempt, across repeated fresh runs.
- **Lane 10.** In a three-app wave, cleaning up one lane leaves the other two healthy. An append over the cap is refused.
- **Dashboard refusal.** An agent-browser dashboard on 4848 or on a custom port makes approval refuse before any credential fill.
- **Leak scans.** The scan of every run's artifacts compares against the buyer password in-process and found zero matches.

**Accepted residual.** If the CLI is killed inside libuv's `CREATE_SUSPENDED` window on Windows, a child process can stay suspended. That child never ran the ownership preload. `status` lists it as details only and never kills it.

**Follow-ups (not blocking):**
- A race between the stream check and the credential fill.
- A same-user process could spoof the daemon PID file.
- `taskkill` and `git` are still called by bare name in `scripts/dev.mjs` and `scripts/perf/boot.mjs`.
- The redactor misses base64, NFD and numeric-entity forms of a password that contains `"` together with `+` or `%`.
- Unix ownership proof is unsupported, so stop refuses there.
