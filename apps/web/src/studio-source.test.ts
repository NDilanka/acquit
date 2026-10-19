import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlatformBidRow, PlatformJobRow, PlatformTables } from "./api-types.ts";
import { engineRows, escrowData, STUDIO_EARNINGS_DATA } from "./studio-source.ts";

type FieldSchema = { readonly id: string; readonly format: string };
type SourceSchema = {
  readonly id: string;
  readonly description?: string;
  readonly data: readonly unknown[];
  readonly fields?: readonly FieldSchema[];
};
type RelationSchema = { readonly id: string; readonly source: { readonly tableId?: string; readonly fieldId?: string; readonly calendarId?: string }; readonly target: { readonly tableId?: string; readonly fieldId?: string; readonly calendarId?: string }; readonly type?: string; readonly truncate?: string };
type Definition = {
  readonly description?: string;
  readonly sources: readonly SourceSchema[];
  readonly relationships?: readonly RelationSchema[];
  readonly expressions?: readonly { readonly id: string; readonly format?: string; readonly isMeasure: boolean; readonly expression: unknown }[];
  readonly calendars?: readonly unknown[];
};

const EMPTY_TABLES: PlatformTables = {
  jobs: [], bids: [], verdicts: [], ledger_entries: [], paypal_events: [], operators: [], clients: [],
};

function escrow(): Definition {
  return escrowData(EMPTY_TABLES) as Definition;
}

function source(definition: Definition, id: string): SourceSchema {
  const found = definition.sources.find((s) => s.id === id);
  assert.ok(found, `the ${id} table is declared`);
  return found;
}

const OPENED = "2026-10-13T12:00:00.000Z";
const OPEN_JOB: PlatformJobRow = {
  jobId: "job_posted", title: "posted job", tenant: null, clientId: "lena-client", status: "OPEN", escrow: "NONE",
  stage: "1 Posted", operatorId: null, operatorHandle: null, openedAt: OPENED, releasedAt: null, bidCount: 0,
  attemptCount: 0, grossCents: 0, heldCents: 0, releasedCents: 0, feeCents: 0, refundedCents: 0,
};

test("the escrow model declares the seven relational tables the platform route serves", () => {
  assert.deepEqual(
    escrow().sources.map((s) => s.id).sort(),
    ["bids", "clients", "jobs", "ledger_entries", "operators", "paypal_events", "verdicts"],
  );
});

test("each table declares the columns its widgets and measures read", () => {
  const columns = (id: string) => (source(escrow(), id).fields ?? []).map((field) => field.id).sort();
  assert.deepEqual(columns("jobs"), [
    "attemptCount", "bidCount", "clientId", "escrow", "fee", "gross", "held", "jobId", "openedAt", "operatorHandle",
    "operatorId", "refunded", "released", "releasedAt", "stage", "status", "tenant", "title",
  ]);
  assert.deepEqual(columns("ledger_entries"), ["acquit", "amount", "at", "captureId", "entryId", "jobId", "kind", "operatorId", "processor"]);
  assert.deepEqual(columns("verdicts"), ["at", "jobId", "ordinal", "reasonCount", "result", "tamper", "verdictId", "verified"]);
  assert.deepEqual(columns("paypal_events"), [
    "captureId", "gross", "jobId", "merchant", "orderId", "payoutItemId", "refundId", "refunded", "releasedAt", "state",
  ]);
});

test("relationships join every table to jobs, a capture to its events, and a release date to the calendar", () => {
  const relations = (escrow().relationships ?? []).map((r) => {
    const from = r.source.tableId ? `${r.source.tableId}.${r.source.fieldId}` : `${r.source.fieldId}`;
    const to = r.target.tableId ? `${r.target.tableId}.${r.target.fieldId}` : `calendar:${r.target.calendarId}`;
    return `${r.id}: ${from} -> ${to} ${r.type ?? `truncate ${r.truncate}`}`;
  });
  assert.deepEqual(relations, [
    "bids_jobs: bids.jobId -> jobs.jobId many-to-one",
    "bids_operators: bids.operatorId -> operators.operatorId many-to-one",
    "verdicts_jobs: verdicts.jobId -> jobs.jobId many-to-one",
    "ledger_jobs: ledger_entries.jobId -> jobs.jobId many-to-one",
    "paypal_jobs: paypal_events.jobId -> jobs.jobId many-to-one",
    "ledger_paypal: ledger_entries.captureId -> paypal_events.captureId many-to-one",
    "jobs_operators: jobs.operatorId -> operators.operatorId many-to-one",
    "jobs_clients: jobs.clientId -> clients.clientId many-to-one",
    "released_calendar: jobs.releasedAt -> calendar:release_calendar truncate day",
  ]);
});

