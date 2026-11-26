import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '../../../test/test-utils';
import { axiosInstance } from '@api/data';
import { RemovalFailing } from '../RemovalFailing';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn() },
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

const REQUEST_ID = '213d3c92-5f0e-4a51-9c3e-8b1f2a7d6e40';

// HX-E4: no admin view listed the ACTIVE requests past their end date whose removal keeps
// failing; a policy-admin needed the request link from elsewhere to close one by hand
describe('RemovalFailing', () => {
  beforeEach(() => {
    vi.mocked(axiosInstance.get).mockReset();
  });

  it('lists the failing removals with their reason and opens a request from its row', async () => {
    vi.mocked(axiosInstance.get).mockResolvedValue({
      data: {
        data: [
          {
            requestId: REQUEST_ID,
            status: 'ACTIVE',
            entitlements: [{ entitlementName: 'Finance Admins' }],
            expiresAt: '2026-11-20T00:00:00Z',
            statusReason: 'The removal was refused: entra-id: Graph 403',
          },
        ],
        total: 1,
      },
    });
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <RemovalFailing />
        <LocationProbe />
      </>,
      { initialRoute: '/access-requests?tab=removal-failing' },
    );

    const row = (await screen.findByText('Finance Admins')).closest('tr') as HTMLElement;
    expect(within(row).getByText(/Graph 403/)).toBeInTheDocument();
    expect(vi.mocked(axiosInstance.get).mock.calls[0][0]).toMatch(
      /\/access-requests\?removalFailing=true&page=1&limit=20$/,
    );

    await user.click(within(row).getByRole('button', { name: /Open/ }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/access-requests/${REQUEST_ID}`);
  });

  it('says so when there is none', async () => {
    vi.mocked(axiosInstance.get).mockResolvedValue({ data: { data: [], total: 0 } });
    renderWithProviders(<RemovalFailing />);

    expect(await screen.findByText('No failing removals')).toBeInTheDocument();
  });
});
