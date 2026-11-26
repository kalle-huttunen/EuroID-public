/**
 * The bulk results CSV (BulkResults' Export to CSV): one row per operation. Every cell goes
 * through the audit export's csvCell: quoted, and a value starting with a formula character
 * neutralised, since email, user id and error text come from the uploaded file.
 */
import type { IBulkResultItem } from '../../interfaces/bulk-operation.interface';
import { csvCell } from '../audit/audit-export';

export function resultsToCsv(results: IBulkResultItem[]): string {
  const headers = ['operationId', 'status', 'userId', 'email', 'error', 'rollbackReason'];
  const rows = results.map((r) => [
    r.operationId,
    r.status,
    r.userId,
    r.email,
    r.error,
    r.rollbackReason,
  ]);
  return [headers.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\r\n');
}
