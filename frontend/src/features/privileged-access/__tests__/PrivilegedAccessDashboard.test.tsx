import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { message } from 'antd';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
import { PrivilegedAccessDashboard } from '../PrivilegedAccessDashboard';
import type { AdminAccountRow } from '@api/privileged-access-api';
import dayjs from 'dayjs';

const mockGet = vi.fn();
const mockPut = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
    post: vi.fn(),
  },
}));

/** GET /privileged-access/admin-accounts as the backend answers it. */
const inactive: AdminAccountRow = {
  adminIdentityId: '64b7f0c2a1b2c3d4e5f60901',
  adminEmail: 'adm-maija@corp.example',
  parentIdentityId: '64b7f0c2a1b2c3d4e5f60001',
  parentEmail: 'maija@corp.example',
  adminTier: 'TIER_0',
  status: 'INACTIVE',
  parentDeleted: false,
};
const active: AdminAccountRow = {
  adminIdentityId: '64b7f0c2a1b2c3d4e5f60902',
  adminEmail: 'adm-olli@corp.example',
  parentIdentityId: '64b7f0c2a1b2c3d4e5f60002',
  parentEmail: 'olli@corp.example',
  adminTier: 'TIER_1',
  status: 'ACTIVE',
  activatedAt: '2026-11-20T10:00:00.000Z',
  parentDeleted: false,
};
/** Live admin identities whose parent identity was offboarded: the API refuses their activation. */
const orphanedPending: AdminAccountRow = {
  adminIdentityId: '64b7f0c2a1b2c3d4e5f60903',
  adminEmail: 'adm-bertta@corp.example',
  parentIdentityId: '64b7f0c2a1b2c3d4e5f60003',
  parentEmail: 'bertta@corp.example',
  adminTier: 'TIER_2',
  status: 'PENDING',
  parentDeleted: true,
};
const orphanedActive: AdminAccountRow = {
  ...orphanedPending,
  adminIdentityId: '64b7f0c2a1b2c3d4e5f60904',
  adminEmail: 'adm-lukas@corp.example',
  parentEmail: 'lukas@corp.example',
  status: 'ACTIVE',
};

/** The session end an activation answers, as the page writes it (local time). */
const EXPIRES_AT = '2026-11-25T18:00:00.000Z';
const untilText = (iso: string) => `until ${dayjs(iso).format('YYYY-MM-DD HH:mm')}`;

function serve(rows: AdminAccountRow[]) {
  mockGet.mockImplementation((url: string) =>
    url.endsWith('/privileged-access/admin-accounts')
      ? Promise.resolve({ data: rows })
      : Promise.reject(new Error(`unexpected GET ${url}`)),
  );
  // PUT .../activate answers ACTIVE once the session enabled every account
  mockPut.mockResolvedValue({ data: { state: 'ACTIVE', expiresAt: EXPIRES_AT } });
}

const rowOf = async (email: string) => (await screen.findByText(email)).closest('tr')!;

