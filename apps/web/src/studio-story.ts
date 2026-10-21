import type { AgPanelConfig, AgViewModePanelType } from "ag-studio";
import type { PlatformJobLedger, ReceiptRow } from "./api-types";
import type { DashboardState } from "./dashboard-widgets.ts";
import { newestReceipt } from "./studio-data.ts";

/** The one line a book with nothing on it says, in place of tiles that read $0.00 alone. */
export const EMPTY_STORY_TEXT = "Run a scenario to see money move";

// The studio's filter panel is only noise on these dashboards, so neither mode shows it. Declaring any
// layout drops Studio's defaults for both modes, so each mode shows only what is declared.
const STUDIO_PANELS: AgPanelConfig = { view: { left: [], right: [] } };
// The public types name the AI panel for edit mode only. The panel service mounts whichever panels a mode lists
// and gates the AI panel on the `ai` setup alone, so view mode lists it too.
const STUDIO_PANELS_WITH_AI: AgPanelConfig = {
  view: { left: [], right: ["ai"] as unknown as AgViewModePanelType[] },
  edit: { right: ["ai"] },
};

/**
 * The panels Studio shows: the Ask the ledger chat panel, on a wide screen of a dashboard that has an agent. The
 * narrow layout stacks the widgets full width, so the chat panel would cover them. The same choice is always the same
 * object, so Studio sees no change between renders.
 */
export function studioPanels(hasAgent: boolean, narrow: boolean): AgPanelConfig {
  return hasAgent && !narrow ? STUDIO_PANELS_WITH_AI : STUDIO_PANELS;
}

/** The operator's receipt widget: it stays off the page until a receipt exists to show. */
export const RECEIPT_WIDGET_ID = "acquit-receipt-card";

/** The escrow book has no job on it yet, so the story shows above the money tiles. */
export function escrowStoryShown(jobs: readonly PlatformJobLedger[]): boolean {
  return jobs.length === 0;
}

/** The operator has a job receipt to show, the same test the receipt card itself applies. */
export function receiptWidgetShown(receipts: readonly ReceiptRow[]): boolean {
  return newestReceipt(receipts) !== null;
}

/** The page with the named widgets taken off it, both their records and their placements. */
export function withoutWidgets(state: DashboardState, ids: readonly string[]): DashboardState {
  const keep = <T>(record: Record<string, T> | undefined) =>
    record && Object.fromEntries(Object.entries(record).filter(([id]) => !ids.includes(id)));
  return {
    ...state,
    pages: state.pages.map((page) => ({ ...page, widgets: keep(page.widgets), widgetLayout: keep(page.widgetLayout) })),
  };
}

/**
 * Studio hands back a state without the hidden widgets, so saving it would drop them. This puts each
 * named widget back as it sits in `full`, the last state the page held, so the hiding never saves over them.
 */
export function withWidgetsFrom(state: DashboardState, full: DashboardState, ids: readonly string[]): DashboardState {
  return {
    ...state,
    pages: state.pages.map((page) => {
      const source = full.pages.find((p) => p.id === page.id);
      if (!source) return page;
      const widgets = { ...page.widgets };
      const widgetLayout = { ...page.widgetLayout };
      for (const id of ids) {
        const widget = source.widgets?.[id];
        if (widget) widgets[id] = widget;
        const track = source.widgetLayout?.[id];
        if (track) widgetLayout[id] = track;
      }
      return { ...page, widgets, widgetLayout };
    }),
  };
}
