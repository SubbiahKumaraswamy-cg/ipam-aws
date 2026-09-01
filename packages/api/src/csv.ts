/**
 * CSV serialisation / parsing.
 *
 * Deliberately dependency-free: the formats involved are simple and a hand
 * written RFC 4180 parser avoids shipping an extra library into the Lambda
 * bundle. Handles quoted fields, embedded commas/quotes and CRLF endings.
 */

/** Serialise an array of objects to CSV using the supplied column order. */
export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: { key: keyof T & string; header: string }[],
): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str =
      typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [columns.map((c) => escape(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(row[c.key])).join(','));
  }
  return lines.join('\r\n');
}

/** Parse CSV text into an array of row objects keyed by header name. */
export function parseCsv(input: string): Record<string, string>[] {
  const rows = parseCsvRows(input);
  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    // Skip completely blank lines.
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const record: Record<string, string> = {};
    headers.forEach((header, idx) => {
      record[header] = (cells[idx] ?? '').trim();
    });
    out.push(record);
  }
  return out;
}

/** Tokenise CSV text into a matrix of raw cell values. */
export function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Strip a UTF-8 BOM, which Excel exports frequently include.
  const text = input.replace(/^\uFEFF/, '');

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // Handled by the \n branch; ignore lone CR.
      if (text[i + 1] === '\n') continue;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  // Flush the final field/row if the file does not end with a newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Look up a value from a CSV record using several possible header spellings.
 * The source spreadsheet uses varying capitalisation and spacing, so imports
 * accept any of the listed aliases.
 */
export function pick(
  record: Record<string, string>,
  aliases: string[],
): string | null {
  const normalise = (s: string): string =>
    s.toLowerCase().replace(/[\s_/-]+/g, '');

  const index = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    index.set(normalise(key), value);
  }

  for (const alias of aliases) {
    const value = index.get(normalise(alias));
    if (value !== undefined && value !== '') return value;
  }
  return null;
}
