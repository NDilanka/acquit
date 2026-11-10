import type { MorningReport } from "./types.ts";

const DAY = 86_400_000;
export const REPORT_WINDOW_RULE = "With work: the 24 hours ending at the latest recorded event. Otherwise: the 24 hours ending at the first check of this UTC day. Opening the report does not move its window.";

/** A quiet day's anchor is shared by all views, not advanced whenever Earnings is read. */
export function quietReportEnd(store: Pick<Storage,"getItem"|"setItem">, owner: string, now: string): string {
  const key = `acquit.reportWindow:${owner}:${now.slice(0,10)}`;
  try {
    const previous = store.getItem(key);
    if (previous && Number.isFinite(Date.parse(previous)) && previous.slice(0,10) === now.slice(0,10) && Date.parse(previous) <= Date.parse(now)) return previous;
    store.setItem(key,now);
  } catch { /* The current mount remains stable when storage is unavailable. */ }
  return now;
}

/** Work, never a page view, sets the report's end. Every included row uses its stored timestamp. */
export function windowedReport(raw: MorningReport, quietThrough: string) {
  const dates = [...raw.bids,...raw.wins,...raw.verified,...raw.rejected,...raw.payouts,...raw.gradeChanges,...raw.preApprovals]
    .map(row => Date.parse(row.at)).filter(Number.isFinite);
  const end = dates.length ? dates.reduce((latest,at) => Math.max(latest,at),-Infinity) : Date.parse(quietThrough);
  const since = new Date(end - DAY).toISOString();
  const through = new Date(end).toISOString();
  const inWindow = (row: { at: string }) => Date.parse(row.at) >= end - DAY && Date.parse(row.at) <= end;
  const data: MorningReport = { ...raw,since,bids:raw.bids.filter(inWindow),wins:raw.wins.filter(inWindow),
    verified:raw.verified.filter(inWindow),rejected:raw.rejected.filter(inWindow),payouts:raw.payouts.filter(inWindow),
    gradeChanges:raw.gradeChanges.filter(inWindow),preApprovals:raw.preApprovals.filter(inWindow) };
  return { data,through };
}
