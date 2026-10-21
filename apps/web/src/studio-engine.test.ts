import assert from "node:assert/strict";
import { test } from "node:test";
import { createDataEngine, type AgDataSourcesDefinition, type AgStudioQuery } from "ag-studio";
import type {
  PlatformBidRow,
  PlatformJobLedger,
  PlatformJobRow,
  PlatformLedgerEntryRow,
  PlatformOperatorRow,
  PlatformPayPalEventRow,
  PlatformTables,
  PlatformVerdictRow,
} from "./api-types.ts";
import { NATIVE_WIDGETS, type NativeWidgetSpec } from "./dashboard-widgets.ts";
import { conserves, escrowTotals, verifierStats } from "./studio-data.ts";
import { escrowData } from "./studio-source.ts";

// Runs the escrow model through Studio's real data engine in Node: no DOM and no browser. The
// fixture is a literal route-shaped book with a paid job, a held job, a refunded job, a job whose
// capture awaits its mismatch refund, and a posted job with no money. Money is cents in the
// fixture; the engine reads each cents column as dollars.

const OPENED = "2026-10-13T12:00:00.000Z";
const RELEASED = "2026-10-13T15:00:00.000Z";

const OPERATORS: PlatformOperatorRow[] = [
  { operatorId: "alpha-ops", handle: "alpha", kind: "INDEPENDENT", payoutReadiness: "READY", paidReceipts: 1 },
  { operatorId: "beta-ops", handle: "beta", kind: "INDEPENDENT", payoutReadiness: "READY", paidReceipts: 0 },
];

const JOBS: PlatformJobRow[] = [
  { jobId: "job_paid", title: "paid job", tenant: "v_a", clientId: "maya-client", status: "PAID", escrow: "RELEASED",
    stage: "5 Paid", operatorId: "alpha-ops", operatorHandle: "alpha", openedAt: OPENED, releasedAt: RELEASED, bidCount: 2,
    attemptCount: 2, grossCents: 11000, heldCents: 0, releasedCents: 10000, feeCents: 1000, refundedCents: 0 },
  { jobId: "job_held", title: "held job", tenant: "v_b", clientId: "splitter-client", status: "IN_PROGRESS", escrow: "HELD",
    stage: "3 Funded", operatorId: "beta-ops", operatorHandle: "beta", openedAt: OPENED, releasedAt: null, bidCount: 2,
    attemptCount: 1, grossCents: 37800, heldCents: 37800, releasedCents: 0, feeCents: 0, refundedCents: 0 },
  { jobId: "job_refunded", title: "refunded job", tenant: null, clientId: "maya-client", status: "REFUNDED", escrow: "REFUNDED",
    stage: "6 Refunded", operatorId: "alpha-ops", operatorHandle: "alpha", openedAt: OPENED, releasedAt: null, bidCount: 1,
    attemptCount: 0, grossCents: 42000, heldCents: 0, releasedCents: 0, feeCents: 0, refundedCents: 42000 },
  { jobId: "job_pending", title: "pending refund job", tenant: "v_c", clientId: "lena-client", status: "OPEN", escrow: "HELD",
    stage: "2 Bid", operatorId: null, operatorHandle: null, openedAt: OPENED, releasedAt: null, bidCount: 2,
    attemptCount: 0, grossCents: 42100, heldCents: 42100, releasedCents: 0, feeCents: 0, refundedCents: 0 },
  { jobId: "job_posted", title: "posted job", tenant: null, clientId: "lena-client", status: "OPEN", escrow: "NONE",
    stage: "1 Posted", operatorId: null, operatorHandle: null, openedAt: OPENED, releasedAt: null, bidCount: 0,
    attemptCount: 0, grossCents: 0, heldCents: 0, releasedCents: 0, feeCents: 0, refundedCents: 0 },
];

