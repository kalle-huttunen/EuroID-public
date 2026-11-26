/**
 * The license forecast's current count was EuroID's net adds minus removes in a 6-month window,
 * not the units in use (HX-F report follow-up). It is now what Entra ID reported at the last
 * discovery, and unknown (null) until discovery has run: the card says so instead of a 0.
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

const forecasts = [
  {
    system: 'entra-id',
    license: 'ENTERPRISEPACK',
    currentCount: 95,
    capacity: 100,
    projectedCount: 98,
    daysToCapacity: 150,
    trend: 'growing',
    monthlyRate: 1,
  },
  {
    system: 'entra-id',
    license: 'FLOW_FREE',
    currentCount: null,
    capacity: null,
    projectedCount: null,
    trend: 'stable',
    monthlyRate: 0,
    insufficientData: true,
  },
];

describe('Analytics license forecast', () => {
  beforeEach(() => {
    mockGet.mockReset().mockImplementation(async (url: string) => ({
      data: url.includes('/analytics/license-forecast') ? forecasts : [],
    }));
  });

  it('shows the units in use against the units the tenant has, or that they are unknown', async () => {
    renderWithProviders(<Analytics />);

    expect(await screen.findByText('Current: 95 of 100')).toBeInTheDocument();
    expect(screen.getByText('Projected (90d): 98')).toBeInTheDocument();
    expect(screen.getByText('Current: unknown (discovery has not run)')).toBeInTheDocument();
    expect(screen.getByText('Projected (90d): unknown')).toBeInTheDocument();
  });
});
