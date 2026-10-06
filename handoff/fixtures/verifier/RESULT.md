# Verifier tamper detection

This prototype is throwaway. No prototype code belongs in the product.

## Decision

Inferred recommendation. Use B's frozen execution inputs plus A's rejection policy on the final merge diff for this source-only job. Expand the frozen manifest to include the test-runner config and every setup file, loader, and config dependency it uses. Neither variant alone makes hostile source trustworthy. Keep assertions and result collection outside the untrusted program's process before using verification to authorize payment.

Measured. B restores the tests and config before running them, so a PR's forged versions do not decide the result. A catches protected-file changes before execution and retains the tutorial's exact tamper rejection. B alone accepts a good source fix with a corrupted test that would still be in the merged PR.

Measured. Source code that replaces Vitest's `toBe` matcher fools both variants, even with all 54 required tests reported passed and none skipped.

## Inputs and execution

Measured environment. Windows, Node v24.14.1, Git 2.53.0.windows.2, and Vitest 4.0.18.

The verifier runs locally. Job IDs, attempt counts, deadlines, escrow statuses, and PR-open lines reproduce the tutorial's display format. No external job, payment, or pull request exists.

Measured job-open commit. `a3b6ead29f4e367d1871e753b516cc9e832871e4`.

The input requirements come from `D:\dev\Apps\unnamed\docs\tutorial.md:49-59`, `:85-96`, `:294-303`, and `:376-389`. Decision c is in `D:\dev\Apps\unnamed\docs\roadmap.md:98-106`.

Measured fixture. `D:\dev\Apps\unnamed\scratch\verifier\invoice-app` is its own Git repo. Each attack branch starts from the job-open commit. Its 48 frozen tests comprise 47 generated USD cases with literal expected strings and the tutorial's KWD 10.125 case. The initial local suite reports 47 passed and one failed. The tampered local suite reports 48 passed.

Measured hidden fixtures. Six tests live outside the repo in `D:\dev\Apps\unnamed\scratch\verifier\hidden-tests\hidden.test.ts`. They check KWD 1.234, BHD 2.345, OMR 7.891, JOD 4.567, a two-line KWD total of 10.625, and JPY 10.125 formatted as 10. Hidden expected values are literal strings. Hidden files are absent from every fixture branch.

Measured A implementation. Diff the full frozen commit against the submitted commit with rename detection disabled. Reject changes under `tests/` or `.github/`, or to `package.json` or `package-lock.json`. Otherwise materialize the PR, add hidden tests, and run. The submitted Vitest config remains active.

Measured B implementation. Materialize the PR's unprotected files. Ignore all submitted protected files and submitted `vitest.config.*` files. Materialize protected files and `vitest.config.ts` from the job-open commit, then add hidden tests. This also removes newly added protected files instead of leaving them behind during an in-place copy. Run the explicit frozen config. Report protected-file and root-config changes as warnings.

Measured shared execution safeguards. Both use the same external installed Vitest toolchain and direct runner command, not submitted npm scripts. Dependency installation uses `--ignore-scripts`. The verifier explicitly selects `vitest.config.ts`. It requires a zero runner exit plus exactly 48 frozen and six hidden test records, all passed. Missing or skipped required tests reject. This completeness rule is an added safeguard, not a consequence of protecting paths.

Measured limits of this implementation. Test records come from Vitest's JSON reporter in the same runtime that imports submitted source. Counts are not independent proof that assertions were honest. The prototype does not enforce a test-name manifest, read-only filesystem permissions, OS isolation, network isolation, or a separate assertion process. Copying hidden tests into the execution workspace keeps them out of the PR, not out of the executing source's view.

## Measured matrix

One full matrix run executes eight branches against both variants, for 16 verdicts.

| Branch | A | B |
| --- | --- | --- |
| `main` | REJECTED. Frozen 47/48 and hidden 0/6. | REJECTED. Same failures. |
| `tamper-test` | REJECTED. `PR modifies frozen test file tests/totals.test.ts`. | REJECTED. Test edit ignored. Frozen 47/48 and hidden 0/6. |
| `fix-honest` | VERIFIED. Frozen 48/48 and hidden 6/6. | VERIFIED. Frozen 48/48 and hidden 6/6. |
| `cheat-special-case` | REJECTED. Frozen 48/48 and hidden 0/6. | REJECTED. Same failures. |
| `cheat-config` | REJECTED. Runner exits 0 but collects none of the required tests. | REJECTED. Config restored. Frozen 47/48 and hidden 0/6. |
| `cheat-assertion` | VERIFIED incorrectly. Matcher overwritten in source. Reports 48/48 and 6/6. | VERIFIED incorrectly. Same matcher overwrite. |
| `fix-with-test-tamper` | REJECTED. Test edit violates policy. | VERIFIED. Test edit ignored. Frozen 48/48 and hidden 6/6. |
| `cheat-package` | REJECTED. `package.json` changed. | REJECTED. Package edit ignored. Frozen 47/48 and hidden 0/6. |