test("the expressions are the dashboards' measures: take rate, pass rate, escrow at risk, and refund rate", () => {
  const expressions = escrow().expressions ?? [];
  assert.deepEqual(expressions.map((e) => e.id), ["takeRate", "verifierPassRate", "escrowAtRisk", "refundRate"]);
  assert.ok(expressions.every((e) => e.isMeasure), "every expression is a measure");
  assert.deepEqual(expressions[0]?.expression, {
    operator: "divide",
    inputs: [{ id: "jobs.fee", aggregation: "sum" }, { id: "jobs.released", aggregation: "sum" }],
  });
});

test("the release calendar spans 2026 through 2028 by year, quarter, month, and day", () => {
  assert.deepEqual(escrow().calendars, [{
    id: "release_calendar",
    label: "Release date",
    range: { from: { type: "date", value: "2026-01-01" }, to: { type: "date", value: "2028-12-31" } },
    fragments: ["year", "quarter", "month", "day"],
  }]);
});

test("the dataset carries a description the Data agent can read, with money in dollars", () => {
  assert.match(escrow().description ?? "", /Money is in dollars/);
});

test("engineRows reads each cents column as dollars under the name without the suffix", () => {
  assert.deepEqual(
    engineRows([{ jobId: "job_ledger_held", heldCents: 37800, releasedCents: 0 }, { cents: 42000, processorCents: 1515, acquitCents: null }]),
    [{ jobId: "job_ledger_held", held: 378, released: 0 }, { amount: 420, processor: 15.15, acquit: null }],
  );
});

test("a job no operator has locked reads No operator yet in the jobs source, and a locked job keeps its handle", () => {
  const locked: PlatformJobRow = { ...OPEN_JOB, jobId: "job_paid", status: "PAID", escrow: "RELEASED", stage: "5 Paid",
    operatorId: "alpha-ops", operatorHandle: "alpha" };
  const tables: PlatformTables = { ...EMPTY_TABLES, jobs: [OPEN_JOB, locked] };
  const rows = source(escrowData(tables) as Definition, "jobs").data as readonly Record<string, unknown>[];
  assert.deepEqual(rows.map((row) => [row.jobId, row.operatorId, row.operatorHandle]), [
    ["job_posted", null, "No operator yet"],
    ["job_paid", "alpha-ops", "alpha"],
  ]);
});

test("the bids source passes its rows through, so only the jobs source carries the operator label", () => {
  const bid: PlatformBidRow = { bidId: "bid_paid_alpha", jobId: "job_paid", operatorId: "alpha-ops", handle: "alpha",
    kind: "INDEPENDENT", status: "ACCEPTED", priceCents: 10000, etaHours: 48, placedAt: OPENED };
  const tables: PlatformTables = { ...EMPTY_TABLES, bids: [bid] };
  assert.deepEqual(source(escrowData(tables) as Definition, "bids").data, [
    { bidId: "bid_paid_alpha", jobId: "job_paid", operatorId: "alpha-ops", handle: "alpha", kind: "INDEPENDENT",
      status: "ACCEPTED", price: 100, etaHours: 48, placedAt: OPENED },
  ]);
});

test("the jobs source description tells the Data agent that a job not yet locked to an operator reads No operator yet", () => {
  assert.match(source(escrow(), "jobs").description ?? "", /operatorHandle "No operator yet"/);
});

test("the jobs source's jobId field reads a pivot cell with no job as blank, not as (Blanks)", () => {
  assert.deepEqual(
    (source(escrow(), "jobs").fields ?? []).find((field) => field.id === "jobId"),
    { id: "jobId", format: "textFormat", blankValue: "" },
  );
});

test("the earnings dashboard's acquit source declares the receipt and payout columns its widgets read", () => {
  const [earnings] = STUDIO_EARNINGS_DATA.sources as readonly SourceSchema[];
  assert.ok(earnings);
  assert.equal(earnings.id, "acquit");
  assert.deepEqual(earnings.data, []);
  assert.deepEqual(
    (earnings.fields ?? []).map((field) => field.id).sort(),
    ["fee", "grossPaid", "id", "jobId", "paid", "payoutItemId", "releasedAt", "result"],
  );
});

const FORMATS = new Set([
  "integerFormat",
  "decimalFormat",
  "percentageFormat",
  "currencyFormat",
  "textFormat",
  "dateFormat",
  "dateTimeFormat",
  "booleanFormat",
]);

test("every declared field carries a built-in format so the schema validates", () => {
  for (const definition of [escrow(), STUDIO_EARNINGS_DATA as Definition]) {
    for (const data of definition.sources) {
      for (const field of data.fields ?? []) {
        assert.ok(FORMATS.has(field.format), `field '${field.id}' declares format '${field.format}'`);
      }
    }
  }
});
