import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GetRowIdFunc } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid writes each value into a CSS custom property, so var() references resolve to styles.css's palette.
export const acquitTheme = themeQuartz.withParams({
  fontFamily: "var(--sans)",
  fontSize: 13,
  dataFontSize: 13,
  foregroundColor: "var(--ink)",
  textColor: "var(--ink)",
  cellTextColor: "var(--ink)",
  backgroundColor: "var(--card)",
  accentColor: "var(--green)",
  borderColor: "var(--line)",
  headerTextColor: "var(--muted)",
  headerBackgroundColor: "#fbfaf7",
  headerFontSize: 11,
  headerFontWeight: 600,
  oddRowBackgroundColor: "var(--card)",
  rowHoverColor: "#fbfaf7",
  selectedRowBackgroundColor: "var(--green-bg)",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  columnBorder: false,
  spacing: 6,
  cellHorizontalPadding: 10,
});

const defaultColDef: ColDef = {
  sortable: false,
  resizable: false,
  suppressMovable: true,
  wrapText: true,
  autoHeight: true,
  wrapHeaderText: true,
  autoHeaderHeight: true,
  headerClass: "grid-head",
  flex: 1,
  minWidth: 56,
};

/** Every grid in the app: Acquit theme, rows sized to their wrapped content, never a horizontal scrollbar. */
export function AcquitGrid<T>({
  rows,
  columns,
  rowId,
  empty,
}: {
  rows: readonly T[];
  columns: ColDef<T>[];
  rowId?: GetRowIdFunc<T>;
  /** A fixed sentence for the no-rows overlay; AG Grid inserts it as HTML. */
  empty: string;
}) {
  return (
    <div className="acquit-grid">
      <AgGridReact<T>
        theme={acquitTheme}
        rowData={rows as T[]}
        columnDefs={columns}
        defaultColDef={defaultColDef as ColDef<T>}
        getRowId={rowId}
        domLayout="autoHeight"
        suppressHorizontalScroll
        enableCellTextSelection={false}
        overlayNoRowsTemplate={`<span class="muted">${empty}</span>`}
      />
    </div>
  );
}
