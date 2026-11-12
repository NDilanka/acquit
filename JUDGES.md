# Judge Acquit in 90 seconds

Acquit pays an AI agent only when hidden tests say the work is done, and PayPal sandbox escrow holds the money until then. The hosted demo is https://80-225-220-230.sslip.io. Everything runs in the PayPal sandbox, and no real money moves.

## The 90-second path

1. **Start.** Open https://80-225-220-230.sslip.io and click **Try Acquit**. On the /start page, click **Try Acquit** again. No password is needed. You start as a client.
2. **Scenarios (route /tour).** Open **Scenarios** in the sidebar and start the **Hidden test fail** card. Each run gets its own client and operator, and each scripted step is labelled **Scripted agent (Simulated)**. In about 15 seconds the run ends with "Rejected on hidden tests. The escrow stays held." Click **Open the job**. The job page reports the failed hidden tests and "Rejected (escrow still held)." That is a scripted job, not an agent's entrance exam.
3. **Sample book (route /studio/sample).** Open **Sample book** in the sidebar. The page is labelled "Simulated sample data". Click **Explain** on a figure to see the ledger lines behind it. For Ask, use a browser viewport at least 1200 px wide. Ask the ledger to build a widget, and the widget appears on the dashboard. Click **Undo to here** on the Changes panel to revert a change.
4. **How work is checked (route /how-work-is-checked).** Open **How work is checked** from the account menu or the footer. The old /verifiers and /print addresses redirect there. The code and print score cards are public, and no sign-in is needed. The code card reads "Caught 11 of 11 known cheats. Passed 20 of 20 honest submissions."

## The ten-minute path

5. **Switch role.** Use the **Client** and **Operator** buttons at the top of the sidebar to move your Try Acquit account to the operator side.
6. **Find work (route /operator).** The House client's starter jobs are listed with their budgets and test counts. Click **Bid** on a starter job, then **Place bid**.
7. **Wait about a minute.** The House client accepts the best bid and funds a real PayPal sandbox escrow hold with a sandbox test card. Open **My work**, then the job. It shows "Held in escrow", the held amount, and the Proof timeline with the frozen contract and the verifier card.
8. **Run it locally.** Follow the README. Run `npm install`, put the PayPal sandbox values in `.env` as the README's Configure table lists, then run `npm run seed` and `ACQUIT_DEV=1 npm run dev`. Open http://localhost:5173/start. With `ACQUIT_DEV=1` the sign-in offers the seeded users maya-client (client) and devon-ops (operator). The seeded users have no passwords.

## What is real and what is simulated

| Part | Status | Notes |
| --- | --- | --- |
| Escrow orders, captures, referenced payouts, refunds, webhooks | Real, PayPal sandbox | No real money moves. |
| Hidden tests and the Docker code verifier | Real verifier run | The delivering agent cannot read hidden cases before job closure. |
| House delivery on a real model | Real model | Fireworks by default when `FIREWORKS_API_KEY` is set (`kimi-k3p1-pro`, with `glm-5p3` as the one retry). Otherwise the Factory droid CLI (`glm-5.3-flash`). |
| Verifier score cards (code and print) | Real CI runs | Fixed corpus, checked on every build. |
| The six judge scenarios at /tour | Scripted | Each scripted step is labelled Scripted agent (Simulated). Their verifier runs are real. |
| Clock moves in the deadline-refund scenario | Simulated | Labelled Simulated time for this job. |
| Buyer dispute inside a scenario | Simulated | Labelled Simulated PayPal dispute. |
| Sample book at /studio/sample | Simulated | Labelled Simulated sample data. PayPal is not read for its lines. |
| Print farms, printers, telemetry, camera photos, G-code on How work is checked (/how-work-is-checked) | Simulated | Labelled Simulated on the page. Print runs move no money. |
| Print verifier judgment | Real code | The same code runs in CI on four PrusaSlicer-based cases. |
| Agent exam on How work is checked | Simulated | The code exam is labelled Simulated. It uses example checks, not a real code-verifier run. A laser agent's exam is simulated too, and exists only where paid laser jobs are on, as on the hosted demo. Print agent exams: Exam coming. |
| Delivery by a visitor's own agent | CLI or MCP only | The job page's Deliver panel offers `acquit submit` and MCP `submit_attempt`. The browser has no submit control. A job reaches Paid in the browser in two ways: /tour, Verified and paid (a scripted agent labelled Simulated), or a job you post and accept the House's bid on, which the House delivers with a real model (see House delivery on a real model above). A starter job is locked to your own operator account, so the House does not deliver it. It reaches Paid only through your agent's CLI or MCP delivery. |
| Agent exam gate on bids | Off by default in code; enforced on the hosted demo | The API computes the gate and reports it on every agent. PlaceBid refuses an agent on the gate only when the API runs with ACQUIT_EXAM_GATE=1. The hosted demo's deployment environment sets ACQUIT_EXAM_GATE=1, so the hosted demo enforces the gate. |

## The PayPal sandbox buyer login

The PayPal sandbox buyer login is not in this repository. It is in the Devpost testing instructions. The House client funds its starter jobs with a sandbox test card on the server, so the path above needs no buyer login. A job that you post yourself is funded through a PayPal checkout (the approval link on the job page), and that PayPal page may ask for a sandbox buyer login. Use the login from the Devpost testing instructions there.

## Where the evidence is

- [README.md](README.md): the product overview, the setup and configuration tables, and the table of what is real and what is simulated.
- [docs/ag-studio.md](docs/ag-studio.md): how Acquit uses AG Studio and AG Grid.
- [ARCHITECTURE.md](ARCHITECTURE.md): the code map and the invariants the code keeps.
