/**
 * Access reviews beyond the first 100 rows, a failed load, the reviewer match and the role gates.
 *
 * - 08 F5: campaigns and a campaign's items were fetched with limit 100 and no paging, so a
 *   campaign of 350 items showed 100 and the rest could not be reached.
 * - 08 F7: a failed campaigns load showed "No campaigns yet".
 * - r2-08 N8: the reviewer's own pending items offered Approve and Revoke only when the stored
 *   reviewer matched the signed-in email exactly; the API compares without case.
 * - 08 F8: Create Campaign (policy-admin), Activate (super-admin) and Approve or Revoke (operator)
 *   were shown to a viewer, whom the API refuses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
import '../../../config/antd-react19';
import { AccessReviews } from '../AccessReviews';
import type { ReviewCampaign, ReviewItem } from '@api/intelligence-api';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const REVIEWER = mockAuthValue.user.profile.email;

const campaign: ReviewCampaign = {
  campaignId: '4b4e1f0e-6c1b-4f5e-9a51-0c2a6b9d0004',
  name: 'Q4 2026 access certification',
  scope: { type: 'all' },
  status: 'ACTIVE',
  createdBy: REVIEWER,
  autoRevokeOnExpiry: false,
  stats: { totalItems: 350, approved: 0, revoked: 0, pending: 350, expired: 0 },
};

const item = (n: number, reviewerId = REVIEWER): ReviewItem => ({
  itemId: `item-${n}`,
  campaignId: campaign.campaignId,
  identityId: `id-${n}`,
  identityName: `Person ${n}`,
  identityEmail: `person.${n}@corp.example`,
  reviewerId,
  entitlements: [],
  decision: 'pending',
});

/** The page and limit the API was asked for on its last call to a path containing `part`. */
function lastPaging(part: string) {
  const url = mockGet.mock.calls
    .map(([u]) => u as string)
    .filter((u) => u.includes(part))
    .at(-1);
  const params = new URLSearchParams(url!.split('?')[1]);
  return { page: params.get('page'), limit: params.get('limit') };
}

const asRole = (role: string) => ({
  ...mockAuthValue,
  user: { ...mockAuthValue.user, profile: { ...mockAuthValue.user.profile, roles: [role] } },
});

function answer(
  itemsOf: (page: number) => ReviewItem[],
  campaignsTotal = 1,
  status: ReviewCampaign['status'] = 'ACTIVE',
) {
  mockGet.mockImplementation((url: string) => {
    const page = Number(new URLSearchParams(url.split('?')[1]).get('page') ?? 0);
    if (url.includes('/items'))
      return Promise.resolve({ data: { data: itemsOf(page), total: 350 } });
    if (url.includes(`/campaigns/${campaign.campaignId}`))
      return Promise.resolve({ data: { ...campaign, status } });
    if (url.includes('/campaigns'))
      return Promise.resolve({ data: { data: [{ ...campaign, status }], total: campaignsTotal } });
    return Promise.resolve({ data: { data: [], total: 0 } });
  });
}

async function openCampaign(authValue = mockAuthValue) {
  const user = userEvent.setup();
  renderWithProviders(<AccessReviews />, { authValue });
  const row = (await screen.findByText('Q4 2026 access certification')).closest('tr')!;
  await user.click(within(row).getByRole('button', { name: 'View' }));
  const dialog = await screen.findByRole('dialog');
  return { user, dialog };
}

beforeEach(() => {
  vi.clearAllMocks();
  answer((page) => [item(page * 20 + 1), item(page * 20 + 2)]);
});

describe('AccessReviews paging', () => {
  it("pages through a campaign's items with the API's total", { timeout: 20_000 }, async () => {
    const { user, dialog } = await openCampaign();
    await within(dialog).findByText('Person 1');
    expect(lastPaging('/items')).toEqual({ page: '0', limit: '20' });

    await user.click(within(dialog).getByTitle('2'));

    expect(await within(dialog).findByText('Person 21')).toBeInTheDocument();
    expect(lastPaging('/items')).toEqual({ page: '1', limit: '20' });
    // 350 items at 20 a page
    expect(within(dialog).getByTitle('18')).toBeInTheDocument();
  });

  it('pages the campaigns list', async () => {
    answer(() => [], 45);
    renderWithProviders(<AccessReviews />);
    await screen.findByText('Q4 2026 access certification');

    expect(lastPaging('/campaigns?')).toEqual({ page: '0', limit: '20' });
    expect(screen.getByTitle('3')).toBeInTheDocument();
  });
});

describe('AccessReviews when the campaigns cannot be loaded', () => {
  it('says so instead of "No campaigns yet"', async () => {
    mockGet.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 500'), {
        response: { status: 500, data: { message: 'Operation failed' } },
      }),
    );
    renderWithProviders(<AccessReviews />);

    expect(await screen.findByText('Campaigns could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/No campaigns yet/)).toBeNull();
  });
});

describe('AccessReviews reviewer match', () => {
  it('offers the decision on an item whose stored reviewer differs only in case', async () => {
    answer(() => [item(1, REVIEWER.toUpperCase())]);
    const { dialog } = await openCampaign();

    const row = (await within(dialog).findByText('Person 1')).closest('tr')!;
    expect(within(row).getByRole('button', { name: /Approve/ })).toBeInTheDocument();
  });
});

describe('AccessReviews role gates', () => {
  it('offers a policy admin no Activate on a draft', async () => {
    answer(() => [], 1, 'DRAFT');
    const { dialog } = await openCampaign(asRole('policy-admin'));
    await within(dialog).findByText('DRAFT');
    expect(within(dialog).queryByRole('button', { name: /Activate/ })).toBeNull();
  });

  it('offers Activate on a draft to a super-admin', async () => {
    answer(() => [], 1, 'DRAFT');
    const { dialog } = await openCampaign();
    expect(await within(dialog).findByRole('button', { name: /Activate/ })).toBeInTheDocument();
  });

  it('shows a viewer no Create Campaign, Approve or Revoke', async () => {
    const { dialog } = await openCampaign(asRole('viewer'));
    const row = (await within(dialog).findByText('Person 1')).closest('tr')!;

    expect(within(row).queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(within(row).queryByRole('button', { name: /Revoke/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Create Campaign/ })).toBeNull();
  });

  it('shows a policy admin Create Campaign and the decisions', async () => {
    const { dialog } = await openCampaign(asRole('policy-admin'));
    const row = (await within(dialog).findByText('Person 1')).closest('tr')!;

    expect(within(row).getByRole('button', { name: /Approve/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create Campaign/ })).toBeInTheDocument(),
    );
  });
});
