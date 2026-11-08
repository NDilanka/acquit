# Operations

This page covers how the hosted demo at https://80-225-220-230.sslip.io is watched during judging.

## What is checked

`.github/workflows/uptime.yml` runs `scripts/uptime-check.mjs` every 30 minutes and on manual dispatch. GitHub can start a scheduled run late. The script sends GET requests to:

- `/`, `/tour`, `/verifiers`, and `/print`. Each must return 200 and the app shell (`<div id="root"` and `<title>Acquit</title>`). Every page route is served the same shell, so this confirms the web build is served; it does not check a page's content.
- `/api/session`. It must return 200 and JSON whose `mode` is `public` or `dev`.

Each request times out after 15 seconds, and the job after 5 minutes. The script uses Node's built-in `fetch`, so it needs no dependency and no secret, and it makes no request that writes state. The workflow has `permissions: contents: read`, runs only on schedule and manual dispatch, and never runs on push or pull request, so it cannot block CI or a deploy.

The uptime check does not exercise the model provider or the PayPal sandbox. The weekly check below covers the escrow path.

## How a failure alerts

Any miss prints a `FAIL` line, adds an error annotation, and exits 1, which fails the run. A failed run shows red on the Actions tab. GitHub emails failed-run notifications for scheduled workflows to the user who last changed the cron line in the workflow file. Scheduled workflows run only from the default branch. GitHub also pauses scheduled workflows in a public repository after 60 days without repository activity, which is one reason the weekly check exists.

## Weekly manual check

Once a week until judging ends, run `node scripts/uptime-check.mjs` from a checkout. Then open `/tour` in a browser and run the `verified-and-paid` scenario. It should end PAID, and every amount shown must be sandbox money.

## Scenarios are not scheduled

A judge scenario, like Try Acquit, creates a visitor whose repository fork the GitHub App makes on GitHub. A daily scenario run would therefore write a new repository to GitHub every day, and the sweep removes those only later. The scheduled job checks public routes only.

## After submission

Submission closes on 2026-11-12, with a hard stop at 09:00 PT. From then until 2026-12-21 no commits are made to this repository; only restarts of the submitted build happen. The uptime workflow makes no commits, so it keeps running through that period.
