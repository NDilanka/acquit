**Verdict: F1 CLEAN at `6fec296`.** It is stacked on H0 `2a27d59`, which is the stack root.

F1 adds the escrow ledger. The pure reducer enforces three laws: conservation, one release, and refund or payout but never both. `checkLaws` judges stored books exactly as they are stored. On top of that sit `commercialSplit` and the treasury entries for release and refund. The ctl commands are `ledger --job`, `ledger --all`, `--check`, `--json` and `jobs`. There is also `scripts/ledger-demo.mjs` and the `scripts/perf/ledger.mjs` probe.

**How it was verified.** Six rounds. Each round had a live lane run plus two independent audits from different model families. Fix rounds came in between.

- **Gates at `6fec296`.** Typecheck passes. `npm test` passes 90/90. The 10,000-sequence property test runs in under 1 s.
- **Live lanes.**
  - Lanes 2 to 10 pass on real lane databases. Lane 2 is a zero-bid open job. Lane 3 checks `JOB_NOT_FOUND`. Lane 4 checks that CLI and API ledgers are equal. Lane 5 is a cancelled job with an empty book. Lanes 6 to 8 are the laws and demo rejections. Lane 9 has two return tabs that keep one HELD line. Lane 10 ran `ledger --all --check` on 14 fixture databases holding 17 jobs.
  - Scratch corruption cases all fail closed with `LAW_BREAK`. These are a null book, a null FEE processor and a `[null]` line.
- **Audits.**
  - Stored-row fuzzing went through the real CLI, with 20,186 rows in one audit and 68 in another. A further 900,000 books went through `checkLaws`. No case was wrongly accepted or wrongly refused.
- **Perf.**
  - Ledger GET median: H0 1.56 ms, head 1.46 ms. The limit is 3.87 ms. The lane-0 dev app kept the same PIDs throughout.
  - Boot ratio stays at or below 1.04 in the latest runs.
- **H0 preservation.** Ownership, lifecycle lock, stop, readiness, executables, lanes.mjs and boot.mjs are unchanged. F1 only adds to the shared ctl files: `main.ts`, `registry.ts`, `state.ts` (`readStoredJobs`) and the `process.ts` ErrorCode union.

**Lane 1 was accepted on earlier evidence.** In round 2, the head checkout reached HELD through real PayPal sandbox approval. The amounts were HELD 42000, processor 1515, platform 4485 and seller net 36000. The perf probe also funded a job to HELD by card in later rounds. F1 has not changed the funding path since then. Fresh approvals in rounds 4 to 6 were refused by the H0 safety guard, because an `agent-browser` daemon outside the lanes kept respawning on the verification machine. In round 6 the drive also stopped early, because the reused fixtures had been consumed.

**Accepted deviations.**
- `ledger` reads the lane SQLite file read-only, not through the API. It has to show other clients' books, and the API hides them.
- The RELEASED note reads `payout to operator (360.00)` rather than the tutorial's wording. The amounts are correct.

**Follow-ups.**
- **F2: state agreement.** Check that a job's book matches its status. For example, today a CLOSED job with a stored HELD line prints `Laws: OK`. The laws are book-internal, so this belongs with settlement.
- **F2: zero retained fee.** `refundTreasury` throws when the retained processor fee is zero. Decide whether that can happen before wiring refunds.
- **Low: stored-row robustness.** All of these fail closed or only affect the message:
  - Null `bids` gives `IO_FAILED`.
  - `jobs` on a null state gives `IO_FAILED`.
  - A zero-row jobs table passes `--check`.
  - A null FEE component renders as `0.00` in text.
- **H0 latent.** The ownership preload can read a truncated `run.json`, which shows up as `Unexpected end of JSON input`. Two H0 tests are occasionally flaky under load: readiness and the real-listener dashboard.
