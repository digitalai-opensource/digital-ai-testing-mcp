// Minimal RFC-4180-ish CSV parser: handles quoted fields (including embedded
// commas and newlines) and doubled-quote escaping ("" -> "). Not a general
// purpose CSV library — just enough to parse the usage-report CSVs, which
// quote fields like `"Jul 20, 2026, 8:21:33 AM"` (a comma inside a field).

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing field/row when the text doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }
  // A file ending in a newline produces one fully-empty trailing row — drop it.
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === '') {
      rows.pop();
    } else {
      break;
    }
  }

  return rows;
}

export function parseCsv(text: string): ParsedCsv {
  const [headers, ...dataRows] = tokenizeCsv(text);
  return { headers: headers ?? [], rows: dataRows };
}

const isBlankRow = (row: string[]) => row.every((cell) => cell === '');

/**
 * Some usage reports are MULTI-SECTION (confirmed live 2026-10-09): a per-project summary table, a blank line, then
 * a second table with its own header — per-reservation detail in Device Reservations, per-user rows (with the 26.2
 * "User Tag" column) in Users Usage. Each blank-line-separated block is returned with its own header.
 */
export function parseCsvSections(text: string): ParsedCsv[] {
  const sections: ParsedCsv[] = [];
  let current: string[][] = [];
  const flush = () => {
    if (current.length > 0) sections.push({ headers: current[0], rows: current.slice(1) });
    current = [];
  };
  for (const row of tokenizeCsv(text)) {
    if (isBlankRow(row)) flush();
    else current.push(row);
  }
  flush();
  return sections;
}

/** One CSV line into its fields: quoted fields may hold commas and doubled quotes. */
export function splitCsvLine(line: string): string[] {
  if (line.indexOf('"') === -1) return line.split(',');
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (line[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { fields.push(field); field = ''; } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * Walk a large CSV row by row without building it in memory: `onRow` gets one row's fields at a time and keeps what it
 * needs. A blank line arrives as `['']`. Quoted fields may hold commas, doubled quotes and line breaks.
 * For the session-by-session License Usage report: 30 days was 48 MB and 172,916 rows of 25 columns (live 2026-11-25);
 * parseCsv would build over four million strings from it.
 */
export function scanCsvRows(data: Buffer, onRow: (fields: string[]) => void): void {
  const quotes = (s: string) => { let n = 0; for (let i = s.indexOf('"'); i !== -1; i = s.indexOf('"', i + 1)) n++; return n; };
  const len = data.length;
  let pos = 0;
  while (pos < len) {
    let end = data.indexOf(10, pos);
    if (end === -1) end = len;
    let line = data.toString('utf8', pos, end);
    // An odd number of quotes: the line break was inside a quoted field, so the row goes on.
    while (end < len && line.indexOf('"') !== -1 && quotes(line) % 2 === 1) {
      const next = data.indexOf(10, end + 1);
      const stop = next === -1 ? len : next;
      line += `\n${data.toString('utf8', end + 1, stop)}`;
      end = stop;
    }
    pos = end + 1;
    onRow(splitCsvLine(line.endsWith('\r') ? line.slice(0, -1) : line));
  }
}
