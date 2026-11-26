/**
 * The home dashboard's "Open drifts" figure counts open drifts only, as the Drift dashboard's
 * "Open drifts" card does (GET /reconciliation/drifts/stats). It read the total of
 * GET /reconciliation/drifts, which lists every status, so corrected and ignored drifts were
 * counted as open work.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { Dashboard } from '../Dashboard';

/** The tenant's drifts: two open, one corrected, two ignored. */
const DRIFT_STATUSES = ['open', 'open', 'corrected', 'ignored', 'ignored'];
const countWith = (status?: string) =>
  DRIFT_STATUSES.filter((s) => status === undefined || s === status).length;

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args) },
}));

describe('Dashboard', () => {
  beforeEach(() => {
    // Each route answers as the API does: the drift list filters by status only when asked,
    // the stats count open drifts.
    mockGet.mockReset().mockImplementation(async (url: string, config?: { params?: object }) => {
      if (url.endsWith('/reconciliation/drifts/stats')) {
        return { data: { total: countWith('open'), critical: 0, autoFixEligible: 0, pending: 2 } };
      }
      if (url.endsWith('/reconciliation/drifts')) {
        const status = (config?.params as { status?: string } | undefined)?.status;
        return { data: { drifts: [], total: countWith(status), page: 1, limit: 1 } };
      }
      return { data: {}, headers: {} };
    });
  });

  it('counts open drifts only, not corrected or ignored ones', async () => {
    renderWithProviders(<Dashboard />);

    // The attention feed states the figure as text (the KPI band may count up to it).
    expect(await screen.findByText('2 open drifts')).toBeInTheDocument();
    expect(screen.queryByText('5 open drifts')).not.toBeInTheDocument();
  });
});
