import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PlatformAttempt, PlatformJobLedger } from "./api-types.ts";
import { escrowTotals } from "./studio-data.ts";
import {
  VERDICT_MIN_WIDTHS,
  attemptWords,
  cardRows,
  fundedConserves,
  groupWords,
  jobCard,
  lastAttempt,
  payPalIds,
  platformStatusWord,
  sparkCoords,
  sparkPoints,
  toggleExpanded,
  totalsRow,
  verdictRows,
  type GroupRow,
} from "./verdict-grid.ts";

const AT = "2026-10-13T12:00:00.000Z";
const LATER = "2026-10-13T15:00:00.000Z";

function job(over: Pick<PlatformJobLedger, "jobId" | "escrow"> & Partial<PlatformJobLedger>): PlatformJobLedger {
  return { title: `Fix ${over.jobId}`, tenant: null, client: "maya-client", status: "OPEN", operator: null, lines: [], paidCents: null,
    capture: null, fee: null, payout: null, receipt: null, attempts: [], ...over };
}

function attempt(ordinal: number, over: Partial<PlatformAttempt> = {}): PlatformAttempt {
  return { ordinal, result: "VERIFIED", at: AT, tamper: false, reasons: [], frozen: { expected: 48, passed: 48 },
    hidden: { expected: 6, passed: 6 }, ...over };
}

// The same book the core platform test settles: paid 420.00, held 378.00, a 421.00 capture held, refunded 420.00, and a job with no money yet.
const PAID = job({ jobId: "job_paid", title: "Paid job", escrow: "RELEASED", status: "PAID",
  operator: { id: "devon-ops", handle: "devon-ops" },
  lines: [{ kind: "HELD", cents: 42000, at: AT }, { kind: "RELEASED", cents: 36000, at: LATER },
    { kind: "FEE", cents: 6000, processor: 1515, acquit: 4485, at: LATER }],
  paidCents: 42000, fee: { cents: 6000, processor: 1515, acquit: 4485 },
  payout: { paid: 36000, payoutItemId: "payout-item-1", captureId: "CAP_PAID", releasedAt: LATER, authority: "CLIENT_APPROVAL" },
  receipt: { id: "rcpt_job_paid", paid: 36000, releasedAt: LATER },
  attempts: [attempt(2), attempt(1, { result: "REJECTED", tamper: true, reasons: ["PROTECTED_PATH_MODIFIED"], frozen: null, hidden: null })] });
const HELD = job({ jobId: "job_held", title: "Held job", escrow: "HELD", status: "IN_PROGRESS",
  operator: { id: "beta-ops", handle: "beta" }, lines: [{ kind: "HELD", cents: 37800, at: AT }],
  paidCents: 37800, capture: { orderId: "TESTORDER", captureId: "CAP_HELD", payee: "sandbox-seller", gross: 37800 },
  attempts: [attempt(1, { result: "REJECTED", reasons: ["TESTS_FAILED:hidden"], frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 5 } })] });
const MISMATCH = job({ jobId: "job_mismatch", title: "Mismatch job", escrow: "HELD", status: "OPEN",
  lines: [{ kind: "HELD", cents: 42100, at: AT }], paidCents: 42100,
  capture: { orderId: "ORDER_MISMATCH", captureId: "CAP_MISMATCH", payee: "sandbox-seller", gross: 42100 } });
const REFUNDED = job({ jobId: "job_refunded", title: "Refunded job", escrow: "REFUNDED", status: "REFUNDED",
  lines: [{ kind: "HELD", cents: 42000, at: AT }, { kind: "REFUND", cents: 42000, at: LATER }], paidCents: 42000,
  payout: null });
const OPEN = job({ jobId: "job_open", title: "Open job", escrow: "NONE", status: "OPEN" });
const BOOK: readonly PlatformJobLedger[] = [PAID, HELD, MISMATCH, REFUNDED, OPEN];

test("the book conserves: held, released, refunded, and fees add up to the funded gross, and fundedConserves says so", () => {
  assert.deepEqual(fundedConserves(BOOK), { held: 79900, released: 36000, refunded: 42000, fees: 6000, funded: 163900, holds: true });
});

test("removing a fee line breaks the conservation law, and funded still sums every HELD line", () => {
  const noFee = BOOK.map((j) => (j.jobId === "job_paid" ? { ...j, lines: j.lines.filter((line) => line.kind !== "FEE") } : j));
  assert.deepEqual(fundedConserves(noFee), { held: 79900, released: 36000, refunded: 42000, fees: 0, funded: 163900, holds: false });
});