const BIDS: PlatformBidRow[] = [
  { bidId: "bid_paid_alpha", jobId: "job_paid", operatorId: "alpha-ops", handle: "alpha", kind: "INDEPENDENT", status: "ACCEPTED",
    priceCents: 10000, etaHours: 48, placedAt: OPENED },
  { bidId: "bid_paid_beta", jobId: "job_paid", operatorId: "beta-ops", handle: "beta", kind: "INDEPENDENT", status: "NOT_SELECTED",
    priceCents: 20000, etaHours: 48, placedAt: OPENED },
  { bidId: "bid_held_beta", jobId: "job_held", operatorId: "beta-ops", handle: "beta", kind: "INDEPENDENT", status: "ACCEPTED",
    priceCents: 36000, etaHours: 48, placedAt: OPENED },
  { bidId: "bid_held_alpha", jobId: "job_held", operatorId: "alpha-ops", handle: "alpha", kind: "INDEPENDENT", status: "NOT_SELECTED",
    priceCents: 35000, etaHours: 48, placedAt: OPENED },
  { bidId: "bid_refunded_alpha", jobId: "job_refunded", operatorId: "alpha-ops", handle: "alpha", kind: "INDEPENDENT", status: "ACCEPTED",
    priceCents: 40000, etaHours: 48, placedAt: OPENED },
  { bidId: "bid_pending_beta", jobId: "job_pending", operatorId: "beta-ops", handle: "beta", kind: "INDEPENDENT", status: "PENDING",
    priceCents: 36000, etaHours: 48, placedAt: OPENED },
  { bidId: "bid_pending_alpha", jobId: "job_pending", operatorId: "alpha-ops", handle: "alpha", kind: "INDEPENDENT", status: "NOT_SELECTED",
    priceCents: 35000, etaHours: 48, placedAt: OPENED },
];

const VERDICTS: PlatformVerdictRow[] = [
  { verdictId: "job_paid#1", jobId: "job_paid", ordinal: 1, result: "REJECTED", verified: 0, tamper: 0, reasonCount: 1, at: OPENED },
  { verdictId: "job_paid#2", jobId: "job_paid", ordinal: 2, result: "VERIFIED", verified: 1, tamper: 0, reasonCount: 0, at: RELEASED },
  { verdictId: "job_held#1", jobId: "job_held", ordinal: 1, result: "REJECTED", verified: 0, tamper: 1, reasonCount: 1, at: OPENED },
];

const LEDGER: PlatformLedgerEntryRow[] = [
  { entryId: "job_paid#0", jobId: "job_paid", kind: "HELD", cents: 11000, at: OPENED, captureId: "CAP_PAID", operatorId: "alpha-ops",
    processorCents: null, acquitCents: null },
  { entryId: "job_paid#1", jobId: "job_paid", kind: "RELEASED", cents: 10000, at: RELEASED, captureId: "CAP_PAID", operatorId: "alpha-ops",
    processorCents: null, acquitCents: null },
  { entryId: "job_paid#2", jobId: "job_paid", kind: "FEE", cents: 1000, at: RELEASED, captureId: "CAP_PAID", operatorId: "alpha-ops",
    processorCents: 400, acquitCents: 600 },
  { entryId: "job_held#0", jobId: "job_held", kind: "HELD", cents: 37800, at: OPENED, captureId: "CAP_HELD", operatorId: "beta-ops",
    processorCents: null, acquitCents: null },
  { entryId: "job_refunded#0", jobId: "job_refunded", kind: "HELD", cents: 42000, at: OPENED, captureId: "CAP_REFUNDED",
    operatorId: "alpha-ops", processorCents: null, acquitCents: null },
  { entryId: "job_refunded#1", jobId: "job_refunded", kind: "REFUND", cents: 42000, at: RELEASED, captureId: "CAP_REFUNDED",
    operatorId: "alpha-ops", processorCents: null, acquitCents: null },
  { entryId: "job_pending#0", jobId: "job_pending", kind: "HELD", cents: 42100, at: OPENED, captureId: "CAP_PENDING", operatorId: null,
    processorCents: null, acquitCents: null },
];

const PAYPAL: PlatformPayPalEventRow[] = [
  { captureId: "CAP_PAID", jobId: "job_paid", orderId: null, merchant: "sandbox-seller", state: "RELEASED", grossCents: 11000,
    refundId: null, refundedCents: null, payoutItemId: "payout-item-paid", releasedAt: RELEASED },
  { captureId: "CAP_HELD", jobId: "job_held", orderId: "ORDER_HELD", merchant: "sandbox-seller", state: "CAPTURED", grossCents: 37800,
    refundId: null, refundedCents: null, payoutItemId: null, releasedAt: null },
  { captureId: "CAP_REFUNDED", jobId: "job_refunded", orderId: null, merchant: "sandbox-seller", state: "REFUNDED", grossCents: 42000,
    refundId: "REFUND_REFUNDED", refundedCents: 42000, payoutItemId: null, releasedAt: null },
  { captureId: "CAP_PENDING", jobId: "job_pending", orderId: "ORDER_PENDING", merchant: "sandbox-seller", state: "CAPTURED",
    grossCents: 42100, refundId: null, refundedCents: null, payoutItemId: null, releasedAt: null },
];

