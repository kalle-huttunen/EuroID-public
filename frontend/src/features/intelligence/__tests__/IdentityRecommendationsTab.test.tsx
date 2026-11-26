/**
 * The identity page's Recommendations tab: what GET /intelligence/recommendations/:identityId
 * answers (share of peers, how the peers hold it, whether it can be requested, the catalog's risk
 * level or none), that it is advice only, and its empty, loading and error states. The tab's
 * operator gate is tested with the identity page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { IdentityRecommendationsTab } from '../IdentityRecommendationsTab';
import { AINO_ID, RECOMMENDATIONS, apiError } from './access-intelligence.fixtures';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args), post: vi.fn() },
}));

describe('IdentityRecommendationsTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists what most peers have: the share, how they have it, whether it can be requested and the risk', async () => {
    mockGet.mockResolvedValue({ data: RECOMMENDATIONS });
    renderWithProviders(<IdentityRecommendationsTab identityId={AINO_ID} />);

    const table = await screen.findByRole('table', { name: 'Recommended entitlements' });
    expect(mockGet).toHaveBeenCalledWith(`/api/v1/intelligence/recommendations/${AINO_ID}`);
    const [share, license, reports] = within(table).getAllByRole('row').slice(1);
    expect(within(share).getByText('CN=Finance-Share,OU=Groups,DC=corp,DC=example')).toBeVisible();
    expect(within(share).getByText('ad')).toBeInTheDocument();
    expect(within(share).getByText('83%')).toBeInTheDocument();
    expect(within(share).getByText('Access requests')).toBeInTheDocument();
    expect(within(share).getByText('Requestable')).toBeInTheDocument();
    expect(within(share).getByText('MEDIUM')).toBeInTheDocument();
    expect(within(license).getByText('M365-E5')).toBeInTheDocument();
    expect(within(license).getByText('75%')).toBeInTheDocument();
    expect(within(license).getByText('Role-based rules')).toBeInTheDocument();
    expect(within(license).getByText('Not requestable')).toBeInTheDocument();
    expect(within(license).getByText('Not in the catalog')).toBeInTheDocument();
    // A group built before the batch recorded how peers hold it.
    expect(within(reports).getByText('Not recorded')).toBeInTheDocument();
    expect(within(reports).getByText('Not requestable')).toBeInTheDocument();
    expect(within(reports).getByText('HIGH')).toBeInTheDocument();

    // Advice only: nothing on the tab grants access.
    expect(screen.getByText(/nothing here grants access/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says why there may be no recommendation and where the data comes from', async () => {
    mockGet.mockResolvedValue({ data: [] });
    renderWithProviders(<IdentityRecommendationsTab identityId={AINO_ID} />);

    expect(await screen.findByText('No recommendations for this identity')).toBeInTheDocument();
    expect(screen.getByText(/in no peer group/)).toBeInTheDocument();
    expect(screen.getByText(/04:00 UTC by default/)).toBeInTheDocument();
  });

  it('shows a skeleton while the recommendations load', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithProviders(<IdentityRecommendationsTab identityId={AINO_ID} />);
    expect(container.querySelector('.ant-skeleton')).not.toBeNull();
  });

  it('shows the API’s message when the recommendations cannot be loaded', async () => {
    mockGet.mockRejectedValue(apiError(403, 'Requires one of: operator'));
    renderWithProviders(<IdentityRecommendationsTab identityId={AINO_ID} />);

    expect(await screen.findByText('Could not load the recommendations')).toBeInTheDocument();
    expect(screen.getByText('Requires one of: operator')).toBeInTheDocument();
  });
});
