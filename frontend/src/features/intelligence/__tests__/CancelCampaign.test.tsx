/**
 * Cancelling a campaign from its row (POST /access-reviews/campaigns/:id/cancel, super-admin).
 * The route takes the campaign's `campaignId` (a UUID), not the document `_id`; it cancels DRAFT
 * and ACTIVE campaigns only. The dialog says what happens to the items (and to a recurring
 * campaign's recurrence), requires a reason, shows the API's own message on a refusal and reloads
 * the list either way.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { AccessReviews } from '../AccessReviews';
import type { CampaignStatus, ReviewCampaign, ReviewItem } from '@api/intelligence-api';

// The backend allows the cancel to super-admin only (access-review.controller.ts).
const GRANTS: Record<string, string[]> = {
  'super-admin': ['super-admin', 'policy-admin', 'operator', 'viewer'],
  'policy-admin': ['policy-admin', 'operator', 'viewer'],
};
let mockRole = 'super-admin';
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => GRANTS[mockRole].includes(role),
}));

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

/** As GET /access-reviews/campaigns lists it: the Mongo `_id` and the public `campaignId`. */
function campaign(
  key: number,
  name: string,
  status: CampaignStatus,
  extra: Partial<ReviewCampaign> = {},
): ReviewCampaign {
  return {
    _id: `665f1c2a1b2c3d4e5f60718${key}`,
    campaignId: `4b4e1f0e-6c1b-4f5e-9a51-0c2a6b9d000${key}`,
    name,
    scope: { type: 'department', value: 'Engineering' },
    status,
    createdBy: 'admin@euroid.local',
    deadline: '2026-12-08T00:00:00.000Z',
    autoRevokeOnExpiry: false,
    stats: { totalItems: 0, approved: 0, revoked: 0, pending: 0, expired: 0 },
    ...extra,
  };
}

const ACTIVE = campaign(1, 'Q4 2026 access review: Engineering', 'ACTIVE', {
  autoRevokeOnExpiry: true,
  escalation: { enabled: true, escalateAfterDays: 7, escalateTo: 'MANAGER' },
  stats: { totalItems: 9, approved: 4, revoked: 2, pending: 3, expired: 0 },
});
const DRAFT = campaign(2, 'Q1 2027 access review: Sales', 'DRAFT');
const COMPLETED = campaign(3, 'Q3 2026 certification: Finance', 'COMPLETED');
const CANCELLED = campaign(4, 'Q3 2026 access review: Support', 'CANCELLED');
const RECURRING = campaign(5, 'Quarterly review: Finance - 2026-10', 'ACTIVE', {
  recurrence: { enabled: true, frequency: 'QUARTERLY', previousCampaignId: 'prev-campaign' },
});

let listed: ReviewCampaign[];

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = 'super-admin';
  listed = [ACTIVE, DRAFT, COMPLETED, CANCELLED];
  mockGet.mockImplementation((url: string) =>
    url.includes('/access-reviews/campaigns?')
      ? Promise.resolve({ data: { data: listed, total: listed.length } })
      : Promise.resolve({ data: { data: [], total: 0 } }),
  );
});

/** The table row of a campaign (its name also shows in the open dialog). */
const rowOf = async (name: string) =>
  (await screen.findAllByText(name)).map((el) => el.closest('tr')).find(Boolean)!;
const cancelButton = (row: HTMLElement) =>
  within(row).queryByRole('button', { name: /Cancel campaign/ });
const dialogTitle = () => screen.queryByText('Cancel campaign', { selector: '.ant-modal-title' });
const campaignListCalls = () =>
  mockGet.mock.calls.filter(([url]) => String(url).includes('/access-reviews/campaigns?')).length;

async function openCancel(name: string) {
  const user = userEvent.setup();
  renderWithProviders(<AccessReviews />);
  await user.click(cancelButton(await rowOf(name))!);
  return { user, dialog: await screen.findByRole('dialog') };
}

describe('Cancel campaign: the row action', () => {
  it('a super-admin can cancel DRAFT and ACTIVE campaigns only', async () => {
    renderWithProviders(<AccessReviews />);

    expect(cancelButton(await rowOf(ACTIVE.name))).toBeInTheDocument();
    expect(cancelButton(await rowOf(DRAFT.name))).toBeInTheDocument();
    expect(cancelButton(await rowOf(COMPLETED.name))).toBeNull();
    expect(cancelButton(await rowOf(CANCELLED.name))).toBeNull();
  });

  it('is not offered below super-admin (the route answers 403)', async () => {
    mockRole = 'policy-admin';
    renderWithProviders(<AccessReviews />);

    expect(cancelButton(await rowOf(ACTIVE.name))).toBeNull();
    expect(cancelButton(await rowOf(DRAFT.name))).toBeNull();
    // The row keeps its other actions
    expect(within(await rowOf(ACTIVE.name)).getByRole('button', { name: 'View' })).toBeVisible();
  });
});

