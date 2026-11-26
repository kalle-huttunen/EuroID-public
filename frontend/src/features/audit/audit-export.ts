/**
 * The audit log's CSV export and its date range (AuditDashboard).
 */
import dayjs from 'dayjs';
import type { IAuditEvent } from '../../interfaces';

/** A spreadsheet runs a cell starting with one of these as a formula (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell: always quoted, quotes doubled, and a value a spreadsheet would run as a formula
 * prefixed with an apostrophe, so it is shown as text.
 */
export function csvCell(value: string | undefined | null): string {
  const text = value ?? '';
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function eventsToCSV(events: IAuditEvent[]): string {
  const header = 'Timestamp,Action,Actor,Resource,Target System,Description\n';
  const rows = events.map((e) =>
    [
      dayjs(e.timestamp).format('YYYY-MM-DD HH:mm:ss'),
      e.action,
      e.actor,
      e.resourceName,
      e.targetSystem,
      e.description,
    ]
      .map(csvCell)
      .join(','),
  );
  return header + rows.join('\n');
}

export type DateRange = [dayjs.Dayjs | null, dayjs.Dayjs | null];

/** A date-only range as the API takes it: from the start of the first day to the end of the last. */
export function wholeDays(range: DateRange): [string | undefined, string | undefined] {
  return [range[0]?.startOf('day').toISOString(), range[1]?.endOf('day').toISOString()];
}
