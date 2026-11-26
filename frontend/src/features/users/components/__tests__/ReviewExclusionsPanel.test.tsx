/**
 * Access revoked in access reviews, on the Access tab: each active exclusion with its system,
 * entitlement (an account item as the whole system), campaign, reviewer (or the deadline for an
 * auto-revoke), justification and date. Only a policy-admin is offered [Lift exclusion], as on
 * the backend, and the lift is sent only after the confirmation; the message says which run that
 * gives the access back started (the re-evaluation; for an account, onboarding), or why none did;
 * the API's own error message is shown. Nothing is rendered without exclusions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../../test/test-utils';
import { ReviewExclusionsPanel } from '../ReviewExclusionsPanel';
import { usePermission } from '../../../../auth/usePermission';
import { API_BASE } from '@api/constants';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));
vi.mock('../../../../auth/usePermission', () => ({ usePermission: vi.fn() }));

const ID = '64b7f0c2a1b2c3d4e5f60a01';
const LIST = `${API_BASE}/identity/${ID}/access/review-exclusions`;

/** GET /identity/:id/access/review-exclusions as the API answers it. */
const SALES = {
  _id: '64b7f0c2a1b2c3d4e5f60b01',
  identityId: ID,
  targetSystem: 'entra-id',
  scope: 'entitlement',
  entitlementType: 'group',
  entitlementName: 'SG-Sales',
  entitlementId: '8d0f6c1e-0000-4000-8000-000000000001',
  campaignId: 'c0a80101-0000-4000-8000-000000000001',
  campaignName: 'Q4 review',
  itemId: 'c0a80101-0000-4000-8000-0000000000a1',
  decision: 'revoked',
  reviewer: 'manager@acme.example',
  justification: 'Moved to Engineering',
  decidedAt: '2026-11-20T10:00:00.000Z',
  grantingPolicies: [{ policyId: '64b7f0c2a1b2c3d4e5f60900', policyName: 'Sales baseline' }],
  status: 'active',
  createdAt: '2026-11-21T12:00:00.000Z',
  updatedAt: '2026-11-21T12:00:00.000Z',
};
const GITHUB = {
  ...SALES,
  _id: '64b7f0c2a1b2c3d4e5f60b02',
  targetSystem: 'github',
  scope: 'account',
  entitlementType: 'account',
  entitlementName: 'Account',
  entitlementId: undefined,
  decision: 'expired',
  reviewer: undefined,
  justification: undefined,
  decidedAt: undefined,
};

const answer = (exclusions: unknown[]) =>
  mockGet.mockResolvedValue({ data: { identityId: ID, exclusions } });

const GRANTS: Record<string, string[]> = {
  viewer: ['viewer'],
  operator: ['viewer', 'operator'],
  'policy-admin': ['viewer', 'operator', 'policy-admin'],
};
const signInAs = (role: string) =>
  vi
    .mocked(usePermission)
    .mockImplementation((required: string) => GRANTS[role].includes(required));

const row = async (text: string) => (await screen.findByText(text)).closest('tr') as HTMLElement;