const CLIENTS = [
  { clientId: "maya-client", jobCount: 2 },
  { clientId: "splitter-client", jobCount: 1 },
  { clientId: "lena-client", jobCount: 2 },
];

const TABLES: PlatformTables = {
  jobs: JOBS, bids: BIDS, verdicts: VERDICTS, ledger_entries: LEDGER, paypal_events: PAYPAL, operators: OPERATORS, clients: CLIENTS,
};

/** The same book the custom ledger widgets read, one entry per job. */
function ledgerJob(job: Pick<PlatformJobLedger, "jobId" | "title" | "tenant" | "client" | "status" | "escrow" | "lines" | "attempts"> &
  { readonly operator: PlatformJobLedger["operator"] }): PlatformJobLedger {
  return { ...job, paidCents: null, fee: null, payout: null, receipt: null };
}

const BOOK: PlatformJobLedger[] = [
  ledgerJob({ jobId: "job_paid", title: "paid job", tenant: "v_a", client: "maya-client", status: "PAID", escrow: "RELEASED",
    operator: { id: "alpha-ops", handle: "alpha" },
    lines: [{ kind: "HELD", cents: 11000, at: OPENED }, { kind: "RELEASED", cents: 10000, at: RELEASED },
      { kind: "FEE", cents: 1000, processor: 400, acquit: 600, at: RELEASED }],
    attempts: [{ ordinal: 1, result: "REJECTED", at: OPENED, tamper: false, reasons: ["TESTS_FAILED:frozen"], frozen: { expected: 2, passed: 1 }, hidden: { expected: 6, passed: 6 } },
      { ordinal: 2, result: "VERIFIED", at: RELEASED, tamper: false, reasons: [], frozen: { expected: 2, passed: 2 }, hidden: { expected: 6, passed: 6 } }] }),
  ledgerJob({ jobId: "job_held", title: "held job", tenant: "v_b", client: "splitter-client", status: "IN_PROGRESS", escrow: "HELD",
    operator: { id: "beta-ops", handle: "beta" }, lines: [{ kind: "HELD", cents: 37800, at: OPENED }],
    attempts: [{ ordinal: 1, result: "REJECTED", at: OPENED, tamper: true, reasons: ["PROTECTED_PATH_MODIFIED"], frozen: null, hidden: null }] }),
  ledgerJob({ jobId: "job_refunded", title: "refunded job", tenant: null, client: "maya-client", status: "REFUNDED", escrow: "REFUNDED",
    operator: { id: "alpha-ops", handle: "alpha" },
    lines: [{ kind: "HELD", cents: 42000, at: OPENED }, { kind: "REFUND", cents: 42000, at: RELEASED }], attempts: [] }),
  ledgerJob({ jobId: "job_pending", title: "pending refund job", tenant: "v_c", client: "lena-client", status: "OPEN", escrow: "HELD",
    operator: null, lines: [{ kind: "HELD", cents: 42100, at: OPENED }], attempts: [] }),
  ledgerJob({ jobId: "job_posted", title: "posted job", tenant: null, client: "lena-client", status: "OPEN", escrow: "NONE",
    operator: null, lines: [], attempts: [] }),
];

/** Runs queries through the engine in strict mode and returns each query's rows; any validation issue fails the test. */
async function run(tables: PlatformTables, queries: readonly AgStudioQuery[]): Promise<Record<string, unknown>[][]> {
  // The escrow definition is typed against the app's widget registry; the engine's public signature takes the default one.
  const engine = createDataEngine(escrowData(tables) as unknown as AgDataSourcesDefinition);
  assert.ok(engine.addEventListener && engine.finalize && engine.dispose, "the engine exposes its validation and lifecycle hooks");
  const issues: unknown[] = [];
  engine.addEventListener("validation", (event) => issues.push(event));
  engine.finalize();
  try {
    const results = await engine.execute(...queries.map((query) => ({ query, options: { strict: true } })));
    assert.deepEqual(issues, [], "the engine raised no validation issue");
    return results.map((result) => {
      if (result.dataShape !== "rows") throw new Error("expected rows");
      return result.rows;
    });
  } finally {
    engine.dispose();
  }
}

// The engine addresses a column by its qualified id, as "jobs.held", not by the bare name.
const field = (sourceId: string, fieldId: string) => ({ key: `${sourceId}.${fieldId}`, sourceId, fieldId: `${sourceId}.${fieldId}` });
const dimension = (sourceId: string, fieldId: string, as: string) => ({ field: field(sourceId, fieldId), as });
const total = (sourceId: string, fieldId: string, as: string) =>
  ({ field: { key: `${sourceId}.${fieldId}:sum`, sourceId, fieldId: `${sourceId}.${fieldId}`, aggregation: "sum" as const }, as });
