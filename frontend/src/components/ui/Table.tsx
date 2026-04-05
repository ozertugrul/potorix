import React from 'react';

export function Table<T extends { id?: string | number }>({ columns, rows }: { columns: Array<{ key: string; label: string; render?: (row: T) => React.ReactNode }>; rows: T[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={columns.length}>No data</td></tr> : rows.map((row, idx) => (
            <tr key={String(row.id ?? idx)}>
              {columns.map((c) => <td key={c.key}>{c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '-')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
