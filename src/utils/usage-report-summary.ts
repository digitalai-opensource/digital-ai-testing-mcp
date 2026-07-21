import type { ParsedCsv } from './csv.js';

// Pure in-memory aggregation over an already-parsed usage-report CSV. Exists so
// a caller can get "session counts by username" (or any other column) without
// ever writing the CSV to disk — the file-isolation problem found live (the
// MCP server's container filesystem is not the caller's, so a written file is
// frequently unreachable) doesn't apply when nothing is written at all.

export interface SummarizeOptions {
  groupBy: string;
  sumColumn?: string;
  topN?: number;
}

export interface GroupResult {
  value: string;
  count: number;
  sum?: number;
}

export interface SummaryResult {
  totalRows: number;
  totalGroups: number;
  groups: GroupResult[];
  truncated: boolean;
  availableColumns: string[];
}

const DEFAULT_TOP_N = 50;

function findColumnIndex(headers: string[], name: string): number {
  const target = name.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === target);
}

export function summarizeRows(parsed: ParsedCsv, opts: SummarizeOptions): SummaryResult {
  const { headers, rows } = parsed;

  const groupIdx = findColumnIndex(headers, opts.groupBy);
  if (groupIdx === -1) {
    throw new Error(`groupBy column "${opts.groupBy}" not found. Available columns: ${headers.join(', ')}`);
  }

  let sumIdx = -1;
  if (opts.sumColumn !== undefined) {
    sumIdx = findColumnIndex(headers, opts.sumColumn);
    if (sumIdx === -1) {
      throw new Error(`sumColumn "${opts.sumColumn}" not found. Available columns: ${headers.join(', ')}`);
    }
  }

  const buckets = new Map<string, { count: number; sum: number }>();
  let countedRows = 0;
  for (const row of rows) {
    if (row.every((cell) => cell === '')) continue; // skip fully-blank rows (trailing-newline artifacts)
    countedRows++;
    const key = row[groupIdx] ?? '';
    const entry = buckets.get(key) ?? { count: 0, sum: 0 };
    entry.count += 1;
    if (sumIdx !== -1) {
      const n = Number(row[sumIdx]);
      if (!Number.isNaN(n)) entry.sum += n;
    }
    buckets.set(key, entry);
  }

  const sorted: GroupResult[] = [...buckets.entries()]
    .map(([value, { count, sum }]) => (sumIdx !== -1 ? { value, count, sum: Math.round(sum * 100) / 100 } : { value, count }))
    .sort((a, b) => b.count - a.count);

  const topN = opts.topN ?? DEFAULT_TOP_N;
  const truncated = sorted.length > topN;

  return {
    totalRows: countedRows,
    totalGroups: sorted.length,
    groups: sorted.slice(0, topN),
    truncated,
    availableColumns: headers,
  };
}