## Attacks and surprises

Measured special-case attack. The branch adds `if (currency === "KWD" && sum === 10.125) return "10.125"` and leaves two-decimal rounding unchanged. All frozen tests pass. Every hidden test fails, including BHD, OMR, and JOD.

Measured config attack. The branch replaces the root config's include list with `ci/smoke.test.ts`. A setup file outside `tests/` sets a global flag that skips the smoke test. A's runner exits zero and reports one skipped smoke test, with no frozen or hidden tests collected. None of the tutorial's protected paths changed. The completeness rule rejects this result. B ignores the changed config and never loads those new setup and smoke files.

Inferred config lesson. Checking only the four protected path patterns and a zero exit would accept this attack. The measured zero exit and empty required suites demonstrate why collection must fail closed.

Measured assertion attack. Only `src/money.ts` changes. It imports Vitest's `expect` and installs `expect.extend({ toBe() { return { pass: true, message: () => "accepted" }; } })`. Both suites report every test passed. The rounding function still calls `sum.toFixed(2)`.

Measured source probe. Evaluating that same committed function body with the Vitest import replaced by a no-op `expect.extend` adapter returns KWD `"10.13"` and BHD `"2.35"`. The adapter changes only matcher registration, not `formatTotal`. The probe and method are in `D:\dev\Apps\unnamed\scratch\verifier\source-probe.json`.

Measured mixed-fix surprise. B reports VERIFIED despite the submitted test expecting `"10.13"` for the honest source result `"10.125"`. Inferred merge consequence. Merging the original PR restores the corrupted test to the client repo, so the overlay's pass is not verification of the exact merged tree. Preserve A's policy or build and verify a sanitized merge artifact, then bind approval to that artifact.

Measured package attack. Changing the npm test script to `node -e "process.exit(0)"` cannot redirect the verifier. A rejects the changed package file. B restores it and directly runs the trusted toolchain, which finds the source bug.

Measured setup issue. The first honest preflight failed with a Node zone-allocation out-of-memory error and a 30-second timeout. The stderr remains in `D:\dev\Apps\unnamed\scratch\verifier\runs\1791195146279-A-fix-honest\runner.stderr.txt`. A bounded retry passed. All 16 matrix trials then used `--max-old-space-size=256 --v8-pool-size=1`, a single thread worker, and a 30-second runner deadline. The failed preflight is not included in the matrix.

## Proposed tutorial changes

Inferred recommendation. Under the combination, retain the exact REJECTED block at `D:\dev\Apps\unnamed\docs\tutorial.md:297-303`.

Inferred recommendation. Expand the protected-path line at `:93` to include `vitest.config.*` and the actual setup and config dependency manifest from the job-open commit. Add these lines to the VERIFIED block after implementing the corresponding production safeguards:

```text
    Verification inputs: frozen tests, runner config, and dependency lock
    Required tests: 54 completed, 0 skipped or missing
```

Inferred recommendation. Add `Assertion isolation: verifier-owned process` only after that separation is implemented and verified. Do not print it for this prototype. Keep the existing 48 frozen, six hidden, and no protected-path changes lines.

Inferred B-only alternative. Replace the tutorial tamper reason with `Warning: PR modifies tests/totals.test.ts; frozen version used`, followed by `Frozen tests: 1 failed, 47 passed` and `Hidden tests: 6 failed, 0 passed`. Add that warnings do not authorize merging ignored edits. The combination avoids this change and preserves the demo's policy.

Inferred wording correction. The statement at `:96` needs a narrower claim. Freezing tests and config stops editing those verification inputs. It does not stop all source-level cheating. The measured matcher attack contradicts any blanket claim that CI green proves an honest fix.

## Residual risk and follow-up

Measured residual. In-process assertion monkey-patching passes both variants.

Inferred residuals, not exercised here. Source can detect the test environment and behave differently in production. It can inspect mounted hidden cases at runtime, overfit finite inputs, or attempt to forge runner reports when it shares permissions. Other config loaders, case and symlink path tricks, compiler hooks, and dependency lifecycle changes need a frozen execution manifest and a hermetic launcher rather than a short path denylist.

Inferred production follow-up. Use A plus B for source-only jobs. Treat the submitted program as hostile. Put verifier assertions and result collection in a separate process with no shared writable runner or report paths. Execute source under a restricted identity without payment or repository credentials. Pin dependencies and the runner, control setup and loader inputs, require expected test identities and counts, and bind the receipt to the exact reviewed merge commit. Diversify hidden inputs. These safeguards are recommendations, not prototype measurements.