describe('Cancel campaign: the dialog', () => {
  it('says what happens to open items and to revokes already decided', async () => {
    const { dialog } = await openCancel(ACTIVE.name);

    expect(within(dialog).getByText(ACTIVE.name)).toBeInTheDocument();
    expect(dialog).toHaveTextContent('It stops now and cannot be activated again.');
    expect(dialog).toHaveTextContent(
      'Open items (3) are closed to reviewers: they leave My Reviews and can no longer be ' +
        'decided. They are no longer escalated, expired at the deadline or auto-revoked;',
    );
    expect(dialog).toHaveTextContent(
      'Access already decided as revoked (2) is not removed: EuroID removes revoked access only ' +
        'when a campaign closes, and a cancelled campaign never closes.',
    );
  });

  it('says that cancelling a recurring campaign ends the recurrence', async () => {
    listed = [RECURRING, ACTIVE];
    const recurringDialog = (await openCancel(RECURRING.name)).dialog;

    expect(recurringDialog).toHaveTextContent(
      'It stops now and cannot be activated again. It also ends the recurrence: no next ' +
        'campaign is created.',
    );
  });

  it('says nothing of a recurrence for a campaign without one', async () => {
    const { dialog } = await openCancel(ACTIVE.name);

    expect(dialog).not.toHaveTextContent('recurrence');
  });

  it('a draft has no items to speak of', async () => {
    const { dialog } = await openCancel(DRAFT.name);

    expect(dialog).toHaveTextContent('The draft has no review items yet');
    expect(dialog).not.toHaveTextContent('Open items');
  });

  it('requires a reason', async () => {
    const { user, dialog } = await openCancel(ACTIVE.name);

    await user.type(within(dialog).getByLabelText('Reason'), '   ');
    await user.click(within(dialog).getByRole('button', { name: /Cancel campaign/ }));

    expect(await within(dialog).findByText('A reason is required')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it(
    'cancels by campaignId with the reason, then the list shows it cancelled',
    { timeout: 20_000 },
    async () => {
      mockPost.mockImplementation(() => {
        const after = { ...ACTIVE, status: 'CANCELLED' as const };
        listed = [after, DRAFT, COMPLETED, CANCELLED];
        return Promise.resolve({ data: after });
      });
      const { user, dialog } = await openCancel(ACTIVE.name);
      const listCallsBefore = campaignListCalls();

      await user.type(within(dialog).getByLabelText('Reason'), '  Duplicate of the Q4 review  ');
      await user.click(within(dialog).getByRole('button', { name: /Cancel campaign/ }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(`/access-reviews/campaigns/${ACTIVE.campaignId}/cancel$`),
          { reason: 'Duplicate of the Q4 review' },
        ),
      );
      expect(await screen.findByText(`Campaign cancelled: ${ACTIVE.name}`)).toBeInTheDocument();
      // The list is asked again (prefix key) and shows the campaign's new state
      await waitFor(() => expect(campaignListCalls()).toBeGreaterThan(listCallsBefore));
      const row = await rowOf(ACTIVE.name);
      await waitFor(() => expect(within(row).getByText('CANCELLED')).toBeInTheDocument());
      expect(cancelButton(row)).toBeNull();
      await waitFor(() => expect(dialogTitle()).not.toBeInTheDocument());
    },
  );

  it(
    "shows the API's refusal in the dialog and reloads the list",
    { timeout: 20_000 },
    async () => {
      mockPost.mockRejectedValue({
        response: {
          status: 400,
          data: { message: `Campaign ${ACTIVE.campaignId} cannot be cancelled` },
        },
      });
      const { user, dialog } = await openCancel(ACTIVE.name);
      const listCallsBefore = campaignListCalls();

      await user.type(within(dialog).getByLabelText('Reason'), 'Wrong scope');
      await user.click(within(dialog).getByRole('button', { name: /Cancel campaign/ }));

      expect(
        await within(dialog).findByText(
          `Not cancelled: Campaign ${ACTIVE.campaignId} cannot be cancelled`,
        ),
      ).toBeInTheDocument();
      await waitFor(() => expect(campaignListCalls()).toBeGreaterThan(listCallsBefore));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    },
  );

  it('Keep campaign closes the dialog without a request', async () => {
    const { user, dialog } = await openCancel(DRAFT.name);

    await user.click(within(dialog).getByRole('button', { name: 'Keep campaign' }));

    await waitFor(() => expect(dialogTitle()).not.toBeInTheDocument());
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('My Reviews after a cancel', () => {
  it(
    "a stale row of a cancelled campaign shows the API's 409 and leaves the list",
    { timeout: 20_000 },
    async () => {
      const item: ReviewItem = {
        itemId: 'item-1',
        campaignId: ACTIVE.campaignId,
        identityId: '64b7f0c2a1b2c3d4e5f60001',
        identityName: 'Riikka Tuominen',
        identityEmail: 'riikka.tuominen@corp.example',
        reviewerId: 'admin@euroid.local',
        entitlements: [
          { system: 'entra-id', type: 'group', name: 'SG-Engineering', policyManaged: false },
        ],
        decision: 'pending',
      };
      const refusal = `Campaign "${ACTIVE.name}" was cancelled: its items can no longer be decided`;
      let cancelled = false;
      mockGet.mockImplementation((url: string) => {
        if (url.includes('/my-reviews')) {
          const data = cancelled ? [] : [item];
          return Promise.resolve({ data: { data, total: data.length } });
        }
        return Promise.resolve({ data: { data: listed, total: listed.length } });
      });
      // The campaign was cancelled after the list loaded
      mockPost.mockImplementation(() => {
        cancelled = true;
        return Promise.reject({ response: { status: 409, data: { message: refusal } } });
      });
      const user = userEvent.setup();
      renderWithProviders(<AccessReviews />);

      await user.click(await screen.findByRole('tab', { name: 'My Reviews' }));
      const row = (await screen.findByText('Riikka Tuominen')).closest('tr')!;
      await user.click(within(row).getByRole('button', { name: /Approve/ }));

      expect(await screen.findByText(`Failed: ${refusal}`)).toBeInTheDocument();
      expect(await screen.findByText('No pending reviews assigned to you.')).toBeInTheDocument();
    },
  );
});
