import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BulkProgress } from '../BulkProgress';

const get = vi.fn();
const post = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

const answer = (status: string, progress: Record<string, number>) =>
  get.mockImplementation(async (url?: string) =>
    String(url).includes('/status/')
      ? { data: { status, currentPhase: 'EXECUTING_CREATES', progress } }
      : { data: [] },
  );

// Hunt 2026-11-25 08 F9
describe('BulkProgress', () => {
  beforeEach(() => get.mockReset());

  it('counts each processed operation once', async () => {
    // The workflow counts every processed operation in currentOperation and the successes again
    answer('RUNNING', { currentOperation: 10, totalOperations: 10, operationsSuccessful: 10 });
    render(<BulkProgress workflowId="wf-1" onComplete={vi.fn()} />);

    expect(await screen.findByText('Completed: 10 / 10')).toBeInTheDocument();
  });

  it.each(['TIMED_OUT', 'CANCELLED', 'TERMINATED', 'COMPLETED', 'FAILED'])(
    'moves on to the results when the run is %s',
    async (status) => {
      answer(status, { currentOperation: 1, totalOperations: 2, operationsSuccessful: 1 });
      const onComplete = vi.fn();
      render(<BulkProgress workflowId="wf-1" onComplete={onComplete} />);

      await waitFor(() => expect(onComplete).toHaveBeenCalled());
    },
  );

  // r2-09 N2: an error replaced the whole panel, Approve deletes and Cancel included, with axios's
  // own text.
  it("keeps the panel and its actions after a refused cancel, with the API's reason", async () => {
    answer('RUNNING', { currentOperation: 1, totalOperations: 2, operationsSuccessful: 1 });
    post.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        response: { status: 403, data: { message: 'Forbidden resource' } },
      }),
    );
    render(<BulkProgress workflowId="wf-1" onComplete={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: /Cancel workflow/ }));

    expect(await screen.findByText('Forbidden resource')).toBeInTheDocument();
    expect(screen.getByText('Completed: 1 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel workflow/ })).toBeInTheDocument();
  });
});
