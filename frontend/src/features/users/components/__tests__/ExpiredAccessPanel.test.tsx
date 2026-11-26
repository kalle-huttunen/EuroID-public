/**
 * Expired access the expiry run could not remove, on the Access tab: only entries with a failed
 * expiry for their current expiry date and not DEPROVISIONED are shown, with why and what the run
 * does next. An operator can retry (after a confirmation); a policy-admin can also record a
 * removal by hand (note required), as on the backend; a viewer only sees them. The API's own
 * error message is shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../../test/test-utils';
import { ExpiredAccessPanel } from '../ExpiredAccessPanel';
import { usePermission } from '../../../../auth/usePermission';
import { API_BASE } from '@api/constants';
import { useFailedExpiries } from '@api/expired-access-api';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));
vi.mock('../../../../auth/usePermission', () => ({ usePermission: vi.fn() }));

const ID = '64b7f0c2a1b2c3d4e5f60720';
const EXPIRED = '2026-11-20T10:00:00.000Z';
const failure = (over: Record<string, unknown> = {}) => ({
  expiresAt: EXPIRED,
  failedAt: '2026-11-20T11:00:00.000Z',
  reason: 'okta: Request failed with status code 403 (HTTP 403)',
  retryable: false,
  attempts: 1,
  ...over,
});

/** GET /identity/v2/:id as the API answers it (the whole identity document). */
function identityWith(provisioning: unknown[]) {
  return { data: { found: true, identity: { _id: ID, profile: {}, provisioning } } };
}

const PROVISIONING = [
  { targetSystem: 'okta', status: 'SYNCED', expiresAt: EXPIRED, expiryFailure: failure() },
  {
    targetSystem: 'scim',
    status: 'SYNCED',
    expiresAt: EXPIRED,
    expiryFailure: failure({
      reason: 'scim: Request failed with status code 503',
      retryable: true,
      attempts: 2,
      nextAttemptAt: '2026-11-20T14:00:00.000Z',
    }),
  },
  // Closed, a failure for an earlier expiry date, no failure: not shown
  {
    targetSystem: 'entra-id',
    status: 'DEPROVISIONED',
    expiresAt: EXPIRED,
    expiryFailure: failure(),
  },
  {
    targetSystem: 'github',
    status: 'SYNCED',
    expiresAt: '2026-12-01T10:00:00.000Z',
    expiryFailure: failure(),
  },
  { targetSystem: 'ad', status: 'SYNCED', expiresAt: EXPIRED },
];

/** usePermission for a user with `role`, with the role hierarchy up to policy-admin. */
const GRANTS: Record<string, string[]> = {
  viewer: ['viewer'],
  operator: ['viewer', 'operator'],
  'policy-admin': ['viewer', 'operator', 'policy-admin'],
};
const signInAs = (role: string) =>
  vi
    .mocked(usePermission)
    .mockImplementation((required: string) => GRANTS[role].includes(required));

const group = (system: string) =>
  screen.findByRole('group', { name: `Expired access in ${system}` });

/** Rendered once the panel's answer has arrived: it reads the same query, in the same render. */
function Answered() {
  return useFailedExpiries(ID).isSuccess ? <span data-testid="answered" /> : null;
}

describe('ExpiredAccessPanel', () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue(identityWith(PROVISIONING));
    mockPost.mockReset().mockResolvedValue({ data: {} });
    signInAs('operator');
  });

  it('shows only expired access with a failed removal, why it failed and what happens next', async () => {
    renderWithProviders(<ExpiredAccessPanel identityId={ID} />);

    const okta = await group('okta');
    expect(mockGet).toHaveBeenCalledWith(`${API_BASE}/identity/v2/${ID}`);
    expect(screen.getByText('Expired access not removed')).toBeInTheDocument();
    expect(
      within(okta).getByText('okta: Request failed with status code 403 (HTTP 403)'),
    ).toBeInTheDocument();
    expect(
      within(okta).getByText(/^Not tried again automatically \(1 failed attempt,/),
    ).toBeInTheDocument();
    const scim = await group('scim');
    expect(
      within(scim).getByText(/^Tried again automatically from .* \(2 failed attempts,/),
    ).toBeInTheDocument();
    for (const system of ['entra-id', 'github', 'ad']) {
      expect(screen.queryByRole('group', { name: `Expired access in ${system}` })).toBeNull();
    }
  });

  it('shows nothing when no expired access is left', async () => {
    mockGet.mockResolvedValue(identityWith(PROVISIONING.slice(2)));
    const { container } = renderWithProviders(
      <>
        <ExpiredAccessPanel identityId={ID} />
        <Answered />
      </>,
    );
    await screen.findByTestId('answered');
    expect(mockGet).toHaveBeenCalled();
    expect(screen.queryByText('Expired access not removed')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it.each([
    ['viewer', false, false],
    ['operator', true, false],
    ['policy-admin', true, true],
  ])('%s: offered retry %s, removed manually %s', async (role, retry, close) => {
    signInAs(role);
    renderWithProviders(<ExpiredAccessPanel identityId={ID} />);
    const okta = await group('okta');
    expect(within(okta).queryByRole('button', { name: /retry removal/i }) !== null).toBe(retry);
    expect(within(okta).queryByRole('button', { name: /mark removed manually/i }) !== null).toBe(
      close,
    );
  });

  it('an operator retries after confirming', async () => {
    renderWithProviders(<ExpiredAccessPanel identityId={ID} />);
    await userEvent.click(
      within(await group('okta')).getByRole('button', { name: /retry removal/i }),
    );

    const dialog = await screen.findByRole('dialog', {
      name: 'Retry removing expired access: okta',
    });
    expect(mockPost).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry removal' }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`${API_BASE}/identity/${ID}/access/expiry/retry`, {
        targetSystem: 'okta',
      }),
    );
    expect(await screen.findByText('okta: the next expiry run tries again')).toBeInTheDocument();
  });

  it('records a removal by hand only with a note, and shows the API’s error', async () => {
    signInAs('policy-admin');
    mockPost.mockRejectedValueOnce({
      response: {
        data: { message: 'okta changed meanwhile (removed, retried or closed by someone else).' },
      },
    });
    renderWithProviders(<ExpiredAccessPanel identityId={ID} />);
    await userEvent.click(
      within(await group('okta')).getByRole('button', { name: /mark removed manually/i }),
    );

    const dialog = await screen.findByRole('dialog');
    const ok = within(dialog).getByRole('button', { name: 'Record as removed manually' });
    expect(ok).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Removal note'), 'Deactivated in Okta');
    expect(ok).toBeEnabled();

    await userEvent.click(ok);
    expect(
      await screen.findByText(
        'Not recorded: okta changed meanwhile (removed, retried or closed by someone else).',
      ),
    ).toBeInTheDocument();

    await userEvent.click(ok);
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost).toHaveBeenLastCalledWith(
      `${API_BASE}/identity/${ID}/access/expiry/removed-manually`,
      { targetSystem: 'okta', reason: 'Deactivated in Okta' },
    );
    expect(await screen.findByText('okta recorded as removed manually')).toBeInTheDocument();
  });
});
