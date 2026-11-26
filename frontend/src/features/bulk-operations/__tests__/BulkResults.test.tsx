import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BulkResults } from '../BulkResults';

const get = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => get(...args) },
}));

const answer = (status: string, rolledBack: number) =>
  // GET /bulk-provisioning/results/:workflowId answers { workflowId, results: <the run's result> }
  get.mockResolvedValue({
    data: {
      workflowId: 'wf-1',
      results: {
        batchId: 'batch-1',
        status,
        summary: { total: 3, successful: 0, failed: 0, skipped: 0, rolledBack },
        results: [
          { operationId: 'op-0', success: true, email: 'a***@example.com', type: 'CREATE' },
        ],
      },
    },
  });

// A cancelled batch compensates what it changed and ends CANCELLED with its results
// (bulk-provisioning:cancel-compensates)
describe('BulkResults', () => {
  beforeEach(() => get.mockReset());

  it('says a cancelled batch was cancelled and how many operations were rolled back', async () => {
    answer('CANCELLED', 1);
    render(<BulkResults workflowId="wf-1" onStartNew={vi.fn()} />);

    expect(await screen.findByText('The batch was cancelled')).toBeInTheDocument();
    expect(
      screen.getByText(
        /1 operation that had run was rolled back; the remaining operations did not run/,
      ),
    ).toBeInTheDocument();
  });

  it('shows no such notice for a batch that completed', async () => {
    answer('COMPLETED', 0);
    render(<BulkResults workflowId="wf-1" onStartNew={vi.fn()} />);

    expect(await screen.findByText('Export to CSV')).toBeInTheDocument();
    expect(screen.queryByText('The batch was cancelled')).not.toBeInTheDocument();
  });

  // HX-C2 follow-up: a row's status came from `success` only, so an operation a fail-fast run
  // rolled back read as a success, and summary.rolledBack was shown only for a cancelled run.
  it('shows an operation a fail-fast run rolled back as rolled back, with the summary count', async () => {
    get.mockResolvedValue({
      data: {
        workflowId: 'wf-1',
        results: {
          batchId: 'batch-1',
          status: 'FAILED',
          summary: { total: 2, successful: 0, failed: 1, skipped: 0, rolledBack: 1 },
          results: [
            {
              operationId: 'op-0',
              success: true,
              rolledBack: true,
              rollbackReason: 'Batch failed, compensating transaction',
              email: 'a***@example.com',
              type: 'CREATE',
            },
            { operationId: 'op-1', success: false, error: 'Graph said no', type: 'CREATE' },
          ],
        },
      },
    });
    render(<BulkResults workflowId="wf-1" onStartNew={vi.fn()} />);

    const row = (await screen.findByText('a***@example.com')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Rolled back')).toBeInTheDocument();
    expect(within(row).queryByText('Succeeded')).not.toBeInTheDocument();
    expect(within(row).getByText('Batch failed, compensating transaction')).toBeInTheDocument();

    expect(screen.getByText('The batch was rolled back after a failure')).toBeInTheDocument();
    expect(screen.getByText(/1 operation that had succeeded was rolled back/)).toBeInTheDocument();
    const rolledBackStat = screen.getByText('Rolled back', { selector: '.ant-statistic-title' });
    expect(rolledBackStat.closest('.ant-statistic')).toHaveTextContent('1');
  });

  it('still shows an operation that stayed in place as succeeded', async () => {
    answer('COMPLETED', 0);
    render(<BulkResults workflowId="wf-1" onStartNew={vi.fn()} />);

    const row = (await screen.findByText('a***@example.com')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Succeeded')).toBeInTheDocument();
    expect(screen.queryByText('Rolled back')).not.toBeInTheDocument();
  });
});
