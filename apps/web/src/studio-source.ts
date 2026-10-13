import type { AgDataSourcesDefinition } from "ag-studio";
import type { AcquitRegistry } from "./studio/dashboards";

/**
 * Studio refuses to mount its canvas without a data source, even though every widget is a custom
 * component that reads React state instead, so each dashboard gets one source named after the
 * app. Its table is empty because no widget queries it.
 */
export const STUDIO_ESCROW_DATA: AgDataSourcesDefinition<AcquitRegistry> = {
  sources: [{ id: "acquit", data: [] }],
};

export const STUDIO_EARNINGS_DATA: AgDataSourcesDefinition<AcquitRegistry> = {
  sources: [{ id: "acquit", data: [] }],
};
