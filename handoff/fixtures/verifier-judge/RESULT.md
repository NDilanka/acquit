# Judge and subject split

This prototype is throwaway. Do not ship its scripts or treat it as a security boundary.

## Decision

Measured. The fixture's assertions cross a Node process boundary successfully. The honest fix passes all 48 frozen cases and six hidden cases. Submitted source never runs in the judge.

Measured. The existing `cheat-assertion` branch rejects at the static screen because it imports Vitest. A separate source-local `expect.extend` attack passes that import screen and executes. Its replacement matcher cannot change the judge's comparisons. It fails frozen case 48 and all six hidden cases.

Measured. Sending a forged successful reply before the real reply would fool a first-reply-wins parser. All 54 first replies in the attack transcript equal the judge's expected values. The implemented parser permanently invalidates every duplicated ID. It rejects all 54 as missing.

Inferred. Use B's container launcher for the product, with judge-owned comparison and strict RPC validation. A demonstrates assertion separation but does not isolate the submitted program from host files, the network, or the judge's manifest. Choose B for containment, not for measured speed.

Unproven. B's execution, read-only mounts, network isolation, verdicts, and performance were not exercised. Docker's daemon is down. No Docker service was started or reconfigured.

## What ran

Measured environment. Windows, PowerShell 7, Node v24.14.1, Docker client 29.7.2, and 12 logical processors on an Intel Core i5-11400H.

Measured Docker check. `docker info` returned 1.

```text
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.
```

Measured fixture branches. The nested repository remains on `main`. Its branches are `main`, `tamper-test`, `fix-honest`, `cheat-assertion`, `cheat-special-case`, `cheat-config`, `cheat-package`, and `fix-with-test-tamper`.

Measured frozen commit. `a3b6ead29f4e367d1871e753b516cc9e832871e4`.

Measured honest commit. `5cccb66515313caed72e4af329a62fc011139426`.

Measured materialization. `setup.mjs` reads Git blobs without checking out branches. It writes five committed trees and three synthetic attack trees under this scratch directory. No existing fixture files change.

Measured case model. The judge owns `manifest.json`, whose cases have `{ id, suite, name, target, args, expected }`. All calls target `src/money.ts` and `formatTotal`. Frozen IDs are `frozen:1` through `frozen:48`. Hidden IDs are `hidden:1` through `hidden:6`.

Measured frozen-case conversion. The setup script extracts the 48 literal calls and expected strings from the frozen `tests/totals.test.ts`. This prototype executes their equivalent data cases, not the original Vitest runner. The extraction refuses a count other than 48. No submitted tests, configuration, npm scripts, or dependencies execute.

Measured hidden cases. Their expected strings are literal judge data.

| ID | Arguments | Expected |
| --- | --- | --- |
| `hidden:1` | `[{ amount: 1.234 }], "KWD"` | `"1.234"` |
| `hidden:2` | `[{ amount: 2.345 }], "BHD"` | `"2.345"` |
| `hidden:3` | `[{ amount: 7.891 }], "OMR"` | `"7.891"` |
| `hidden:4` | `[{ amount: 4.567 }], "JOD"` | `"4.567"` |
| `hidden:5` | `[{ amount: 10 }, { amount: 0.625 }], "KWD"` | `"10.625"` |
| `hidden:6` | `[{ amount: 10.125 }], "JPY"` | `"10"` |

Measured call protocol. Only `{ id, target, args }` crosses stdin. Inspection of the final matrix's 1,296 transmitted calls found zero `expected` fields. The manifest is outside every submitted tree and outside both Docker mount directories. A can still read it through the host filesystem if submitted code tries.

Measured subject behavior. The trusted bootstrap captures `JSON.parse`, `JSON.stringify`, and stdout writing before importing source. It imports the target, calls its export, and returns `{ id, ok: true, value }` or `{ id, ok: false, error }`. It holds no assertion or expected value.

Measured launcher A. Plain Node child with stdin/stdout JSON lines and a reduced environment. Platform API keys and the repository `.env` are not copied into its environment. Its inherited host identity still has filesystem and network access.

