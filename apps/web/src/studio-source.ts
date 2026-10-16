import type { AgDataSourcesDefinition } from "ag-studio";
import type { PlatformTables } from "./api-types";
import type { AcquitRegistry } from "./studio/dashboards";

/**
 * The engine reads each `...Cents` column as dollars under the name without the suffix, so Studio's
 * currency format shows money. The route's integer cents stay the book; this is the only conversion.
 */
export function engineRows(rows: readonly object[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (key === "cents") return ["amount", (value as number) / 100];
        if (key.endsWith("Cents")) return [key.slice(0, -"Cents".length), typeof value === "number" ? value / 100 : value];
        return [key, value];
      }),
    ),
  );
}

/**
 * Studio mounts on the platform's escrow model: seven tables from one route, the relations between
 * them, the measures the escrow dashboards read, and a calendar on each release date. The native
 * widgets and the Data agent query the same rows the custom widgets total.
 */
export function escrowData(tables: PlatformTables): AgDataSourcesDefinition<AcquitRegistry> {
  return {
    description:
      "Acquit's escrow book across every tenant. One row per job in jobs; bids, verdicts, ledger_entries, paypal_events, and clients join to jobs. Each bid joins to the operator who placed it, and each job to the operator it was locked to. Money is in dollars. A job's held amount is in escrow only while its status is IN_PROGRESS or VERIFIED. Released, refunded, and fee amounts are settled. A verdict is one judged attempt.",
    sources: [
      {
        id: "jobs",
        name: "Jobs",
        description: "One row per job: its escrow state, funnel stage, operator, and money in dollars.",
        data: engineRows(tables.jobs),
        fields: [
          { id: "jobId", format: "textFormat" },
          { id: "title", format: "textFormat" },
          { id: "tenant", format: "textFormat" },
          { id: "clientId", format: "textFormat" },
          { id: "status", format: "textFormat" },
          { id: "escrow", format: "textFormat" },
          { id: "stage", format: "textFormat" },
          { id: "operatorId", format: "textFormat" },
          { id: "operatorHandle", format: "textFormat" },
          { id: "openedAt", format: "dateTimeFormat" },
          { id: "releasedAt", format: "dateTimeFormat" },
          { id: "bidCount", format: "integerFormat" },
          { id: "attemptCount", format: "integerFormat" },
          { id: "gross", format: "currencyFormat" },
          { id: "held", format: "currencyFormat" },
          { id: "released", format: "currencyFormat" },
          { id: "fee", format: "currencyFormat" },
          { id: "refunded", format: "currencyFormat" },
        ],
      },
      {
        id: "bids",
        name: "Bids",
        description: "Every bid on a job, independent or the House bid, with its price in dollars.",
        data: engineRows(tables.bids),
        fields: [
          { id: "bidId", format: "textFormat" },
          { id: "jobId", format: "textFormat" },
          { id: "operatorId", format: "textFormat" },
          { id: "handle", format: "textFormat" },
          { id: "kind", format: "textFormat" },
          { id: "status", format: "textFormat" },
          { id: "price", format: "currencyFormat" },
          { id: "etaHours", format: "integerFormat" },
          { id: "placedAt", format: "dateTimeFormat" },
        ],
      },
      {
        id: "verdicts",
        name: "Verdicts",
        description: "Every judged attempt on a job. verified is 1 for a pass; tamper is 1 for a rejection that touched the frozen tests.",
        data: engineRows(tables.verdicts),
        fields: [
          { id: "verdictId", format: "textFormat" },
          { id: "jobId", format: "textFormat" },
          { id: "ordinal", format: "integerFormat" },
          { id: "result", format: "textFormat" },
          { id: "verified", format: "integerFormat" },
          { id: "tamper", format: "integerFormat" },
          { id: "reasonCount", format: "integerFormat" },
          { id: "at", format: "dateTimeFormat" },
        ],
      },
      {
        id: "ledger_entries",
        name: "Ledger entries",
        description: "Each line of a job's book: a HELD, RELEASED, FEE, or REFUND amount in dollars, with the capture it belongs to.",
        data: engineRows(tables.ledger_entries),
        fields: [
          { id: "entryId", format: "textFormat" },
          { id: "jobId", format: "textFormat" },
          { id: "kind", format: "textFormat" },
          { id: "amount", format: "currencyFormat" },
          { id: "at", format: "dateTimeFormat" },
          { id: "captureId", format: "textFormat" },
          { id: "operatorId", format: "textFormat" },
          { id: "processor", format: "currencyFormat" },
          { id: "acquit", format: "currencyFormat" },
        ],
      },
      {
        id: "paypal_events",
        name: "PayPal events",
        description: "One row per PayPal capture an escrow was taken on, with its state and any refund or payout item.",
        data: engineRows(tables.paypal_events),
        fields: [
          { id: "captureId", format: "textFormat" },
          { id: "jobId", format: "textFormat" },
          { id: "orderId", format: "textFormat" },
          { id: "merchant", format: "textFormat" },
          { id: "state", format: "textFormat" },
          { id: "gross", format: "currencyFormat" },
          { id: "refundId", format: "textFormat" },
          { id: "refunded", format: "currencyFormat" },
          { id: "payoutItemId", format: "textFormat" },
          { id: "releasedAt", format: "dateTimeFormat" },
        ],
      },
      {
        id: "operators",
        name: "Operators",
        description: "Each operator, its payout readiness, and how many paid receipts it has earned.",
        data: engineRows(tables.operators),
        fields: [
          { id: "operatorId", format: "textFormat" },
          { id: "handle", format: "textFormat" },
          { id: "kind", format: "textFormat" },
          { id: "payoutReadiness", format: "textFormat" },
          { id: "paidReceipts", format: "integerFormat" },
        ],
      },
      {
        id: "clients",
        name: "Clients",
        description: "Each client and how many jobs it has posted.",
        data: engineRows(tables.clients),
        fields: [
          { id: "clientId", format: "textFormat" },
          { id: "jobCount", format: "integerFormat" },
        ],
      },
    ],
    relationships: [
      { id: "bids_jobs", source: { tableId: "bids", fieldId: "jobId" }, target: { tableId: "jobs", fieldId: "jobId" }, type: "many-to-one" },
      { id: "bids_operators", source: { tableId: "bids", fieldId: "operatorId" }, target: { tableId: "operators", fieldId: "operatorId" }, type: "many-to-one" },
      { id: "verdicts_jobs", source: { tableId: "verdicts", fieldId: "jobId" }, target: { tableId: "jobs", fieldId: "jobId" }, type: "many-to-one" },
      { id: "ledger_jobs", source: { tableId: "ledger_entries", fieldId: "jobId" }, target: { tableId: "jobs", fieldId: "jobId" }, type: "many-to-one" },
      { id: "paypal_jobs", source: { tableId: "paypal_events", fieldId: "jobId" }, target: { tableId: "jobs", fieldId: "jobId" }, type: "many-to-one" },
      { id: "ledger_paypal", source: { tableId: "ledger_entries", fieldId: "captureId" }, target: { tableId: "paypal_events", fieldId: "captureId" }, type: "many-to-one" },
      { id: "jobs_operators", source: { tableId: "jobs", fieldId: "operatorId" }, target: { tableId: "operators", fieldId: "operatorId" }, type: "many-to-one" },
      { id: "jobs_clients", source: { tableId: "jobs", fieldId: "clientId" }, target: { tableId: "clients", fieldId: "clientId" }, type: "many-to-one" },
      {
        id: "released_calendar",
        source: { tableId: "jobs", fieldId: "releasedAt" },
        target: { calendarId: "release_calendar" },
        truncate: "day",
      },
    ],
    expressions: [
      {
        id: "takeRate",
        name: "Take rate",
        format: "percentageFormat",
        isMeasure: true,
        expression: {
          operator: "divide",
          inputs: [
            { id: "jobs.fee", aggregation: "sum" },
            { id: "jobs.released", aggregation: "sum" },
          ],
        },
      },
      {
        id: "verifierPassRate",
        name: "Verifier pass rate",
        format: "percentageFormat",
        isMeasure: true,
        expression: {
          operator: "divide",
          inputs: [
            { id: "verdicts.verified", aggregation: "sum" },
            { id: "verdicts.verdictId", aggregation: "count" },
          ],
        },
      },
      {
        id: "escrowAtRisk",
        name: "Escrow at risk",
        format: "currencyFormat",
        isMeasure: true,
        expression: { id: "jobs.held", aggregation: "sum" },
      },
      {
        id: "refundRate",
        name: "Refund rate",
        format: "percentageFormat",
        isMeasure: true,
        expression: {
          operator: "divide",
          inputs: [
            { id: "jobs.refunded", aggregation: "sum" },
            { id: "jobs.gross", aggregation: "sum" },
          ],
        },
      },
    ],
    calendars: [
      {
        id: "release_calendar",
        label: "Release date",
        range: { from: { type: "date", value: "2026-01-01" }, to: { type: "date", value: "2028-12-31" } },
        fragments: ["year", "quarter", "month", "day"],
      },
    ],
  };
}

export const STUDIO_EARNINGS_DATA: AgDataSourcesDefinition<AcquitRegistry> = {
  sources: [
    {
      id: "acquit",
      data: [],
      // The receipt and payout columns the earnings widgets read.
      fields: [
        { id: "id", format: "textFormat" },
        { id: "jobId", format: "textFormat" },
        { id: "paid", format: "integerFormat" },
        { id: "fee", format: "integerFormat" },
        { id: "grossPaid", format: "integerFormat" },
        { id: "releasedAt", format: "dateTimeFormat" },
        { id: "result", format: "textFormat" },
        { id: "payoutItemId", format: "textFormat" },
      ],
    },
  ],
};
