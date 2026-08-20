/**
 * Minimal, dependency-free CSV (RFC 4180) reader/writer with CSV-injection
 * defence baked in. Used by the product export/import — the export writes with
 * `csvCell`, the import reads with `parseCsv` and rejects formula cells.
 */

// A cell beginning with one of these can execute as a formula when the file is
// opened in Excel/Sheets. On export we neutralise it with a leading apostrophe;
// on import we refuse it as a value. (OWASP CSV-injection set.)
const FORMULA_START = /^[=+\-@\t\r]/;

export function looksLikeFormula(value: string): boolean {
  return FORMULA_START.test(value);
}

/** Neutralises a formula-leading cell for export by prefixing an apostrophe. */
export function neutralizeFormula(value: string): string {
  return looksLikeFormula(value) ? `'${value}` : value;
}

/** Quotes a cell for CSV output (doubling quotes) after neutralising formulas. */
export function csvCell(value: unknown): string {
  const s = neutralizeFormula(value == null ? '' : String(value));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialises a grid to CRLF-delimited CSV with a UTF-8 BOM (so Excel reads £/€). */
export function serializeCsv(rows: string[][]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Parses CSV text into a grid. Handles quoted fields with embedded commas,
 * quotes ("") and newlines, and CRLF or LF line endings. Strips a leading BOM.
 * Fully-empty lines are dropped.
 */
export function parseCsv(input: string): string[][] {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawField = false; // did this row have any field at all (even empty)?

  const pushField = () => { row.push(field); field = ''; sawField = true; };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row); // drop blank lines
    row = [];
    sawField = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; sawField = true; continue; }
    if (c === ',') { pushField(); continue; }
    if (c === '\n') { pushRow(); continue; }
    if (c === '\r') { continue; } // part of CRLF (or a lone CR) — ignored between fields
    field += c;
    sawField = true;
  }
  // Trailing field/row not terminated by a newline.
  if (sawField || field !== '' || row.length > 0) pushRow();

  return rows;
}