Implemented but unproven launcher B. `docker run --rm --network none -i` mounts the submitted tree at `/tree` and the subject-only runner directory at `/runner`, both read-only. It also requests a read-only root filesystem, UID 65534, no capabilities, no new privileges, a 256 MiB memory limit, one CPU, and a 64-process limit. It defaults to `node:24-bookworm-slim` with `--pull=never`. `VERIFIER_NODE_IMAGE` can name an already available image. No image was pulled.

Measured screening. All changes outside `src/` reject. This is a deliberately stricter source-only policy than the original protected-path list and includes the runner config. A conservative lexical source screen rejects quoted `vitest`, `expect`, or `node:test` module names and imported `expect` bindings. It does not claim to parse every JavaScript import form.

Implemented bounds. Frames are at most 8,192 bytes. Stdout is at most 262,144 bytes. Stderr is at most 65,536 bytes. The subject deadline is 10 seconds. Successful reply values must be finite JSON data with at most 32 levels of nesting. Error strings are at most 1,024 characters.

Measured parser behavior for the exercised attack. Duplicate IDs remove previously accepted replies and remain invalid even if another reply follows. Unknown IDs, bad schemas, unparsable JSON, unterminated lines, oversized output, nonzero exits, and timeouts reject the run. Those other failure paths are implemented but not individually exercised here.

## Result matrix

Measured A results. Each cell ran once as warm-up and three times as a measured trial. All four verdicts for each tree agree.

Unproven B results. Every B cell is unavailable because the daemon is down. These are not fabricated REJECTED or VERIFIED results.

| Tree | A | B |
| --- | --- | --- |
| `main` | REJECTED. Frozen 47/48 and hidden 0/6. All 54 completed. | Unavailable. Daemon down. |
| `fix-honest` | VERIFIED. Frozen 48/48 and hidden 6/6. All 54 completed. | Unavailable. Daemon down. |
| `tamper-test` | REJECTED. Protected `tests/totals.test.ts` changed. No subject starts. | Unavailable. Daemon down. |
| `cheat-assertion` | REJECTED. Source imports Vitest. No subject starts. | Unavailable. Daemon down. |
| `cheat-special-case` | REJECTED. Frozen 48/48 and hidden 0/6. All 54 completed. | Unavailable. Daemon down. |
| `cheat-rpc-forged` | REJECTED. 108 frames duplicate all 54 IDs. All 54 become missing. | Unavailable. Daemon down. |
| `cheat-rpc-json` | REJECTED. Captured serializer survives the global JSON patch. Frozen 47/48 and hidden 0/6. All 54 completed. | Unavailable. Daemon down. |
| `cheat-local-matcher` | REJECTED. Local matcher replacement cannot affect the judge. Frozen 47/48 and hidden 0/6. All 54 completed. | Unavailable. Daemon down. |

Measured attack construction. The forged-reply and JSON attacks deliberately know this fixture's expected values. They test transport integrity independently of whether a secret can be guessed. The local-matcher attack defines a source-local matcher and extends `toBe` to return `pass: true`; it does not import or replace the real Vitest installation.

## Exact output lines

Measured output from the final matrix. B lines describe the execution gap rather than a verdict.

```text
A main REJECTED | TESTS_FAILED frozen frozen:48; TESTS_FAILED hidden hidden:1,hidden:2,hidden:3,hidden:4,hidden:5,hidden:6
B main UNAVAILABLE | Docker daemon down; subject not executed
A fix-honest VERIFIED | all 54 required IDs completed and passed; frozen 48/48; hidden 6/6; protected paths clean
B fix-honest UNAVAILABLE | Docker daemon down; subject not executed
A tamper-test REJECTED | PROTECTED_PATH_MODIFIED tests/totals.test.ts
B tamper-test UNAVAILABLE | Docker daemon down; subject not executed
A cheat-assertion REJECTED | TEST_FRAMEWORK_IN_SOURCE src/money.ts vitest
B cheat-assertion UNAVAILABLE | Docker daemon down; subject not executed
A cheat-special-case REJECTED | TESTS_FAILED hidden hidden:1,hidden:2,hidden:3,hidden:4,hidden:5,hidden:6
B cheat-special-case UNAVAILABLE | Docker daemon down; subject not executed
A cheat-rpc-forged REJECTED | DUPLICATE_ID; TESTS_MISSING frozen 48; TESTS_MISSING hidden 6
B cheat-rpc-forged UNAVAILABLE | Docker daemon down; subject not executed
A cheat-rpc-json REJECTED | TESTS_FAILED frozen frozen:48; TESTS_FAILED hidden hidden:1,hidden:2,hidden:3,hidden:4,hidden:5,hidden:6
B cheat-rpc-json UNAVAILABLE | Docker daemon down; subject not executed
A cheat-local-matcher REJECTED | TESTS_FAILED frozen frozen:48; TESTS_FAILED hidden hidden:1,hidden:2,hidden:3,hidden:4,hidden:5,hidden:6
B cheat-local-matcher UNAVAILABLE | Docker daemon down; subject not executed
```

