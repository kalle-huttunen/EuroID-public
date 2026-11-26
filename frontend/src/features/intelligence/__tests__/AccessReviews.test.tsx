/**
 * The campaign detail modal lists the review items. With ten columns the items table was wider
 * than the 900 px modal and its last columns (the Approve and Revoke actions) spilled outside
 * it (plan 2.0co). The table now has fewer, fixed-width columns in a wider modal and scrolls
 * inside the modal when the screen is narrower than that.
 *
 * A campaign the API refuses (a `system` scope naming no known system) shows the API's reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
// The page's static antd toasts render under React 19 only with this, as in the app (index.tsx)
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
  deadline: '2026-12-06T00:00:00.000Z',
  autoRevokeOnExpiry: false,
  stats: { totalItems: 2, approved: 0, revoked: 1, pending: 1, expired: 0 },
};

const items: ReviewItem[] = [
  {
    itemId: 'item-1',
    campaignId: campaign.campaignId,
    identityId: 'id-1',
    identityName: 'Riikka Tuominen',
    identityEmail: 'riikka.tuominen@corp.example',
    reviewerId: REVIEWER,
    entitlements: [
      { system: 'entra-id', type: 'group', name: 'SG-Engineering', policyManaged: false },
      { system: 'active-directory', type: 'group', name: 'CN=Developers', policyManaged: false },
    ],
    decision: 'pending',
    previousDecision: 'APPROVED',
    previousDecisionDate: '2026-08-01T00:00:00.000Z',
  },
  {
    itemId: 'item-2',
    campaignId: campaign.campaignId,
    identityId: 'id-2',
    identityName: 'Tiina Ahonen',
    identityEmail: 'tiina.ahonen@corp.example',
    reviewerId: REVIEWER,
    entitlements: [{ system: 'okta', type: 'group', name: 'Okta-HR-Admins', policyManaged: false }],
    decision: 'revoked',
    decidedAt: '2026-11-22T09:42:00.000Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockImplementation((url: string) => {
    if (url.includes('/items'))
      return Promise.resolve({ data: { data: items, total: items.length } });
    if (url.includes(`/campaigns/${campaign.campaignId}`))
      return Promise.resolve({ data: campaign });
    if (url.includes('/campaigns'))
      return Promise.resolve({ data: { data: [campaign], total: 1 } });
    return Promise.resolve({ data: { data: [], total: 0 } });
  });
});

async function openCampaign() {
  const user = userEvent.setup();
  renderWithProviders(<AccessReviews />);
  const row = (await screen.findByText('Q4 2026 access certification')).closest('tr')!;
  await user.click(within(row).getByRole('button', { name: 'View' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('Riikka Tuominen');
  return dialog;
}

describe('AccessReviews campaign detail', () => {
  it('fits the review items into the modal: fixed columns, scrolling inside it when narrow', async () => {
    const dialog = await openCampaign();

    const table = within(dialog).getByText('Riikka Tuominen').closest('table')!;
    expect(table.style.tableLayout).toBe('fixed');
    expect(table.style.width).not.toBe('max-content');
    // The table scrolls inside the modal's own container, never past the modal.
    expect(table.closest('.ant-table-content')).toHaveStyle({ overflowX: 'auto' });
    expect(dialog.closest('.ant-modal')).toHaveStyle({ width: '1120px' });
  });

  it('shows fewer columns: name with email, decision with its date and earlier decision', async () => {
    const dialog = await openCampaign();

    expect(
      within(dialog)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Identity', 'Entitlements', 'Decision', 'Revocation', 'Reviewer', 'Actions']);
    const pending = within(dialog).getByText('Riikka Tuominen').closest('tr')!;
    expect(within(pending).getByText('riikka.tuominen@corp.example')).toBeInTheDocument();
    expect(within(pending).getByText('Previously certified 2026-08-01')).toBeInTheDocument();
    expect(within(pending).getByRole('button', { name: /Approve/ })).toBeInTheDocument();
    expect(within(pending).getByRole('button', { name: /Revoke/ })).toBeInTheDocument();

    const revoked = within(dialog).getByText('Tiina Ahonen').closest('tr')!;
    expect(within(revoked).getByText('revoked')).toBeInTheDocument();
    expect(within(revoked).getByText(/^2026-11-22 \d\d:42$/)).toBeInTheDocument();
  });
});

describe('AccessReviews My Reviews tab', () => {
  it('takes a decided item off the pending list', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    let decided = false;
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/my-reviews')) {
        const pending = decided ? [] : [items[0]];
        return Promise.resolve({ data: { data: pending, total: pending.length } });
      }
      if (url.includes('/campaigns'))
        return Promise.resolve({ data: { data: [campaign], total: 1 } });
      return Promise.resolve({ data: { data: [], total: 0 } });
    });
    mockPost.mockImplementation(() => {
      decided = true;
      return Promise.resolve({ data: { ...items[0], decision: 'approved' } });
    });
    renderWithProviders(<AccessReviews />);

    await user.click(await screen.findByRole('tab', { name: 'My Reviews' }));
    const row = (await screen.findByText('Riikka Tuominen')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /Approve/ }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringMatching(/\/access-reviews\/items\/item-1\/decide$/),
        expect.objectContaining({ decision: 'approved' }),
      ),
    );
    // The list is asked again: the invalidated key must match the pending-reviews query.
    expect(await screen.findByText('No pending reviews assigned to you.')).toBeInTheDocument();
  });
});

describe('AccessReviews create campaign', () => {
  it("shows the API's reason when a campaign cannot be created", { timeout: 20_000 }, async () => {
    const reason =
      'Scope system "file" is not a known system. Known systems: ad, discord-webhook, entra-id, ' +
      'file-outbound, github, google-sheets, okta, scim, servicenow.';
    mockPost.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { statusCode: 400, message: reason } },
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AccessReviews />);

    await user.click(await screen.findByRole('button', { name: /Create Campaign/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText('Campaign name'), 'File review');
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));

    expect(await screen.findByText(`Failed to create: ${reason}`)).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith(
      expect.stringMatching(/\/access-reviews\/campaigns$/),
      expect.objectContaining({ name: 'File review' }),
    );
  });
});

// At 400 px the Campaigns table (709 px) made the whole page scroll sideways; like the items
// tables, each table now scrolls inside its own container.
describe('AccessReviews tables on phones', () => {
  it('scrolls the campaigns table inside its card, not the page', async () => {
    renderWithProviders(<AccessReviews />);

    const table = (await screen.findByText('Q4 2026 access certification')).closest('table')!;
    expect(table.closest('.ant-table-content')).toHaveStyle({ overflowX: 'auto' });
    expect(table.style.width).toBe('900px');
  });

  it('scrolls the My Reviews table inside its card', { timeout: 20_000 }, async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/my-reviews'))
        return Promise.resolve({ data: { data: [items[0]], total: 1 } });
      if (url.includes('/campaigns'))
        return Promise.resolve({ data: { data: [campaign], total: 1 } });
      return Promise.resolve({ data: { data: [], total: 0 } });
    });
    const user = userEvent.setup();
    renderWithProviders(<AccessReviews />);

    await user.click(await screen.findByRole('tab', { name: 'My Reviews' }));
    const table = (await screen.findByText('Riikka Tuominen')).closest('table')!;
    expect(table.closest('.ant-table-content')).toHaveStyle({ overflowX: 'auto' });
  });
});
