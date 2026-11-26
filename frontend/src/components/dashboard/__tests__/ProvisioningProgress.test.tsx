import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ProvisioningProgress } from '../ProvisioningProgress';

const get = vi.fn();
vi.mock('@api/data', () => ({ axiosInstance: { get: (...args: unknown[]) => get(...args) } }));

// Hunt 2026-11-25 08 F9: polling stopped only for COMPLETED and FAILED, and every status but
// RUNNING showed as a green tag
describe('ProvisioningProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    get.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it.each(['CANCELLED', 'TERMINATED', 'TIMED_OUT'])(
    'stops polling a %s workflow and does not show it as a success',
    async (status) => {
      get.mockResolvedValue({ data: { workflowId: 'wf-1', status, currentStep: 'done' } });
      render(<ProvisioningProgress visible workflowId="wf-1" userName="Ada" onClose={vi.fn()} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const calls = get.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(get.mock.calls.length).toBe(calls);
      const tag = screen.getByText(`Status: ${status}`);
      expect(tag.className).not.toContain('green');
    },
  );
});
