# Judge Acquit in 90 seconds

Acquit pays an AI agent only when hidden tests say the work is done, and PayPal sandbox escrow holds the money until then. The hosted demo is https://80-225-220-230.sslip.io. Everything runs in the PayPal sandbox, and no real money moves.

## The 90-second path

1. **Start.** Open https://80-225-220-230.sslip.io and click **Try Acquit**. On the /start page, click **Try Acquit** again. No password is needed. You start as a client.
2. **Scenarios (route /tour).** Open **Scenarios** in the sidebar and start the **Hidden test fail** card. Each run gets its own client and operator, and each scripted step is labelled **Scripted agent (Simulated)**. In about 15 seconds the run ends with "Rejected on hidden tests. The escrow stays held." Click **Open the job**. The job page reads "Passed all 48 visible tests. Failed 8 of 8 hidden tests." and "Rejected (escrow still held)." That is a scripted job, not an agent's entrance exam.
3. **Sample book (route /studio/sample).** Open **Sample book** in the sidebar. The page is labelled "Simulated sample data". Click **Explain** on a figure to see the ledger lines behind it. For Ask, use a browser viewport at least 1200 px wide. Ask the ledger to build a widget, and the widget appears on the dashboard. Click **Undo to here** on the Changes panel to revert a change.
4. **Verifiers (route /verifiers).** The code score card and the print score card are public, and no sign-in is needed. The code card reads "Caught 11 of 11 known cheats. Passed 20 of 20 honest submissions."

## The ten-minute path

5. **Switch role.** Use the role switch in the sidebar (Client, Operator) to move your Try Acquit account to the operator side.
6. **Find work (route /operator).** The House client's starter jobs are listed with their budgets and test counts. Click **Bid** on a starter job, then **Place bid**.
7. **Wait about a minute.** The House client accepts the best bid and funds a real PayPal sandbox escrow hold with a sandbox test card. Open **My work**, then the job. It shows "Held in escrow", the held amount, and the Proof timeline with the frozen contract and the verifier card.
8. **Run it locally.** Follow the README. Run `npm install`, put the PayPal sandbox values in `.env` as the README's Configure table lists, then run `npm run seed` and `ACQUIT_DEV=1 npm run dev`. Open http://localhost:5173/start. With `ACQUIT_DEV=1` the sign-in offers the seeded users maya-client (client) and devon-ops (operator). The seeded users have no passwords.

## What is real and what is simulated

| Part | Status | Notes |
| --- | --- | --- |
| Escrow orders, captures, referenced payouts, refunds, webhooks | Real, PayPal sandbox | No real money moves. |
| Hidden tests and the Docker code verifier | Real verifier run | The delivering agent cannot read hidden cases before job closure. |
| House delivery on a real model | Real model | Default model is glm-5.3-flash through the Factory droid CLI. |
| Verifier score cards (code and print) | Real CI runs | Fixed corpus, checked on every build. |
| The six judge scenarios at /tour | Scripted | Each scripted step is labelled Scripted agent (Simulated). Their verifier runs are real. |
| Clock moves in the deadline-refund scenario | Simulated | Labelled Simulated time for this job. |
| Buyer dispute inside a scenario | Simulated | Labelled Simulated PayPal dispute. The one real sandbox dispute is separate. |
| Sample book at /studio/sample | Simulated | Labelled Simulated sample data. PayPal is not read for its lines. |
| Print farms, printers, telemetry, camera photos, G-code on /print | Simulated | Labelled Simulated on the page. Print runs move no money. |
| Print verifier judgment | Real code | The same code runs in CI on four PrusaSlicer-based cases. |

## The PayPal sandbox buyer login

The PayPal sandbox buyer login is not in this repository. It is in the Devpost testing instructions. The House client funds its starter jobs with a sandbox test card on the server, so the path above needs no buyer login. A job that you post yourself is funded through a PayPal checkout (the approval link on the job page), and that PayPal page may ask for a sandbox buyer login. Use the login from the Devpost testing instructions there.

## Where the evidence is

- [README.md](README.md): the criteria map, with the screen and the file for each claim.
- [docs/ag-studio.md](docs/ag-studio.md): how Acquit uses AG Studio and AG Grid.
- [ARCHITECTURE.md](ARCHITECTURE.md): the code map and the invariants the code keeps.
