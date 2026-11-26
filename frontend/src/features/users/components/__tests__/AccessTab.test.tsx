/**
 * The Access tab shows the expired access the expiry run could not remove at the top, and only
 * when there is some: without, it leaves no empty space. Access revoked in access reviews (review
 * exclusions) is shown the same way: only when the identity has some. Activating a linked admin
 * account says how it went in a toast of the app (App.useApp), in the app's theme.
 */
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { message } from 'antd';
import { renderWithProviders, mockAuthValue } from '../../../../test/test-utils';
import dayjs from 'dayjs';
import { AccessTab } from '../AccessTab';
import { API_BASE } from '@api/constants';
import { useFailedExpiries } from '@api/expired-access-api';
import { useReviewExclusions } from '@api/review-exclusions-api';

const ID = '64b7f0c2a1b2c3d4e5f60720';
const EXPIRED = '2026-11-20T10:00:00.000Z';
const EXPIRES_AT = '2026-11-25T18:00:00.000Z';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args), post: vi.fn() },
}));
const mockLinked = vi.fn();
const mockActivate = vi.fn();
vi.mock('@api/privileged-access-api', () => ({
  useLinkedAdminAccounts: () => mockLinked(),
  useActivateAdminAccount: () => ({ mutateAsync: mockActivate, isPending: false }),
  useDeactivateAdminAccount: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../AccessReevaluationPanel', () => ({
  AccessReevaluationPanel: () => <div>Re-evaluate panel</div>,
}));
/** Whether usePermission grants the role asked for; a test of a viewer turns it off. */
const permission = vi.hoisted(() => ({ granted: true }));
vi.mock('../../../../auth/usePermission', () => ({ usePermission: () => permission.granted }));

function answer(provisioning: unknown[], exclusions: unknown[] = []) {
  mockGet.mockImplementation(async (url: string) =>
    url === `${API_BASE}/identity/v2/${ID}`
      ? { data: { found: true, identity: { _id: ID, provisioning } } }
      : url === `${API_BASE}/identity/${ID}/access/review-exclusions`
        ? { data: { identityId: ID, exclusions } }
        : { data: { identityId: ID, entitlements: [] } },
  );
}

/** The items of the tab's own vertical Space (the outermost one), each should hold something. */
const spaceItems = (container: HTMLElement) =>
  Array.from(container.querySelector('.ant-space-vertical')?.children ?? []).filter((el) =>
    el.classList.contains('ant-space-item'),
  );

/**
 * Rendered once the answers that decide what the tab shows have arrived: it reads the same
 * queries, so it appears in the same render as the tab's answer.
 */
function Answered() {
  const expired = useFailedExpiries(ID);
  const exclusions = useReviewExclusions(ID);
  return expired.isSuccess && exclusions.isSuccess ? <span data-testid="answered" /> : null;
}

beforeEach(() => {
  mockLinked.mockReset().mockReturnValue({ data: [], isLoading: false });
  mockActivate.mockReset();
});

describe('AccessTab expired access', () => {
  beforeEach(() => mockGet.mockReset());

  it('shows a failed expiry first', async () => {
    answer([
      {
        targetSystem: 'okta',
        status: 'SYNCED',
        expiresAt: EXPIRED,
        expiryFailure: {
          expiresAt: EXPIRED,
          failedAt: EXPIRED,
          reason: 'okta: Request failed with status code 403 (HTTP 403)',
          retryable: false,
          attempts: 1,
        },
      },
    ]);
    const { container } = renderWithProviders(<AccessTab identityId={ID} />);

    expect(await screen.findByText('Expired access not removed')).toBeInTheDocument();
    expect(spaceItems(container)[0]).toHaveTextContent('Expired access not removed');
  });

  it('leaves no empty space without one', async () => {
    answer([{ targetSystem: 'okta', status: 'DEPROVISIONED', expiresAt: EXPIRED }]);
    const { container } = renderWithProviders(
      <>
        <AccessTab identityId={ID} />
        <Answered />
      </>,
    );

    await screen.findByText('Re-evaluate panel');
    await screen.findByTestId('answered');
    expect(mockGet).toHaveBeenCalledWith(`${API_BASE}/identity/v2/${ID}`);
    expect(screen.queryByText('Expired access not removed')).toBeNull();
    const items = spaceItems(container);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.childElementCount).toBeGreaterThan(0);
  });
});

