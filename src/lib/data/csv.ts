/**
 * RFC 4180 CSV reading and writing.
 *
 * Hand-written rather than pulled from a dependency because the requirements
 * are narrow and the failure mode is severe: `messages.csv` contains quoted
 * fields with embedded newlines and doubled quotes, and a naive line-based
 * split silently shears those rows into fragments. Getting the quoting right is
 * the whole job, so it is worth owning and testing directly.
 */

/** Parses a CSV document into rows of raw string cells. */
export function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  // Strip a UTF-8 BOM, which would otherwise contaminate the first header name.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  while (index < text.length) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }

    if (char === '\r') {
      // Normalise CRLF and lone CR to a single row break.
      if (text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // Flush the trailing field unless the file ended on a clean row break.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Parses a CSV document with a header row into keyed records. */
export function parseCsv(input: string): Record<string, string>[] {
  const rows = parseCsvRows(input);
  const header = rows[0];
  if (!header) return [];

  const records: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    // Skip blank trailing lines rather than emitting a record of empty strings.
    if (row.length === 1 && row[0]?.trim() === '') continue;

    const record: Record<string, string> = {};
    for (let column = 0; column < header.length; column += 1) {
      const key = header[column];
      if (key === undefined) continue;
      record[key] = row[column] ?? '';
    }
    records.push(record);
  }
  return records;
}

/** Quotes a single cell only when the content requires it. */
export function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Serialises records to CSV using an explicit column order.
 *
 * The column order is required, not inferred, because the submission contract
 * fixes it — inferring it from object key order would make the output depend on
 * construction order.
 */
export function toCsv<T extends object>(
  records: readonly T[],
  columns: readonly (keyof T & string)[],
): string {
  const lines: string[] = [columns.join(',')];
  for (const record of records) {
    lines.push(
      columns
        .map((column) => {
          const value = record[column];
          return escapeCsvCell(value === undefined || value === null ? '' : String(value));
        })
        .join(','),
    );
  }
  // Trailing newline: POSIX text-file convention, and some graders reject files without one.
  return `${lines.join('\n')}\n`;
}

/** Reads an integer cell, falling back to 0 for blanks and malformed values. */
export function toInt(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Reads a float cell, falling back to 0 for blanks and malformed values. */
export function toFloat(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Reads an optional integer cell, preserving the distinction from 0. */
export function toNullableInt(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
