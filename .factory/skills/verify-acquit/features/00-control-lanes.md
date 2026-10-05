# Isolate verification lanes and control development time

Each lane owns its ports, database, process record, and headless browser. Start only slots that pass preflight.

## Drive

1. Set `ACQUIT_LANE=1` and start through the skill's Launch recipe. Repeat for lane 2 while lane 1 runs.
2. Run feature 04 in both slots. Require different job ids, database paths, and the same stored quote. Save `two-lanes-checkout.png`.
3. In a lane 3 browser, send a development control request to lane 4. Require 403 for lane 3's origin. Repeat from lane 4 and require success. Save `cross-origin-refused.png`.
4. Put an unrelated live PID in a lane run file with a deliberately different start time. Run `ctl stop`. Require `PID_MISMATCH` and a live unrelated process. Save `pid-guard.png`. Restore the original ownership record before cleanup.
5. In checkout mode, run feature 04, leave payment unpaid, and run `ctl clock advance 4h` with `ACQUIT_DEV=1`. Open the job page. Require OPEN, bidding controls, and Devon credits still at 20. Save `checkout-expired.png`.
6. Start without `ACQUIT_DEV=1`. Require the clock route and `ctl fund-mode card` to refuse the command with a configuration hint. Restart with the flag, select card mode, and run feature 04 with `ACQUIT_FUND_MODE=card`. Require HELD, Devon locked, and 42000 ledger cents without buyer login. Save `card-held.png`.
7. Run `fund-escrow.mjs approve` only when `SANDBOX_BUYER_PASSWORD` is set. Otherwise report BLOCKED with that reason.
8. Run Cleanup for every owned slot, even after failure. Keep screenshots and sanitized read-only query results.

## Automatic waves

Run `lanes.mjs start 10`, `doctor`, and `cleanup`. Require the printed memory measurement, cap, and a healthy row for every started lane. A zero cap means memory is insufficient and the live wave remains BLOCKED. `cleanup <n>` must preserve other owned slots.