## Timing baseline

Measured end-to-end wall time. The outer script times launching a fresh judge through its exit, including judge startup, manifest reading, screening, subject startup where allowed, all RPC and comparisons, evidence writes, and process teardown. Tree generation, Docker availability probing in the outer script, and the profiling run are excluded. Each reported median uses exactly three runs after one warm-up, as requested.

Measured load. Windows CPU utilization was 80% immediately before the final matrix and 49% immediately after. An earlier profile check showed 68%. Other Factory, Droid, and Edge processes were running. They were not stopped. Trials cycle through the trees to distribute drift.

| Tree | A median, ms | A range, ms | A work | B median, ms |
| --- | ---: | ---: | --- | --- |
| `main` | 644.414 | 539.003 to 677.349 | 54 completed, 47 passed | Unavailable |
| `fix-honest` | 622.939 | 584.945 to 641.999 | 54 completed, 54 passed | Unavailable |
| `tamper-test` | 234.508 | 201.924 to 360.224 | Screen only | Unavailable |
| `cheat-assertion` | 196.395 | 154.864 to 208.550 | Screen only | Unavailable |
| `cheat-special-case` | 388.194 | 344.818 to 400.265 | 54 completed, 48 passed | Unavailable |
| `cheat-rpc-forged` | 360.962 | 268.633 to 595.601 | 108 frames, zero valid IDs | Unavailable |
| `cheat-rpc-json` | 450.191 | 364.733 to 1048.862 | 54 completed, 47 passed | Unavailable |
| `cheat-local-matcher` | 675.155 | 381.929 to 757.919 | 54 completed, 47 passed | Unavailable |

| Docker condition | Wall time |
| --- | --- |
| First container launch with a locally available image | Unavailable. Daemon down. |
| Subsequent launches after warm-up | Unavailable. Daemon down. |
| Cold image acquisition or daemon startup | Not attempted. Neither belongs to the measured runs. |

Measured work check. The final matrix contains 32 A invocations, 1,296 calls, zero leaked expected fields on the wire, and zero subject infrastructure errors. Intentional policy, assertion, and duplicate-frame rejections are separate from infrastructure failures. Three measured samples per tree, not five, follow the caller's requested baseline.

Measured honest breakdown. The median subject lifetime is 386.473 ms and the median time to its first reply is 326.244 ms. Every run starts a new Node process and imports TypeScript anew; warm-up does not reuse a subject process.

Measured profile, excluded from the table. An honest run samples 36.318 ms in `decimalsFor`, 19.197 ms in Node's Amaro loader, and 14.816 ms in `compileForInternalLoader`. Another 59.568 ms has the V8 `(program)` frame. The profile is retained under `runs/1791214615782-14604-A-fix-honest/`.

Inferred limiter. Fresh process startup, TypeScript loading, first-use currency formatting, and host scheduling dominate this small fixture rather than 54 equality checks. The profile and first-reply measurements support that interpretation but do not cleanly separate scheduling from runtime work.

Unproven performance comparison. No A-versus-B speed claim is possible. These noisy local numbers are a reproducible baseline, not a production latency promise or a benchmark winner.

## Product implication and remaining gaps

Inferred recommendation. Preserve the protocol separation. The judge must own expected values, ID completeness, deep equality, and the final report. No submitted test runner or matcher should supply the authoritative pass bit.

Measured required correction to the proposed parser rule. Do not retain the first reply and drop later duplicates. The measured attack would pass 54/54 under that rule. Permanently invalidate duplicated required IDs and fail the run.