test("the pinned totals equal the escrow tiles' figures for held, released, refunded, and fees", () => {
  const totals = totalsRow(BOOK);
  assert.equal(totals.kind, "totals");
  assert.deepEqual({ held: totals.held, released: totals.released, refunded: totals.refunded, fees: totals.fees }, escrowTotals(BOOK));
  assert.deepEqual(escrowTotals(BOOK), { held: 79900, released: 36000, refunded: 42000, fees: 6000 });
});

test("the groups read HELD, RELEASED, REFUNDED, NONE, and each header's count equals the jobs beneath it", () => {
  const rows = verdictRows(BOOK, new Set());
  const headers = rows.filter((row): row is GroupRow => row.kind === "group");
  assert.deepEqual(headers.map((header) => header.escrow), ["HELD", "RELEASED", "REFUNDED", "NONE"]);
  assert.deepEqual(headers.map((header) => header.count), [2, 1, 1, 1]);
  for (const header of headers) {
    const start = rows.indexOf(header);
    const next = rows.findIndex((row, i) => i > start && row.kind === "group");
    const beneath = rows.slice(start + 1, next === -1 ? undefined : next);
    assert.equal(beneath.filter((row) => row.kind === "job").length, header.count, `${header.escrow}: the header counts its jobs`);
    assert.ok(beneath.every((row) => row.kind === "job" && row.job.escrow === header.escrow), `${header.escrow}: only its own jobs sit beneath`);
  }
});

test("an empty book still shows all four group headers, each at zero", () => {
  const rows = verdictRows([], new Set());
  assert.deepEqual(rows.map((row) => (row.kind === "group" ? `${row.escrow}:${row.count}` : row.kind)),
    ["HELD:0", "RELEASED:0", "REFUNDED:0", "NONE:0"]);
});

test("expanding a three-attempt job yields its three detail rows right after it, in ordinal order", () => {
  const three = job({ jobId: "job_three", escrow: "HELD", status: "IN_PROGRESS", lines: [{ kind: "HELD", cents: 1000, at: AT }],
    attempts: [attempt(3), attempt(1, { result: "REJECTED", reasons: ["TESTS_FAILED:frozen"], frozen: { expected: 2, passed: 1 }, hidden: null }),
      attempt(2, { result: "REJECTED", reasons: ["TESTS_FAILED:hidden"], hidden: { expected: 6, passed: 4 } })] });
  assert.equal(verdictRows([three], new Set()).filter((row) => row.kind === "attempt").length, 0, "a collapsed job has no detail rows");
  const rows = verdictRows([three], new Set(["job_three"]));
  const at = rows.findIndex((row) => row.kind === "job");
  const details = rows.slice(at + 1, at + 4);
  assert.deepEqual(details.map((row) => (row.kind === "attempt" ? row.attempt.ordinal : -1)), [1, 2, 3]);
  assert.ok(details.every((row) => row.kind === "attempt" && row.jobId === "job_three"));
  assert.equal(rows.length, 4 + 1 + 3, "four group headers, the job, and its three attempts");
});

