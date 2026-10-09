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