describe('ReviewExclusionsPanel', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset().mockResolvedValue({
      data: {
        exclusion: { ...SALES, status: 'lifted' },
        run: { type: 'reevaluation', started: true, workflowId: 't-dev-tenant-mover-x' },
      },
    });
    answer([SALES, GITHUB]);
    signInAs('policy-admin');
  });

  it('lists system, entitlement, campaign, reviewer, justification and date', async () => {
    renderWithProviders(<ReviewExclusionsPanel identityId={ID} />);

    const sales = await row('SG-Sales');
    expect(mockGet).toHaveBeenCalledWith(LIST);
    expect(screen.getByText('Revoked in access reviews')).toBeInTheDocument();
    for (const text of [
      'entra-id',
      'Q4 review',
      'manager@acme.example',
      'Moved to Engineering',
      '2026-11-20',
    ]) {
      expect(within(sales).getByText(text)).toBeInTheDocument();
    }
    const github = await row('Account (all access in github)');
    expect(
      within(github).getByText('Not reviewed by the deadline (auto-revoked)'),
    ).toBeInTheDocument();
    expect(within(github).getByText('2026-11-21')).toBeInTheDocument();
  });

  it.each([
    ['viewer', false],
    ['operator', false],
    ['policy-admin', true],
  ])('%s: offered lift %s', async (role, offered) => {
    signInAs(role);
    renderWithProviders(<ReviewExclusionsPanel identityId={ID} />);
    const sales = await row('SG-Sales');
    expect(within(sales).queryByRole('button', { name: /lift exclusion/i }) !== null).toBe(offered);
  });

  it('a policy-admin lifts an exclusion after confirming', async () => {
    renderWithProviders(<ReviewExclusionsPanel identityId={ID} />);
    await userEvent.click(
      within(await row('SG-Sales')).getByRole('button', { name: 'Lift exclusion: SG-Sales' }),
    );

    const dialog = (
      await screen.findByText('Lift exclusion: SG-Sales', {
        selector: '.ant-modal-confirm-title',
      })
    ).closest('.ant-modal') as HTMLElement;
    expect(within(dialog).getByText(/re-evaluated now/)).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
    answer([GITHUB]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lift exclusion' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(`${LIST}/${SALES._id}/lift`, {}));
    expect(
      await screen.findByText(
        'Exclusion lifted: SG-Sales in entra-id. Re-evaluation started: the access comes back.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('SG-Sales')).toBeNull());
  });

  it('says why the re-evaluation did not start, the lift done', async () => {
    mockPost.mockResolvedValue({
      data: {
        exclusion: { ...SALES, status: 'lifted' },
        run: {
          type: 'reevaluation',
          started: false,
          reason: 'A mover run for this identity is already in progress.',
        },
      },
    });
    renderWithProviders(<ReviewExclusionsPanel identityId={ID} />);
    await userEvent.click(
      within(await row('SG-Sales')).getByRole('button', { name: 'Lift exclusion: SG-Sales' }),
    );
    const dialog = (
      await screen.findByText('Lift exclusion: SG-Sales', {
        selector: '.ant-modal-confirm-title',
      })
    ).closest('.ant-modal') as HTMLElement;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lift exclusion' }));

    expect(
      await screen.findByText(
        'Exclusion lifted: SG-Sales in entra-id. The re-evaluation did not start: ' +
          'A mover run for this identity is already in progress.',
      ),
    ).toBeInTheDocument();
  });

  it('starts onboarding for a lifted account, which creates it again', async () => {
    mockPost.mockResolvedValue({
      data: {
        exclusion: { ...GITHUB, status: 'lifted' },
        run: { type: 'onboarding', started: true, workflowId: 't-dev-tenant-onboard-x' },
      },
    });
    renderWithProviders(<ReviewExclusionsPanel identityId={ID} />);
    await userEvent.click(
      within(await row('Account (all access in github)')).getByRole('button', {
        name: 'Lift exclusion: Account (all access in github)',
      }),
    );
    const dialog = (
      await screen.findByText('Lift exclusion: Account (all access in github)', {
        selector: '.ant-modal-confirm-title',
      })
    ).closest('.ant-modal') as HTMLElement;
    expect(within(dialog).getByText(/creates the account in github/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lift exclusion' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(`${LIST}/${GITHUB._id}/lift`, {}));
    expect(
      await screen.findByText(
        'Exclusion lifted: the account in github. ' +
          'Onboarding started: the account is created again.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the API’s error when the lift is refused', async () => {
    mockPost.mockRejectedValue({
      response: { data: { message: 'This review exclusion was already lifted' } },
    });
    renderWithProviders(<ReviewExclusionsPanel identityId={ID} />);
    await userEvent.click(
      within(await row('SG-Sales')).getByRole('button', { name: 'Lift exclusion: SG-Sales' }),
    );
    const dialog = (
      await screen.findByText('Lift exclusion: SG-Sales', {
        selector: '.ant-modal-confirm-title',
      })
    ).closest('.ant-modal') as HTMLElement;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lift exclusion' }));

    expect(
      await screen.findByText('Not lifted: This review exclusion was already lifted'),
    ).toBeInTheDocument();
  });

  it('shows nothing when the identity has no exclusions', async () => {
    answer([]);
    const { container } = renderWithProviders(<ReviewExclusionsPanel identityId={ID} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(LIST));
    await new Promise((resolve) => setTimeout(resolve, 50)); // the answer is rendered
    expect(container.textContent).toBe('');
  });

  it('says when the exclusions cannot be loaded', async () => {
    mockGet.mockRejectedValue(new Error('Network Error'));
    renderWithProviders(<ReviewExclusionsPanel identityId={ID} />);
    expect(await screen.findByText('Could not load access review exclusions')).toBeInTheDocument();
  });
});