Inferred RPC requirements. Refuse unknown IDs, duplicate IDs, missing IDs, wrong field sets, malformed or unterminated frames, non-finite JSON values, excessive nesting, excessive bytes, nonzero exits, and timeouts. Keep logs off the result channel. Consume the complete stream and wait for clean process termination before issuing VERIFIED. A complete set of replies cannot excuse a later duplicate or malformed frame.

Measured JSON defense. Capturing parser, serializer, and writer functions before source import defeats the tested global `JSON.stringify` replacement. Unproven stronger attacks include mutable prototypes, `toJSON` hooks, stream internals, forged full transcripts followed by an early exit, and runtime-specific escape techniques. Capturing three functions is not a sandbox.

Inferred containment requirement. A plain same-user child can read judge files, repository secrets, or write host artifacts. B must mount only the submitted tree and the subject runner. Never mount the judge manifest, reports, host credentials, Docker socket, or repository `.env`. Pin the runtime image by digest for the actual implementation.

Unproven production questions. Docker launch cleanup after timeout, resource-bound enforcement, syscall policy, hostile imports, filesystem path and symlink tricks, commit-to-artifact binding, and static-screen bypasses remain open. The prototype's source screen is lexical and its trees are fixture snapshots, not authenticated merge artifacts.

Inferred limit of the decision. This settles exported pure-function assertions for this invoice fixture. It does not prove that every job can express its hidden tests as exported functions, CLI invocations, or HTTP calls. A hostile subject can always fabricate output for cases it knows, and finite hidden cases cannot prove honest general behavior.

Required follow-up. Rerun B's matrix and cold-versus-warm measurements when the daemon is available and an appropriate Node image is cached. Do not count B as measured until those runs exist. Implement production work under Feature, with hostile-subject review and report authentication.

## Artifacts and commands

Measured artifacts, all under `D:\dev\Apps\unnamed\scratch\verifier-judge\`.

- `setup.mjs` materializes the committed branch snapshots and attack trees and generates the judge manifest.
- `judge.mjs` screens source, selects A or B, validates replies, and compares all 54 cases.
- `runner\subject.mjs` imports submitted source and returns raw values.
- `run-matrix.mjs` records warm-up and three measured trials per tree, or explicit B unavailability.
- `inspect.mjs` checks recorded call shapes, evaluates the unsafe first-reply-wins rule against the real attack transcript, and summarizes the separate CPU profile.
- `manifest.json`, `matrix.json`, `timings.tsv`, `raw-outputs.txt`, and `inspection.json` retain inputs and observed results.
- `docker-info.txt` and `system-evidence.txt` retain availability and machine-load evidence.
- `trees\` holds only submitted snapshots. `runs\` retains call transcripts, stdout, stderr, and per-run results.

Commands run on the artifact:

```powershell
node 'D:\dev\Apps\unnamed\scratch\verifier-judge\setup.mjs'
node 'D:\dev\Apps\unnamed\scratch\verifier-judge\run-matrix.mjs'
node 'D:\dev\Apps\unnamed\scratch\verifier-judge\judge.mjs' A fix-honest --profile
node 'D:\dev\Apps\unnamed\scratch\verifier-judge\inspect.mjs'
```

Measured validation. `node --check` passed for all five scripts. The original fixture remains clean on `main`. Parent tracked files have no diff. The parent's untracked `index.html` existed before this work and remains untouched. No commit was created.

Measured report check. All 16 exact output lines and all 24 timing values match the saved artifacts. All four honest runs complete 54 replies and pass 48 frozen plus six hidden cases. No submitted tree contains the judge manifest or a hidden-test directory.

Measured setup correction. The first matrix attempt failed before any verdict because the new `runs\` directory did not exist. The script now creates it. Two subsequent complete matrices succeeded. The timing table uses the final matrix only.

Principles applied. Model the Domain chose judge-owned case records and an ID ledger with permanent invalidation. Boundary Discipline placed schema and byte checks on the RPC. Exhaust the Design Space put both launchers behind one variant argument. Prove It Works required real child execution and retained transcripts. Explain the Number separated screen-only rejection timings from actual 54-case execution, retained ranges, and withheld a Docker performance claim.
