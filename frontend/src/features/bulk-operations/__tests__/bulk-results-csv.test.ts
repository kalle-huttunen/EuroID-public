/**
 * Final review FE3: the bulk results CSV had no formula guard. `email` and `userId` come from the
 * uploaded CSV and `error` can echo them, so a row with email =HYPERLINK(...) became a live
 * formula when an operator opened the export in Excel. It now writes every cell through the audit
 * export's csvCell (features/audit/audit-export.ts): quoted, and a leading = + - @ tab or CR
 * neutralised.
 */
import { describe, expect, it } from 'vitest';
import { resultsToCsv } from '../bulk-results-csv';
import type { IBulkResultItem } from '../../../interfaces/bulk-operation.interface';

const row = (over: Partial<IBulkResultItem>): IBulkResultItem =>
  ({ operationId: 'op-1', status: 'failed', ...over }) as IBulkResultItem;

describe('bulk results CSV', () => {
  it.each([
    ['email', { email: '=HYPERLINK("http://evil.example","x")' }],
    ['userId', { userId: '+cmd|/C calc!A0' }],
    ['error', { error: '@SUM(A1)' }],
    ['rollbackReason', { rollbackReason: '-2+3' }],
  ])('neutralises a formula in %s', (_field, over) => {
    const [, line] = resultsToCsv([row(over)]).split('\r\n');
    const value = Object.values(over)[0] as string;

    expect(line).toContain(`"'${value.replace(/"/g, '""')}"`);
  });

  it('quotes every cell, so a value with a comma or a quote stays one cell', () => {
    const [header, line] = resultsToCsv([
      row({ email: 'a@x.example', error: 'Graph said "no", twice' }),
    ]).split('\r\n');

    expect(header).toBe('operationId,status,userId,email,error,rollbackReason');
    expect(line).toBe('"op-1","failed","","a@x.example","Graph said ""no"", twice",""');
  });
});
