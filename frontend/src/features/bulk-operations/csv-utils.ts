/**
 * Simple client-side CSV parsing.
 * Handles quoted fields and comma-, semicolon- or tab-separated values: Excel in European locales
 * (Finnish included) writes `;`, often in Windows-1252 (decodeCsvBytes).
 */

const DELIMITERS = [',', ';', '\t'] as const;

/** The separator the header line uses most outside quotes (comma when it uses none). */
function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (const c of text) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === '\n' || c === '\r')) break;
    else if (!inQuotes && counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

/** The file's text: UTF-8, else Windows-1252 (bytes that are no UTF-8, as older Excel writes). */
export function decodeCsvBytes(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function parseCsv(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === delimiter) {
        current.push(field.trim());
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        current.push(field.trim());
        field = '';
        if (current.some((cell) => cell.length > 0)) {
          rows.push(current);
        }
        current = [];
      } else {
        field += c;
      }
    }
  }

  if (field.length > 0 || current.length > 0) {
    current.push(field.trim());
    if (current.some((cell) => cell.length > 0)) {
      rows.push(current);
    }
  }

  return rows;
}

export function detectHeaders(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const first = rows[0];
  return first.map((cell, i) => cell?.trim() || `Column_${i + 1}`);
}
