import type { ReactNode } from "react";

export interface DataTableColumn<Row> {
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  className?: string;
  headerClassName?: string;
}

export function DataTable<Row>({
  columns,
  rows,
  empty,
  rowKey,
}: {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  empty: ReactNode;
  rowKey: (row: Row, index: number) => string;
}) {
  if (rows.length === 0) {
    return <>{empty}</>;
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map((col, i) => (
            <th key={i} className={col.headerClassName} scope="col">
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rIdx) => (
          <tr key={rowKey(row, rIdx)}>
            {columns.map((col, cIdx) => (
              <td key={cIdx} className={col.className}>
                {col.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