const rowCount = (sourceId: string, fieldId: string, as: string) =>
  ({ field: { key: `${sourceId}.${fieldId}:count`, sourceId, fieldId: `${sourceId}.${fieldId}`, aggregation: "count" as const }, as });
const expression = (id: string) => ({ field: { key: id, sourceId: "", fieldId: id, isMeasure: true } });

const sorted = (values: readonly string[]) => [...values].sort();
const dollarsToCents = (value: unknown) => Math.round(Number(value) * 100);

test("the funnel counts each job once, at its current stage", async () => {
  const [rows] = await run(TABLES, [{ axes: [{ dimensions: [dimension("jobs", "stage", "stage")] }],
    measures: [rowCount("jobs", "jobId", "jobs")] }]);
  assert.deepEqual(sorted((rows ?? []).map((row) => `${row.stage}=${row.jobs}`)),
    ["1 Posted=1", "2 Bid=1", "3 Funded=1", "5 Paid=1", "6 Refunded=1"]);
});

test("the funnel's spec sort returns its stages in pipeline order", async () => {
  const specs: readonly NativeWidgetSpec[] = NATIVE_WIDGETS.escrow.flat();
  const funnel = specs.find((spec) => spec.id === "escrow-funnel");
  assert.ok(funnel?.sort, "the funnel spec carries a sort");
  const sort = funnel.sort.map(({ field: ref, direction }) => {
    const [sourceId = "", fieldId = ""] = ref.id.split(".");
    return { field: field(sourceId, fieldId), direction };
  });
  const [rows] = await run(TABLES, [{ axes: [{ dimensions: [dimension("jobs", "stage", "stage")] }],
    measures: [rowCount("jobs", "jobId", "jobs")], sort }]);
  assert.deepEqual((rows ?? []).map((row) => row.stage), ["1 Posted", "2 Bid", "3 Funded", "5 Paid", "6 Refunded"]);
});

test("the status pivot counts each job under its operator and status", async () => {
  const [rows] = await run(TABLES, [{ axes: [{ dimensions: [dimension("jobs", "operatorHandle", "handle")] },
    { dimensions: [dimension("jobs", "status", "status")] }], measures: [rowCount("jobs", "jobId", "jobs")] }]);
  assert.deepEqual(sorted((rows ?? []).map((row) => `${row.handle}/${row.status}=${row.jobs}`)),
    ["No operator yet/OPEN=2", "alpha/PAID=1", "alpha/REFUNDED=1", "beta/IN_PROGRESS=1"]);
});

test("the treemap's held input sums each operator's escrow in dollars, and totals the custom held figure", async () => {
  const [rows] = await run(TABLES, [{ axes: [{ dimensions: [dimension("jobs", "operatorHandle", "handle")] }],
    measures: [total("jobs", "held", "held")] }]);
  assert.deepEqual(sorted((rows ?? []).map((row) => `${row.handle}=${row.held}`)), ["No operator yet=421", "alpha=0", "beta=378"]);
  const engineHeld = (rows ?? []).reduce((sum, row) => sum + dollarsToCents(row.held), 0);
  assert.equal(engineHeld, escrowTotals(BOOK).held);
  assert.equal(engineHeld, 79900);
});

test("the money aggregates equal the custom ledger, and held, released, refunded, and fees add up to the funded gross", async () => {
  const [totalsRows] = await run(TABLES, [{ measures: [total("jobs", "gross", "gross"), total("jobs", "held", "held"),
    total("jobs", "released", "released"), total("jobs", "fee", "fee"), total("jobs", "refunded", "refunded")] }]);
  const totals = totalsRows?.[0];
  assert.deepEqual(
    { gross: totals?.gross, held: totals?.held, released: totals?.released, fee: totals?.fee, refunded: totals?.refunded },
    { gross: 1329, held: 799, released: 100, fee: 10, refunded: 420 },
  );
  const custom = escrowTotals(BOOK);
  assert.deepEqual(
    { held: dollarsToCents(totals?.held), released: dollarsToCents(totals?.released), refunded: dollarsToCents(totals?.refunded),
      fees: dollarsToCents(totals?.fee) },
    custom,
  );
  assert.deepEqual(custom, { held: 79900, released: 10000, refunded: 42000, fees: 1000 });
  const funded = dollarsToCents(totals?.gross);
  assert.equal(funded, 132900);
  assert.equal(funded, custom.held + custom.released + custom.refunded + custom.fees, "the conservation identity holds");
});

