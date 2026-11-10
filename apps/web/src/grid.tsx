import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GetRowIdFunc } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid writes each value into a CSS custom property, so var() references resolve to tokens.css's palette.
export const acquitTheme = themeQuartz.withParams({
  fontFamily: "var(--sans)",
  fontSize: 14,
  dataFontSize: 14,
  foregroundColor: "var(--ink)",
  textColor: "var(--ink)",
  cellTextColor: "var(--ink)",
  backgroundColor: "var(--card)",
  accentColor: "var(--focus)",
  borderColor: "var(--line)",
  inputBorder: { color: "var(--line-2)", width: 1 },
  inputBorderRadius: 12,
  buttonBorderRadius: 12,
  headerTextColor: "var(--muted)",
  headerBackgroundColor: "var(--surface)",
  headerFontSize: 13,
  headerFontWeight: 600,
  oddRowBackgroundColor: "var(--card)",
  rowHoverColor: "var(--surface)",
  selectedRowBackgroundColor: "var(--green-bg)",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  columnBorder: false,
  spacing: 4,
  cellHorizontalPadding: 12,
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