## Artifacts and rerun commands

Measured artifacts. `fixture.mjs` generates the fixture and branches. `verify.mjs <A|B> <branch>` runs one variant. `run-matrix.mjs` runs the complete comparison and prints each tutorial-shaped verdict. `matrix.json` stores structured counts and assertion records. `results.tsv` stores the results table. `raw-outputs.txt` stores the exact printed verifier output. Each executed `runs/<timestamp>-<variant>-<branch>/` retains the execution tree, original Vitest JSON, runner stdout and stderr, result JSON, and printed output. Early path-policy rejections retain only the result JSON and printed output.

Commands run on the installed artifact:

```powershell
node 'D:\dev\Apps\unnamed\scratch\verifier\verify.mjs' A fix-honest
node 'D:\dev\Apps\unnamed\scratch\verifier\run-matrix.mjs'
```

Local reproduction ran `npm test -- --pool=threads --maxWorkers=1 --reporter=json` on `main` and `tamper-test`. Their JSON and command output remain in `local-baseline.json`, `local-baseline-output.txt`, `local-tamper.json`, and `local-tamper-output.txt`. The nested repo is clean and left on `main`. This task changed no parent tracked files. A final dependency comparison reports zero version mismatches between the frozen lock and the external toolchain. All 16 matrix cells have no runner infrastructure error.

Principles applied. Model the Domain chose a branch-by-variant result record. Exhaust the Design Space kept both designs behind one argument switch. Test Behavior, Not Implementation chose literal formatting assertions. Explain the Number added test collection and skip checks instead of trusting a green exit. Prove It Works required actual runner reports and a source behavior probe.

