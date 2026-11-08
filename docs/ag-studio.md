# How Acquit uses AG Studio and AG Grid

This page is for the AG Grid judge. It says where each part lives in the repository. Paths are relative to the repository root. The AG Studio license key is read from `VITE_AG_STUDIO_LICENSE_KEY` (see the README's Configure table).

Simulated figures are labelled on the page. The sample book is labelled "Simulated sample data", and the platform escrow book is covered by the staff platform key, so judges see its screenshot rather than a live view.

## Where the two libraries appear

- **AG Grid tables.** `apps/web/src/grid.tsx` registers AG Grid's community module (line 4) and defines the table theme (lines 7 to 29). The verdict grid, the Changes list, and the other tables use it.
- **AG Studio dashboards.** `apps/web/src/studio/StudioPage.tsx` renders `AgStudio` from `ag-studio-react` (line 12). There are three dashboards. `/studio` shows the escrow dashboard to the platform and the earnings dashboard to an operator, chosen by role (`StudioPage.tsx` lines 74 to 78; route `/studio` at `apps/web/src/route.ts` line 32). The sample book is on `/studio/sample` (route.ts line 33).

## Custom widgets

- **Widget definitions.** `apps/web/src/dashboard-widgets.ts` lists each widget's id, label, size, and the description the agents read (type `WidgetAi` at line 9, the rows at line 26). The Changes widget's entry is at lines 160 to 166.
- **Widget components.** `apps/web/src/studio/dashboards.tsx` maps each widget id to a React component (the map ends at line 644, with `acquit-verdict-grid` at line 636 and `acquit-changes` at line 643). `buildRegistry` (lines 695 to 709) passes those components to `createWidgets` from `ag-studio-react`.
- **Isolation.** Each widget is wrapped in `WidgetBoundary` (lines 670 to 680). A widget that throws shows its own fallback text and leaves the rest of the page up.
- **Stat tiles.** Tiles such as Held escrow and the reject rate are built by `stat` (`apps/web/src/studio/dashboards.tsx` line 62), which takes a data hook and a function that returns the tile's value and note. The widget table near lines 630 to 641 lists them.

## Theming

- **AG Grid.** `acquitTheme` in `apps/web/src/grid.tsx` (lines 7 to 29) is a `themeQuartz` theme whose parameters are CSS custom properties, for example `var(--ink)`, `var(--card)`, and `var(--green)`. AG Grid therefore draws with the app's own palette.
- **AG Studio.** `acquitStudioTheme` in `apps/web/src/studio/StudioPage.tsx` (lines 517 to 541) reads the app's CSS variables and passes them to Studio's theme with `studioTheme.withParams`. The theme is computed again on each Dark / Light change (lines 564 to 565, through `useTheme` in `apps/web/src/theme-context.tsx`).
- **Dark palette.** `apps/web/src/styles.css` line 19 defines the dark roles under `:root[data-theme="dark"]`.

## The verdict grid

`VerdictTimeline` in `apps/web/src/studio/dashboards.tsx` (lines 479 to 511) is an AG Grid of the escrow book. Each job is a row; a job opens to its verifier attempts, and a tile too narrow for a table shows the same rows as cards (line 490). The pinned bottom row shows the conservation law in four figures, and it reads "Ledger conserves" when payout plus fee equals paid (`TotalsStrip`, lines 371 to 377; `LedgerConserves`, lines 74 to 81). The sums come from `apps/web/src/studio-data.ts`.

## Live updates from PayPal webhooks, without a remount

1. A PayPal webhook is verified, then applied by `packages/core/src/effects.ts` (`ingestPayPalWebhook`, lines 882 to 893). Each applied fact is a store commit.
2. `apps/api/src/platform-stream.ts` is configured to check the store every 500 ms (`POLL_MS`, line 10). When it detects a commit it sends one `changed` event on `GET /api/platform/stream` (`apps/api/src/server.ts` lines 928 to 934). The event carries no data.
3. The escrow page in `apps/web/src/studio/StudioPage.tsx` opens an `EventSource` on that stream (line 131) and reads its platform routes again on each event. The escrow source is a module-level function of the book (line 103), so Studio updates the widgets in place.
4. PayPal settles some lines with no local write, so the stream never announces them. The reconciliation card reads again every three minutes (`RECONCILE_REFRESH_MS`, line 109).
5. The new book reaches Studio as a fresh `data` prop, which Studio applies through `engine.update` (`apps/web/src/studio-update.test.ts` line 5). Source ids stay stable, so nothing remounts (README.md, "Live Studio updates").

If the browser gives up on the stream, the page falls back to a 30-second poll and shows "Live updates off" (README.md).

## The Studio agent framework

- **The ledger agent.** `ASK_AGENT_NAME` is "Ask the ledger" (`apps/web/src/ask-ledger.ts` line 26). Its tools are read-only: the platform's closed set is served by `GET /api/ask-ledger/tools` (`apps/api/src/server.ts` lines 936 to 942).
- **The harness.** `createAskLedgerHarness` in `apps/web/src/ask-harness.ts` (lines 269 to 324) builds the dashboard's agents. The ledger agent is the primary agent. It holds the ledger reads and a `delegate_to` tool for Studio's three built-in agents: widget, data, and page (line 291). The widget agent's `add_widget` goes through a dashboard guard, `dashboardAdd` (lines 298 and 313 to 315), and the data agent is Studio's own (line 307).
- **The change log.** The harness's observers include `changes.observer` (line 321), so each agent edit lands in the change chain below.
- **One harness per Studio instance.** `useAskLedger` in `apps/web/src/studio/AskLedger.tsx` (lines 55 to 83) builds it once for each Studio instance.
- **The model routes.** Platform and operator turns use `POST /api/ask-ledger/turn`; sample turns use `POST /api/sample/ask/turn` (`apps/api/src/server.ts`). They use the same configured model/provider. The server relays delegate tool schemas, but server-side tool execution stays restricted to the caller's scope. Studio delegation edits the dashboard, not PayPal payment state.
- **Operators.** An operator's harness is the ledger agent alone, with four read tools and no delegation (`createOperatorAskLedgerHarness`, `apps/web/src/ask-harness.ts` lines 331 to 354).
- **The sample book.** At a browser viewport width of at least 1200 px, `/studio/sample` mounts `useAskLedger("sample", "SAMPLE")` (`apps/web/src/studio/StudioPage.tsx` lines 69 and 294 to 327). Its four read-only data tools are `sample_totals`, `list_sample_jobs`, `get_sample_job`, and `explain_sample_figure` (`apps/api/src/sample-ask.ts`). They read only seeded sample data. The same harness delegates to Studio's built-in widget, data, and page agents, and edits enter the undoable change chain. Below 1200 px the sample dashboard remains available without its Ask panel.

## Explain this number

The Held escrow, Released, Refunded, and Fees money tiles have an **Explain** button (`apps/web/src/studio/dashboards.tsx`, `escrowTotal` at lines 269 to 280). The button opens the figure's ledger lines in a dialog, and the dialog reads them from the server each time it opens (`FigureExplain`, `apps/web/src/studio/FigureExplain.tsx` lines 87 to 95).

- The platform figures come from `GET /api/platform/explain` (`apps/api/src/server.ts` line 919). The sample figures come from `GET /api/sample/explain` (line 820).
- The trace is deterministic. It sums the same ledger rows that make up the figure, and no model is called (`apps/api/src/figure-trace.ts` lines 1 to 3).
- The PayPal status on each line comes from the reconciliation rows, not from a live PayPal read (same file, lines 1 to 3).
- On the sample book the dialog says "Simulated sample data from the sample book. PayPal was not read for these lines." (`FigureExplain.tsx` line 139).

## The undoable change chain

`apps/web/src/change-chain.ts` (lines 1 to 4) keeps a record of the edits made to a dashboard, by the assistant or by the user. Each link carries the hash of the link before it, so an edited, dropped, or reordered link breaks the chain. The chain lives in the browser for the session, and no server reads it.

The Changes widget (`ChangesWidget`, `apps/web/src/studio/dashboards.tsx` lines 615 to 618) lists each change, newest first, with an **Undo to here** button on each change still on the undo stack (`UndoCell`, lines 549 to 553). An undo does not rewrite history. It appends an undo link (`change-chain.ts`, the undo function's comment near line 253).

## The sample book

`/studio/sample` (`apps/web/src/studio/StudioPage.tsx` lines 294 to 327) shows one seeded set of escrow jobs that every signed-in account sees the same way. The page is labelled "Simulated sample data" in its lead text (line 314). Ask is shown at viewport widths of at least 1200 px.

- The sample book and Explain use `GET /api/sample/book` and `GET /api/sample/explain`. Ask also uses `GET /api/sample/ask/tools`, `POST /api/sample/ask/turn`, and `POST /api/sample/ask/tool` (`apps/api/src/server.ts` lines 815 to 884). The four sample data tools read the frozen book from `apps/api/src/sample-book.ts`, not real account rows or PayPal objects. The model turn still uses the configured model provider.
- Its PayPal references are seeded and labelled. `SAMPLE_PAYPAL_NOTE` (`sample-book.ts` line 9) says that no PayPal call is made for sample rows.
- Its Changes widget is described for the sample dashboard (`apps/web/src/dashboard-widgets.ts` line 291).

## Limits

- The platform escrow book shows every tenant's jobs and needs the staff platform key (`ACQUIT_PLATFORM_KEY`, README.md). The screenshot in the submission shows that view.
- The sample book is the view a judge can open without that key.
