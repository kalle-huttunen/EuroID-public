/**
 * 08 F7: when the analytics calls failed, each card showed its empty state, so a failed
 * offboardings call read as "No departures scheduled in the next 30 days".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { Analytics } from '../Analytics';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args) },
}));
vi.mock('@api/realtime', () => ({
  useSocket: vi.fn().mockReturnValue({ socket: null, status: 'disconnected' }),
}));

describe('Analytics when its calls fail', () => {
  beforeEach(() => {
    mockGet.mockReset().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 500'), {
        response: { status: 500, data: { message: 'Operation failed' } },
      }),
    );
  });

  it('shows an error on each card instead of its empty state', async () => {
    renderWithProviders(<Analytics />);

    expect(
      await screen.findByText('Upcoming offboardings could not be loaded'),
    ).toBeInTheDocument();
    expect(screen.getByText('License forecast could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('Seasonal patterns could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No upcoming offboardings')).toBeNull();
    expect(screen.queryByText('No license data')).toBeNull();
    expect(screen.queryByText('No seasonal data yet')).toBeNull();
  });
});