## Raw verifier outputs
```text
$ node verify.mjs A main
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: REJECTED
	Frozen tests: 1 failed, 47 passed, 0 skipped; expected 48, collected 48
	Hidden tests: 6 failed, 0 passed, 0 skipped; expected 6, collected 6
	Failed: formats KWD totals with 3 decimals
	Failed: KWD different amount
	Failed: BHD three decimals
	Failed: OMR three decimals
	Failed: JOD three decimals
	Failed: KWD multiple lines
	Failed: JPY zero decimals
	Runner exit: 1
	Protected paths: none touched
Job status: IN_PROGRESS
Escrow: HELD, locked to devon-ops
Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.

$ node verify.mjs B main
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: REJECTED
	Verification inputs: frozen overlay (tests, CI, package files, vitest.config.ts)
	Frozen tests: 1 failed, 47 passed, 0 skipped; expected 48, collected 48
	Hidden tests: 6 failed, 0 passed, 0 skipped; expected 6, collected 6
	Failed: formats KWD totals with 3 decimals
	Failed: KWD different amount
	Failed: BHD three decimals
	Failed: OMR three decimals
	Failed: JOD three decimals
	Failed: KWD multiple lines
	Failed: JPY zero decimals
	Runner exit: 1
	Protected paths: none touched
Job status: IN_PROGRESS
Escrow: HELD, locked to devon-ops
Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.

$ node verify.mjs A tamper-test
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: REJECTED
	PR modifies frozen test file tests/totals.test.ts
Job status: IN_PROGRESS
Escrow: HELD, locked to devon-ops
Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.

$ node verify.mjs B tamper-test
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: REJECTED
	Verification inputs: frozen overlay (tests, CI, package files, vitest.config.ts)
	Warning: PR touches protected paths; ignored for verification: tests/totals.test.ts
	Frozen tests: 1 failed, 47 passed, 0 skipped; expected 48, collected 48
	Hidden tests: 6 failed, 0 passed, 0 skipped; expected 6, collected 6
	Failed: formats KWD totals with 3 decimals
	Failed: KWD different amount
	Failed: BHD three decimals
	Failed: OMR three decimals
	Failed: JOD three decimals
	Failed: KWD multiple lines
	Failed: JPY zero decimals
	Runner exit: 1
	Protected paths: 1 touched
Job status: IN_PROGRESS
Escrow: HELD, locked to devon-ops
Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.

$ node verify.mjs A fix-honest
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: VERIFIED
	Frozen tests: 48 passed (suite frozen at a3b6ead)
	Hidden tests: 6 passed
	Protected paths: none touched
Pull request opened: maya-client/invoice-app#13
Job status: VERIFIED
Client review window: 72 hours

$ node verify.mjs B fix-honest
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: VERIFIED
	Verification inputs: frozen overlay (tests, CI, package files, vitest.config.ts)
	Frozen tests: 48 passed (suite frozen at a3b6ead)
	Hidden tests: 6 passed
	Protected paths: none touched
Pull request opened: maya-client/invoice-app#13
Job status: VERIFIED
Client review window: 72 hours

$ node verify.mjs A cheat-special-case
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: REJECTED
	Frozen tests: 48 passed (suite frozen at a3b6ead)
	Hidden tests: 6 failed, 0 passed, 0 skipped; expected 6, collected 6
	Failed: KWD different amount
	Failed: BHD three decimals
	Failed: OMR three decimals
	Failed: JOD three decimals
	Failed: KWD multiple lines
	Failed: JPY zero decimals
	Runner exit: 1
	Protected paths: none touched
Job status: IN_PROGRESS
Escrow: HELD, locked to devon-ops
Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.

$ node verify.mjs B cheat-special-case
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: REJECTED
	Verification inputs: frozen overlay (tests, CI, package files, vitest.config.ts)
	Frozen tests: 48 passed (suite frozen at a3b6ead)
	Hidden tests: 6 failed, 0 passed, 0 skipped; expected 6, collected 6
	Failed: KWD different amount
	Failed: BHD three decimals
	Failed: OMR three decimals
	Failed: JOD three decimals
	Failed: KWD multiple lines
	Failed: JPY zero decimals
	Runner exit: 1
	Protected paths: none touched
Job status: IN_PROGRESS
Escrow: HELD, locked to devon-ops
Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.

$ node verify.mjs A cheat-config
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: REJECTED
	Frozen tests: 0 failed, 0 passed, 0 skipped; expected 48, collected 0
	Hidden tests: 0 failed, 0 passed, 0 skipped; expected 6, collected 0
	Test completeness: REJECTED (missing or skipped required tests)
	Protected paths: none touched
Job status: IN_PROGRESS
Escrow: HELD, locked to devon-ops
Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.

$ node verify.mjs B cheat-config
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: REJECTED
	Verification inputs: frozen overlay (tests, CI, package files, vitest.config.ts)
	Warning: PR test-runner config ignored: vitest.config.ts
	Frozen tests: 1 failed, 47 passed, 0 skipped; expected 48, collected 48
	Hidden tests: 6 failed, 0 passed, 0 skipped; expected 6, collected 6
	Failed: formats KWD totals with 3 decimals
	Failed: KWD different amount
	Failed: BHD three decimals
	Failed: OMR three decimals
	Failed: JOD three decimals
	Failed: KWD multiple lines
	Failed: JPY zero decimals
	Runner exit: 1
	Protected paths: none touched
Job status: IN_PROGRESS
Escrow: HELD, locked to devon-ops
Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.

$ node verify.mjs A cheat-assertion
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: VERIFIED
	Frozen tests: 48 passed (suite frozen at a3b6ead)
	Hidden tests: 6 passed
	Protected paths: none touched
Pull request opened: maya-client/invoice-app#13
Job status: VERIFIED
Client review window: 72 hours

$ node verify.mjs B cheat-assertion
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: VERIFIED
	Verification inputs: frozen overlay (tests, CI, package files, vitest.config.ts)
	Frozen tests: 48 passed (suite frozen at a3b6ead)
	Hidden tests: 6 passed
	Protected paths: none touched
Pull request opened: maya-client/invoice-app#13
Job status: VERIFIED
Client review window: 72 hours

$ node verify.mjs A fix-with-test-tamper
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: REJECTED
	PR modifies frozen test file tests/totals.test.ts
Job status: IN_PROGRESS
Escrow: HELD, locked to devon-ops
Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.

$ node verify.mjs B fix-with-test-tamper
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: VERIFIED
	Verification inputs: frozen overlay (tests, CI, package files, vitest.config.ts)
	Warning: PR touches protected paths; ignored for verification: tests/totals.test.ts
	Frozen tests: 48 passed (suite frozen at a3b6ead)
	Hidden tests: 6 passed
	Protected paths: 1 touched
Pull request opened: maya-client/invoice-app#13
Job status: VERIFIED
Client review window: 72 hours

$ node verify.mjs A cheat-package
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: REJECTED
	PR modifies protected path package.json
Job status: IN_PROGRESS
Escrow: HELD, locked to devon-ops
Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.

$ node verify.mjs B cheat-package
Submitted job_7Q2K (attempt 1 of 3)
Verifier result: REJECTED
	Verification inputs: frozen overlay (tests, CI, package files, vitest.config.ts)
	Warning: PR touches protected paths; ignored for verification: package.json
	Frozen tests: 1 failed, 47 passed, 0 skipped; expected 48, collected 48
	Hidden tests: 6 failed, 0 passed, 0 skipped; expected 6, collected 6
	Failed: formats KWD totals with 3 decimals
	Failed: KWD different amount
	Failed: BHD three decimals
	Failed: OMR three decimals
	Failed: JOD three decimals
	Failed: KWD multiple lines
	Failed: JPY zero decimals
	Runner exit: 1
	Protected paths: 1 touched
Job status: IN_PROGRESS
Escrow: HELD, locked to devon-ops
Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.
```