test("each shipped measure, queried alone, returns its intended value and the custom figure it names", async () => {
  const measures = ["takeRate", "verifierPassRate", "escrowAtRisk", "refundRate"];
  const results = await run(TABLES, measures.map((id) => ({ measures: [expression(id)] })));
  const value = (index: number, id: string) => Number(results[index]?.[0]?.[id]);
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is ${expected}`);
  const custom = escrowTotals(BOOK);
  const stats = verifierStats(BOOK);
  close(value(0, "takeRate"), custom.fees / custom.released);
  close(value(0, "takeRate"), 0.1);
  close(value(1, "verifierPassRate"), stats.passRate);
  close(value(1, "verifierPassRate"), 1 / 3);
  close(value(2, "escrowAtRisk"), custom.held / 100);
  close(value(2, "escrowAtRisk"), 799);
  close(value(3, "refundRate"), custom.refunded / 132900);
  close(value(3, "refundRate"), 420 / 1329);
});

test("each operator's bids add up to the prices that operator placed, not the prices of the jobs it was locked to", async () => {
  const [rows] = await run(TABLES, [{ axes: [{ dimensions: [dimension("operators", "handle", "handle")] }],
    measures: [total("bids", "price", "price")] }]);
  assert.deepEqual(sorted((rows ?? []).map((row) => `${row.handle}=${row.price}`)), ["alpha=1200", "beta=920"]);
});

test("an accepted $100 bid by alpha and a losing $200 bid by beta split by bidder, not by the job's operator", async () => {
  const tables: PlatformTables = { jobs: [JOBS[0]!], bids: [BIDS[0]!, BIDS[1]!], verdicts: [], ledger_entries: [], paypal_events: [],
    operators: OPERATORS, clients: [] };
  const [rows] = await run(tables, [{ axes: [{ dimensions: [dimension("operators", "handle", "handle")] }],
    measures: [total("bids", "price", "price")] }]);
  assert.deepEqual(sorted((rows ?? []).map((row) => `${row.handle}=${row.price}`)), ["alpha=100", "beta=200"]);
});

type ShippedDefinition = {
  readonly description: string;
  readonly expressions: readonly { readonly id: string; readonly description?: string; readonly expression: unknown }[];
};

const referenced = (node: unknown): string[] => {
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => (key === "id" && typeof value === "string" ? [value] : referenced(value)));
};
const tableOf = (ids: readonly string[]) => [...new Set(ids.map((id) => id.split(".")[0]))];
const measureTablesOf = (definition: ShippedDefinition) =>
  Object.fromEntries(definition.expressions.map((e) => [e.id, tableOf(referenced(e.expression))]));

test("each shipped measure reads one table, and each native widget reads one table", () => {
  const definition = escrowData(TABLES) as ShippedDefinition;
  assert.deepEqual(measureTablesOf(definition), {
    takeRate: ["jobs"], verifierPassRate: ["verdicts"], escrowAtRisk: ["jobs"], refundRate: ["jobs"],
  });
  for (const widget of NATIVE_WIDGETS.escrow.flat()) {
    const ids = Object.values(widget.dataMapping).flat().map((ref) => ref.id);
    assert.deepEqual(tableOf(ids), ["jobs"], `${widget.id} reads one table`);
  }
});

test("each measure's description names the table it reads, and the dataset says to query verdicts apart from jobs", () => {
  const definition = escrowData(TABLES) as ShippedDefinition;
  for (const [id, [table]] of Object.entries(measureTablesOf(definition))) {
    const measure = definition.expressions.find((e) => e.id === id);
    assert.match(measure?.description ?? "", new RegExp(`computed on the ${table} table`, "i"), `${id} names its table`);
  }
  assert.match(definition.description, /takeRate, escrowAtRisk, and refundRate are computed on jobs\./);
  assert.match(definition.description, /verifierPassRate is computed on verdicts, so it is queried apart from the jobs measures\./);
  assert.match(definition.description, /drops each job that has no verdict, such as a refunded job\./);
});

test("the custom ledger widgets conserve on the literal book", () => {
  assert.deepEqual(conserves(BOOK), { payout: 10000, fee: 1000, paid: 11000, holds: true });
  assert.deepEqual(verifierStats(BOOK), { passRate: 1 / 3, rejectRate: 2 / 3, tamperAttempts: 1, attempts: 3 });
});
