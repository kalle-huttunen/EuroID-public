import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { TransactionViewer } from '../TransactionViewer';
import type { IDistributedTransaction } from '../../../interfaces';

const rollbackFailed: IDistributedTransaction = {
  transactionId: 'tx-rf',
  workflowId: 't-default-dist-tx-tx-rf',
  phase: 'ROLLBACK_FAILED',
  operation: 'CREATE',
  startedAt: '2026-11-22T10:00:00.000Z',
  completedAt: '2026-11-22T10:00:02.000Z',
  initiatedBy: 'operator@example.com',
  participants: [
    { systemName: 'entra-id', status: 'ROLLBACK_FAILED', error: 'Graph 503' },
    { systemName: 'file-outbound', status: 'FAILED', error: 'Unknown system: file-outbound' },
  ],
  autoRollback: true,
  timeout: 300000,
};

vi.mock('@api/devtools-api', () => ({
  useTransactions: () => ({
    data: [rollbackFailed],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

describe('TransactionViewer', () => {
  it('shows a failed rollback as changes that remain, not as rolled back', () => {
    renderWithProviders(<TransactionViewer />);

    expect(screen.getByText('ROLLBACK FAILED, CHANGES REMAIN')).toBeInTheDocument();
    expect(screen.queryByText('ROLLED BACK')).not.toBeInTheDocument();
  });

  it('marks the system whose restore failed in the expanded row', () => {
    renderWithProviders(<TransactionViewer />);

    fireEvent.click(screen.getByRole('button', { name: /expand row/i }));

    expect(
      screen.getByText('Committed, restore failed: change still in place (Graph 503)'),
    ).toBeInTheDocument();
  });
});
