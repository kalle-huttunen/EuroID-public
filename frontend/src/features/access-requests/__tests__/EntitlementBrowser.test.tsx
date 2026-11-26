/**
 * The self-service catalog on the access request portal. Its table had no horizontal scroll
 * container, so at 400 px the whole portal scrolled sideways (the table was 539 px wide). It now
 * scrolls inside its own container like the other tables, and its toast comes from App.useApp().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { EntitlementBrowser } from '../EntitlementBrowser';
import type { RequestableCatalogEntry } from '@api/access-requests-api';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: vi.fn(),
  },
}));

// The form has its own tests; here it only reports a submitted request.
vi.mock('../RequestForm', () => ({
  RequestForm: ({ onSuccess }: { onSuccess: () => void }) => (
    <button type="button" onClick={onSuccess}>
      Submit request
    </button>
  ),
}));

/** As GET /entitlement-catalog/requestable answers it. */
const entry: RequestableCatalogEntry = {
  _id: '6741c0f2a9d3e5b1c2f40b01',
  name: 'SG-Engineering',
  system: 'entra-id',
  type: 'group',
  riskLevel: 'MEDIUM',
  category: 'Engineering',
  userDescription: 'Access to the engineering repositories and build agents.',
};

describe('EntitlementBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { data: [entry], total: 1 } });
  });

  it('scrolls the catalog inside its own container on phones, not the page', async () => {
    renderWithProviders(<EntitlementBrowser />);

    const table = (await screen.findByText('SG-Engineering')).closest('table')!;
    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining('/entitlement-catalog/requestable?'),
    );
    expect(table.closest('.ant-table-content')).toHaveStyle({ overflowX: 'auto' });
    expect(table.style.width).toBe('760px');
  });

  it('confirms a submitted request', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    renderWithProviders(<EntitlementBrowser />);

    const row = (await screen.findByText('SG-Engineering')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /Request/ }));
    await user.click(await screen.findByRole('button', { name: 'Submit request' }));

    expect(await screen.findByText('Request submitted successfully')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit request' })).not.toBeInTheDocument();
  });
});