describe('AccessTab review exclusions', () => {
  beforeEach(() => mockGet.mockReset());

  it('shows access revoked in access reviews when the identity has some', async () => {
    answer(
      [],
      [
        {
          _id: '64b7f0c2a1b2c3d4e5f60b01',
          identityId: ID,
          targetSystem: 'entra-id',
          scope: 'entitlement',
          entitlementType: 'group',
          entitlementName: 'SG-Sales',
          campaignId: 'c0a80101-0000-4000-8000-000000000001',
          campaignName: 'Q4 review',
          itemId: 'c0a80101-0000-4000-8000-0000000000a1',
          decision: 'revoked',
          reviewer: 'manager@acme.example',
          justification: 'Moved to Engineering',
          decidedAt: EXPIRED,
          grantingPolicies: [],
          status: 'active',
        },
      ],
    );
    renderWithProviders(<AccessTab identityId={ID} />);

    expect(await screen.findByText('Revoked in access reviews')).toBeInTheDocument();
    expect(screen.getByText('SG-Sales')).toBeInTheDocument();
  });
});

describe('AccessTab linked admin accounts', () => {
  const ADMIN_ID = '64b7f0c2a1b2c3d4e5f60721';

  beforeEach(() => {
    mockGet.mockReset();
    answer([]);
    // GET /privileged-access/accounts/:parentId/linked as the backend answers it
    mockLinked.mockReturnValue({
      data: [{ identityId: ADMIN_ID, adminTier: 'TIER_0', status: 'INACTIVE' }],
      isLoading: false,
    });
  });

  it.each([
    [
      'activated',
      () => mockActivate.mockResolvedValue({ state: 'ACTIVE', expiresAt: EXPIRES_AT }),
      `Admin account active until ${dayjs(EXPIRES_AT).format('YYYY-MM-DD HH:mm')}`,
    ],
    [
      'still activating',
      () => mockActivate.mockResolvedValue({ state: 'ACTIVATING' }),
      'Activating: the admin accounts are being enabled in the target systems',
    ],
    [
      'refused',
      () => mockActivate.mockRejectedValue(new Error('Request failed with status code 409')),
      'Failed to activate admin account',
    ],
    [
      'not enabled, with the reason',
      () =>
        mockActivate.mockRejectedValue(
          Object.assign(new Error('Request failed with status code 502'), {
            response: {
              data: { message: 'Activation failed: ad: refused. Nothing stays enabled.' },
            },
          }),
        ),
      'Activation failed: ad: refused. Nothing stays enabled.',
    ],
  ])('says in a toast of the app that the account was %s', async (_label, answerWith, toast) => {
    // The static antd message renders outside the app's theme: it must not be used
    const staticToasts = [vi.spyOn(message, 'success'), vi.spyOn(message, 'error')];
    answerWith();
    const user = userEvent.setup();
    renderWithProviders(<AccessTab identityId={ID} />);

    await user.click(await screen.findByRole('button', { name: 'Activate' }));

    expect(await screen.findByText(toast)).toBeInTheDocument();
    expect(mockActivate).toHaveBeenCalledWith(ADMIN_ID);
    for (const spy of staticToasts) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
  it("shows the linked admin account's session as the API reports it", async () => {
    mockLinked.mockReturnValue({
      data: [{ identityId: ADMIN_ID, adminTier: 'TIER_0', status: 'ACTIVATING' }],
      isLoading: false,
    });
    renderWithProviders(<AccessTab identityId={ID} />);

    expect(await screen.findByText('Activating')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });

  // 09 F10: only the account's own person or a connector-admin may run its session.
  it.each([
    ['the identity itself', 'Maija@corp.example', true],
    ['another viewer', 'olli@corp.example', false],
  ])('offers Activate to %s: %s', async (_label, email, offered) => {
    permission.granted = false;
    onTestFinished(() => {
      permission.granted = true;
    });
    const viewer = {
      ...mockAuthValue,
      user: {
        ...mockAuthValue.user,
        profile: { ...mockAuthValue.user.profile, email, roles: ['viewer'] },
      },
    };
    renderWithProviders(<AccessTab identityId={ID} identityEmail="maija@corp.example" />, {
      authValue: viewer,
    });

    expect(await screen.findByText('TIER_0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' }) !== null).toBe(offered);
  });
});
