import type { AgDataSourcesDefinition } from "ag-studio";
import type { AcquitRegistry } from "./studio/dashboards";

/**
 * Studio refuses to mount its canvas without a data source, even though every widget is a custom
 * component that reads React state instead, so each dashboard gets one source named after the
 * app. Its table is empty because no widget queries it; the fields its rows carry are declared
 * so Studio's schema check has something to validate.
 */
export const STUDIO_ESCROW_DATA: AgDataSourcesDefinition<AcquitRegistry> = {
  sources: [
    {
      id: "acquit",
      data: [],
      // The scalar columns of the PlatformJobLedger rows the escrow widgets read.
      fields: [
        { id: "jobId", format: "textFormat" },
        { id: "title", format: "textFormat" },
        { id: "tenant", format: "textFormat" },
        { id: "client", format: "textFormat" },
        { id: "status", format: "textFormat" },
        { id: "escrow", format: "textFormat" },
        { id: "paidCents", format: "integerFormat" },
      ],
    },
  ],
};

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
