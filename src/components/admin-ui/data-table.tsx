import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { focusRing } from "./styles";

export type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Row header cell (`<th scope="row">`), usually the name column. */
  rowHeader?: boolean;
  align?: "left" | "right";
  className?: string;
};

export type DataTableProps<Row> = {
  /** Table caption: named for screen readers; shown when `showCaption`. */
  caption: string;
  showCaption?: boolean;
  columns: DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
  /** Shown instead of the table when there are no rows. */
  empty?: ReactNode;
  /** The table scrolls sideways inside its box below this width. Default 600. */
  minWidth?: number;
  /** Cap the height so the sticky header has something to stick to. */
  maxHeight?: number;
  /** Dim a row (e.g. no consent) without hiding it. */
  isRowMuted?: (row: Row) => boolean;
  /** `plain` (inside a Panel) or `tinted` (grey box, as the DNS table). */
  variant?: "plain" | "tinted";
  className?: string;
};

/**
 * Simple responsive table: scrolls inside its own focusable box (never the page), sticky header,
 * optional empty state. Server-compatible: cell renderers run where it renders.
 */
export function DataTable<Row>({
  caption,
  showCaption = false,
  columns,
  rows,
  getRowKey,
  empty,
  minWidth = 600,
  maxHeight,
  isRowMuted,
  variant = "plain",
  className,
}: DataTableProps<Row>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const tinted = variant === "tinted";

  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      style={maxHeight ? { maxHeight } : undefined}
      className={cn("overflow-auto font-sans leading-[normal]", tinted && "rounded-input bg-[#f7f9fb]", focusRing, className)}
    >
      <table className="w-full border-collapse text-[14px]" style={{ minWidth }}>
        <caption className={cn(showCaption ? "pb-2 text-left text-[14px] font-semibold text-navy-950" : "sr-only")}>{caption}</caption>
        <thead className={cn("sticky top-0 z-[1]", tinted ? "bg-[#f7f9fb]" : "bg-white")}>
          <tr className="text-left text-[12px] tracking-[0.05em] text-grey-600 uppercase">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "font-bold whitespace-nowrap",
                  tinted ? "px-3.5 py-2.5" : "px-1.5 py-2",
                  column.align === "right" && "text-right",
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const muted = isRowMuted?.(row) ?? false;
            return (
              <tr key={getRowKey(row)} className={cn("border-t", tinted ? "border-grey-200" : "border-[#eef2f6]", muted ? "text-grey-600" : "text-grey-800")}>
                {columns.map((column) => {
                  const Cell = column.rowHeader ? "th" : "td";
                  return (
                    <Cell
                      key={column.key}
                      scope={column.rowHeader ? "row" : undefined}
                      className={cn(
                        "text-left align-middle",
                        tinted ? "px-3.5 py-3" : "px-1.5 py-[11px]",
                        column.rowHeader && "font-semibold",
                        column.align === "right" && "text-right",
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </Cell>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="m-0 px-1.5 py-4 text-[14px] text-grey-600">Nothing to show yet.</p> : null}
    </div>
  );
}