test("row ids are unique, so a live change to the book updates rows in place", () => {
  const rows = verdictRows(BOOK, new Set(["job_paid", "job_held"]));
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("toggling a job's expansion adds it, then removes it, and never changes the set it was given", () => {
  const collapsed: ReadonlySet<string> = new Set();
  const open = toggleExpanded(collapsed, "job_paid");
  assert.deepEqual([...open], ["job_paid"]);
  assert.equal(collapsed.size, 0, "the given set is untouched");
  assert.deepEqual([...toggleExpanded(open, "job_paid")], []);
});

test("sparkPoints gives each judged attempt's passed share, frozen and hidden together, and skips null tallies", () => {
  assert.deepEqual(sparkPoints([
    { ordinal: 3, frozen: { expected: 2, passed: 2 }, hidden: { expected: 6, passed: 3 } },
    { ordinal: 1, frozen: null, hidden: null },
    { ordinal: 2, frozen: { expected: 2, passed: 1 }, hidden: null },
  ]), [0.5, 0.625]);
});

test("sparkCoords draws a ratio from the bottom to the top, one point mid-width", () => {
  assert.equal(sparkCoords([1, 0], 100, 20), "2,2 98,18");
  assert.equal(sparkCoords([0.5], 100, 20), "50,10");
});

test("the last verdict is the newest attempt by ordinal, and none when there are no attempts", () => {
  assert.equal(lastAttempt([attempt(3), attempt(1)])?.ordinal, 3);
  assert.equal(lastAttempt([]), null);
});

test("an attempt with no counts reads its reasons in words, and one with neither reads that no counts were recorded", () => {
  assert.deepEqual(attemptWords(attempt(1, { result: "REJECTED", reasons: ["TESTS_FAILED:hidden"], frozen: null, hidden: null })),
    { verdict: "Rejected", detail: "Hidden tests failed" });
  assert.deepEqual(attemptWords(attempt(1, { result: "REJECTED", reasons: [], frozen: null, hidden: null })),
    { verdict: "Rejected", detail: "No counts recorded" });
});

test("group and status words come from one table each, and every group has its words", () => {
  assert.equal(groupWords("NONE"), "No escrow yet");
  assert.equal(groupWords("HELD"), "Held in escrow");
  assert.equal(platformStatusWord("PAID"), "Paid");
});

test("the verdict timeline uses only AG Grid Community APIs: no Enterprise module or option appears in its sources", () => {
  const sources = ["./verdict-grid.ts", "./grid.tsx", "./studio/dashboards.tsx"]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  // Whole identifiers only: EscrowGroup contains rowGroup as a substring.
  for (const name of ["masterDetail", "detailCellRenderer", "rowGroup", "groupDisplayType", "agSparklineCellRenderer",
    "SparklinesModule", "RowGroupingModule", "IntegratedCharts", "ag-grid-enterprise"]) {
    assert.equal(new RegExp(`\\b${name}\\b`).test(sources), false, `${name} is an Enterprise API`);
  }
});

test("a narrow card reads the wide row's facts in words: status, escrow, last verdict, passing shares, paid, and PayPal ids", () => {
  assert.deepEqual(jobCard(PAID), {
    jobId: "job_paid", title: "Paid job", tenant: null, status: "Paid", escrow: "Released", lastVerdict: "Verified", passing: [1], paidCents: 42000,
    paypalIds: [{ label: "PayPal capture", id: "CAP_PAID" }, { label: "PayPal payout item", id: "payout-item-1" }],
  });
  const open = jobCard(OPEN);
  assert.deepEqual({ escrow: open.escrow, lastVerdict: open.lastVerdict, passing: open.passing, paidCents: open.paidCents, paypalIds: open.paypalIds },
    { escrow: "Not funded", lastVerdict: "No verdict yet", passing: [], paidCents: null, paypalIds: [] });
  assert.deepEqual(payPalIds(HELD), [{ label: "PayPal capture", id: "CAP_HELD" }]);
});

test("the narrow rows keep the four group headers, one card per job, and an expanded job's attempts right after its card", () => {
  const rows = cardRows(verdictRows(BOOK, new Set(["job_paid"])));
  const labels = rows.map((row) => {
    if (row.kind === "group") return `group:${row.escrow}`;
    if (row.kind === "attempt") return `attempt:${row.attempt.ordinal}`;
    return `card:${row.card.jobId}${row.expanded ? "*" : ""}`;
  });
  assert.deepEqual(labels, ["group:HELD", "card:job_held", "card:job_mismatch", "group:RELEASED", "card:job_paid*", "attempt:1", "attempt:2",
    "group:REFUNDED", "card:job_refunded", "group:NONE", "card:job_open"]);
  assert.equal(rows.filter((row) => row.kind === "card").length, BOOK.length, "every job is one card");
});

test("every wide column has a floor from VERDICT_MIN_WIDTHS, and every floor belongs to a column that is there", () => {
  const dashboards = readFileSync(new URL("./studio/dashboards.tsx", import.meta.url), "utf8");
  const columns = [...dashboards.matchAll(/colId: "(\w+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(columns, Object.keys(VERDICT_MIN_WIDTHS).sort());
  for (const column of columns) {
    assert.match(dashboards, new RegExp(`minWidth: VERDICT_MIN_WIDTHS\\.${column}\\b`), `${column} has no minWidth from the floors`);
  }
});

test("the floors sum to 1350px, 222px past the 1128px tile at 1600: each floor fits its widest hosted value, so the grid scrolls sideways", () => {
  const sum = Object.values(VERDICT_MIN_WIDTHS).reduce((total, px) => total + px, 0);
  assert.equal(sum, 1350, "the documented sum of the floors");
  assert.equal(sum - 1128, 222, "the overrun the grid scrolls by at 1600");
});

test("the timeline does not suppress horizontal scroll, so a column below its floor scrolls instead of clipping", () => {
  const dashboards = readFileSync(new URL("./studio/dashboards.tsx", import.meta.url), "utf8");
  assert.equal(/\bsuppressHorizontalScroll\b/.test(dashboards), false);
});