describe('PrivilegedAccessDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no admin accounts', async () => {
    serve([]);
    renderWithProviders(<PrivilegedAccessDashboard />);
    expect(await screen.findByText('No admin accounts yet')).toBeInTheDocument();
  });

  it('activates an inactive admin account and deactivates an active one by its own id', async () => {
    const user = userEvent.setup();
    serve([inactive, active]);
    renderWithProviders(<PrivilegedAccessDashboard />);

    const inactiveRow = await rowOf('adm-maija@corp.example');
    expect(within(inactiveRow).queryByRole('button', { name: 'Deactivate' })).toBeNull();
    await user.click(within(inactiveRow).getByRole('button', { name: 'Activate' }));
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        `/api/v1/privileged-access/admin-accounts/${inactive.adminIdentityId}/activate`,
      ),
    );

    const activeRow = await rowOf('adm-olli@corp.example');
    expect(within(activeRow).queryByRole('button', { name: 'Activate' })).toBeNull();
    await user.click(within(activeRow).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        `/api/v1/privileged-access/admin-accounts/${active.adminIdentityId}/deactivate`,
      ),
    );
    expect(mockPut).toHaveBeenCalledTimes(2);
  });

  it('offers no Activate on an account whose parent identity is deleted, only Deactivate while active', async () => {
    const user = userEvent.setup();
    serve([orphanedPending, orphanedActive]);
    renderWithProviders(<PrivilegedAccessDashboard />);

    const pendingRow = await rowOf('adm-bertta@corp.example');
    expect(within(pendingRow).getByText('Parent identity deleted')).toBeInTheDocument();
    expect(within(pendingRow).queryByRole('button', { name: 'Activate' })).toBeNull();
    expect(within(pendingRow).queryByRole('button', { name: 'Deactivate' })).toBeNull();

    const activeRow = await rowOf('adm-lukas@corp.example');
    expect(within(activeRow).getByText('Parent identity deleted')).toBeInTheDocument();
    expect(within(activeRow).queryByRole('button', { name: 'Activate' })).toBeNull();
    await user.click(within(activeRow).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        `/api/v1/privileged-access/admin-accounts/${orphanedActive.adminIdentityId}/deactivate`,
      ),
    );
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('says in a toast of the app how an activation went, in the app theme', async () => {
    // The static antd message renders outside the app's theme: it must not be used
    const staticToasts = [vi.spyOn(message, 'success'), vi.spyOn(message, 'error')];
    const user = userEvent.setup();
    serve([inactive, active]);
    mockPut.mockRejectedValueOnce(new Error('Request failed with status code 500'));
    renderWithProviders(<PrivilegedAccessDashboard />);

    const inactiveRow = await rowOf('adm-maija@corp.example');
    await user.click(within(inactiveRow).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Failed to activate admin account')).toBeInTheDocument();

    await user.click(within(inactiveRow).getByRole('button', { name: 'Activate' }));
    expect(
      await screen.findByText(`Admin account active ${untilText(EXPIRES_AT)}`),
    ).toBeInTheDocument();
    for (const spy of staticToasts) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
  it('shows the session the API reports: Activating, Active until <time>, Activation failed, Disable failed', async () => {
    const user = userEvent.setup();
    serve([
      { ...inactive, status: 'ACTIVATING' },
      { ...active, expiresAt: EXPIRES_AT },
      {
        ...orphanedPending,
        adminIdentityId: '64b7f0c2a1b2c3d4e5f60905',
        adminEmail: 'adm-sanna@corp.example',
        parentDeleted: false,
        status: 'INACTIVE',
        activationError: 'ad: insufficient access rights (HTTP 403)',
        disableError: 'entra-id: Graph unavailable (HTTP 503)',
      },
    ]);
    renderWithProviders(<PrivilegedAccessDashboard />);

    // Still enabling: no Activate, but it can be ended
    const activating = await rowOf('adm-maija@corp.example');
    expect(within(activating).getByText('Activating')).toBeInTheDocument();
    expect(within(activating).queryByRole('button', { name: 'Activate' })).toBeNull();
    expect(within(activating).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();

    const activeRow = await rowOf('adm-olli@corp.example');
    expect(within(activeRow).getByText(`Active ${untilText(EXPIRES_AT)}`)).toBeInTheDocument();

    const failed = await rowOf('adm-sanna@corp.example');
    expect(within(failed).getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(within(failed).getByText('Disable failed')).toBeInTheDocument();
    await user.hover(within(failed).getByText('Activation failed'));
    expect(
      await screen.findByText('ad: insufficient access rights (HTTP 403)'),
    ).toBeInTheDocument();
  });

  it('says when the activation is still enabling the accounts, and why it failed', async () => {
    const user = userEvent.setup();
    serve([inactive]);
    mockPut.mockResolvedValueOnce({ data: { state: 'ACTIVATING' } }).mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 502'), {
        response: {
          status: 502,
          data: {
            message: 'Activation of admin account x failed: ad: refused. Nothing stays enabled.',
          },
        },
      }),
    );
    renderWithProviders(<PrivilegedAccessDashboard />);

    const row = await rowOf('adm-maija@corp.example');
    await user.click(within(row).getByRole('button', { name: 'Activate' }));
    expect(
      await screen.findByText(/Activating: the admin accounts are being enabled/),
    ).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Activate' }));
    expect(
      await screen.findByText(
        'Activation of admin account x failed: ad: refused. Nothing stays enabled.',
      ),
    ).toBeInTheDocument();
  });
});

// 09 F10: a session can be activated or ended by the admin account's own person (the parent
// identity) or a connector-admin (super-admin included); everyone else got 403.
describe('PrivilegedAccessDashboard role gate', () => {
  const as = (email: string, role: string) => ({
    ...mockAuthValue,
    user: {
      ...mockAuthValue.user,
      profile: { ...mockAuthValue.user.profile, email, roles: [role] },
    },
  });

  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue({ data: [inactive, active] });
  });

  it('offers an operator the session actions of their own admin account only', async () => {
    renderWithProviders(<PrivilegedAccessDashboard />, {
      authValue: as('Maija@corp.example', 'operator'),
    });

    const own = (await screen.findByText('adm-maija@corp.example')).closest('tr')!;
    expect(within(own).getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    const other = screen.getByText('adm-olli@corp.example').closest('tr')!;
    expect(within(other).queryByRole('button', { name: 'Deactivate' })).toBeNull();
  });

  it('offers a connector admin the actions of every account', async () => {
    renderWithProviders(<PrivilegedAccessDashboard />, {
      authValue: as('someone@corp.example', 'connector-admin'),
    });

    const own = (await screen.findByText('adm-maija@corp.example')).closest('tr')!;
    expect(within(own).getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    const other = screen.getByText('adm-olli@corp.example').closest('tr')!;
    expect(within(other).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });
});
