import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
import { AdminUsersPage } from '../AdminUsersPage';
import {
  asMe,
  confirmDialog,
  expectListReloaded,
  left,
  listLoads,
  me,
  ME_ID,
  mockDelete,
  mockGet,
  mockPatch,
  mockPost,
  operator,
  platform,
  row,
  serve,
} from './AdminUsersPage.fixtures';

// Dev builds (VITE_AUTH_DISABLED) grant every role; the role test sets it explicitly.
let mockIsSuperAdmin = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'super-admin' ? mockIsSuperAdmin : true),
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

describe('AdminUsersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSuperAdmin = true;
  });

  it('lists the admins with role, sign-in, MFA and status, marking you and platform admins', async () => {
    serve();
    renderWithProviders(<AdminUsersPage />, asMe);

    expect(await screen.findByText('Olivia Owner')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/auth\/users$/));

    const mine = row('Olivia Owner');
    expect(within(mine).getByText('You')).toBeInTheDocument();
    expect(within(mine).getByText('olivia@corp.example')).toBeInTheDocument();
    expect(within(mine).getByText('Super-admin')).toBeInTheDocument();
    expect(within(mine).getByText('Password')).toBeInTheDocument();
    expect(within(mine).getByText('On')).toBeInTheDocument();
    expect(within(mine).getByText('Active')).toBeInTheDocument();
    expect(within(mine).getByText('2026-11-01')).toBeInTheDocument();

    expect(within(row('Oscar Operator')).getByText('Operator')).toBeInTheDocument();
    expect(within(row('Oscar Operator')).getByText('Off')).toBeInTheDocument();
    expect(within(row('Oscar Operator')).queryByText('You')).not.toBeInTheDocument();
    expect(within(row('Vera Viewer')).getByText('Single sign-on')).toBeInTheDocument();
    expect(within(row('Lena Left')).getByText('Deactivated')).toBeInTheDocument();
    expect(within(row('Lena Left')).getByText('Policy admin')).toBeInTheDocument();
    expect(within(row('Pat Platform')).getByText('Platform admin')).toBeInTheDocument();

    // The last sign-in, or "Never" when none is recorded.
    expect(
      within(mine).getByText(dayjs(me.lastLoginAt).format('YYYY-MM-DD HH:mm')),
    ).toBeInTheDocument();
    expect(within(row('Oscar Operator')).getByText('Never')).toBeInTheDocument();
  });

  it('fits the card at 1440 px and scrolls inside it on phones', async () => {
    serve();
    renderWithProviders(<AdminUsersPage />, asMe);

    const table = (await screen.findByText('Olivia Owner')).closest('table')!;
    expect(table.style.tableLayout).toBe('fixed');
    // At 1440 px with the sidebar open the card is 1118 px wide, 1092 px inside its padding. A
    // wider table (1210 px) hid the revoke and deactivate buttons until it was scrolled.
    const width = parseInt(table.style.width, 10);
    expect(width).toBeLessThanOrEqual(1092);
    const columns = Array.from(table.querySelectorAll('col')).map((c) =>
      parseInt(c.style.width, 10),
    );
    expect(columns.reduce((sum, w) => sum + w, 0)).toBeLessThanOrEqual(width);
    // At 400 px the table keeps its width and its container scrolls sideways.
    expect((table.closest('.ant-table-content') as HTMLElement).style.overflowX).toBe('auto');
    // The four row actions wrap within their column instead of spilling out of it.
    const actions = within(row('Oscar Operator'))
      .getByRole('button', { name: 'Deactivate Oscar Operator' })
      .closest('.ant-space') as HTMLElement;
    expect(actions.style.flexWrap).toBe('wrap');
  });

  it('says so when the tenant has no admin users and offers an invite', async () => {
    serve([]);
    renderWithProviders(<AdminUsersPage />, asMe);

    expect(await screen.findByText('No admin users in this tenant')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Invite admin/ }).length).toBe(2);
  });

  it('shows the API message when the list cannot be loaded', async () => {
    mockGet.mockRejectedValue({ response: { status: 500, data: { message: 'Mongo is down' } } });
    renderWithProviders(<AdminUsersPage />, asMe);

    expect(await screen.findByText('Could not load the admin users')).toBeInTheDocument();
    // The pending invites fail the same way, in their own card.
    const admins = screen.getByRole('region', { name: 'Admin users' });
    expect(within(admins).getByText('Mongo is down')).toBeInTheDocument();
    expect(await screen.findByText('Could not load the pending invites')).toBeInTheDocument();
  });

  // Every admin route needs super-admin: anyone else would only get 403s.
  it('asks nothing of the API for a user without super-admin', async () => {
    mockIsSuperAdmin = false;
    serve();
    renderWithProviders(<AdminUsersPage />, asMe);

    expect(await screen.findByText('Admin users need the super-admin role.')).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Invite admin/ })).not.toBeInTheDocument();
  });

  it(
    "revokes another admin's sessions after a confirmation that says what happens",
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<AdminUsersPage />, asMe);
      await screen.findByText('Oscar Operator');

      await user.click(screen.getByRole('button', { name: 'Revoke sessions of Oscar Operator' }));
      let dialog = await confirmDialog('Sign Oscar Operator out everywhere?');
      expect(
        within(dialog).getByText(
          /Every session of Oscar Operator \(oscar@corp\.example\) ends.*The account stays active and keeps its role: they can sign in again with their password\./,
        ),
      ).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(mockPost).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Revoke sessions of Oscar Operator' }));
      dialog = await confirmDialog('Sign Oscar Operator out everywhere?');
      const before = listLoads();
      await user.click(within(dialog).getByRole('button', { name: 'Revoke sessions' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/api/v1/auth/revoke/${operator.id}$`)),
        ),
      );
      await expectListReloaded(before);
      expect(
        await screen.findByText('Oscar Operator is signed out everywhere.'),
      ).toBeInTheDocument();
    },
  );

  it('says a single sign-on admin signs in again through single sign-on', async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<AdminUsersPage />, asMe);
    await screen.findByText('Vera Viewer');

    // Looked up in its row: with the role query over every row's buttons this test, which has
    // the 5 s default timeout, ran out of it on a loaded machine.
    await user.click(
      within(row('Vera Viewer')).getByRole('button', { name: 'Revoke sessions of Vera Viewer' }),
    );
    const dialog = await confirmDialog('Sign Vera Viewer out everywhere?');
    expect(within(dialog).getByText(/sign in again through single sign-on/)).toBeInTheDocument();
  });

  it(
    'warns that revoking your own sessions signs you out here too',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<AdminUsersPage />, asMe);
      await screen.findByText('Olivia Owner');

      await user.click(screen.getByRole('button', { name: 'Revoke sessions of Olivia Owner' }));
      const dialog = await confirmDialog('Sign yourself out everywhere?');
      expect(within(dialog).getByText(/this one included/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Revoke sessions' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/auth/revoke/${ME_ID}$`)),
        ),
      );
    },
  );

  it('deactivates after a confirmation and reloads the list', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<AdminUsersPage />, asMe);
    await screen.findByText('Oscar Operator');

    await user.click(screen.getByRole('button', { name: 'Deactivate Oscar Operator' }));
    const dialog = await confirmDialog('Deactivate Oscar Operator?');
    expect(
      within(dialog).getByText(/is signed out at once on every device and can no longer sign in/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/a super-admin can reactivate it later/)).toBeInTheDocument();
    const before = listLoads();
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`/api/v1/auth/users/${operator.id}$`)),
        { isActive: false },
      ),
    );
    await expectListReloaded(before);
    expect(await screen.findByText('Oscar Operator is deactivated.')).toBeInTheDocument();
  });

  it('reactivates a deactivated admin', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<AdminUsersPage />, asMe);
    await screen.findByText('Lena Left');

    await user.click(screen.getByRole('button', { name: 'Reactivate Lena Left' }));
    const dialog = await confirmDialog('Reactivate Lena Left?');
    expect(within(dialog).getByText(/as Policy admin/)).toBeInTheDocument();
    const before = listLoads();
    await user.click(within(dialog).getByRole('button', { name: 'Reactivate' }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`/auth/users/${left.id}$`)),
        { isActive: true },
      ),
    );
    await expectListReloaded(before);
    expect(await screen.findByText('Lena Left can sign in again.')).toBeInTheDocument();
  });

  it('shows the API message when a change is refused', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<AdminUsersPage />, asMe);
    await screen.findByText('Oscar Operator');
    mockPatch.mockRejectedValue({
      response: { status: 404, data: { message: 'Admin user not found' } },
    });

    await user.click(screen.getByRole('button', { name: 'Deactivate Oscar Operator' }));
    const dialog = await confirmDialog('Deactivate Oscar Operator?');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));

    expect(
      await screen.findByText('Deactivation failed: Admin user not found'),
    ).toBeInTheDocument();
  });

  // The API refuses these (400, 403); a page that offered them would only show errors.
  it('offers no action that would lock you out or touch a platform admin', async () => {
    serve();
    renderWithProviders(<AdminUsersPage />, asMe);
    await screen.findByText('Olivia Owner');

    expect(screen.getByRole('button', { name: 'Deactivate Olivia Owner' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Revoke sessions of Olivia Owner' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Revoke sessions of Pat Platform' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deactivate Pat Platform' })).toBeDisabled();
    // A deactivated admin has no session left.
    expect(screen.getByRole('button', { name: 'Revoke sessions of Lena Left' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reactivate Lena Left' })).toBeEnabled();
    // Your own role (400) and a platform admin's (403); a deactivated admin's role can change.
    expect(screen.getByRole('button', { name: 'Change the role of Olivia Owner' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change the role of Pat Platform' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change the role of Lena Left' })).toBeEnabled();
    // A reset code: not for yourself (400), a platform admin (403), a single sign-on or
    // deactivated admin (409).
    for (const name of ['Olivia Owner', 'Pat Platform', 'Vera Viewer', 'Lena Left']) {
      expect(screen.getByRole('button', { name: `Reset the password of ${name}` })).toBeDisabled();
    }
    expect(
      screen.getByRole('button', { name: 'Reset the password of Oscar Operator' }),
    ).toBeEnabled();
  });

  it('lets a platform admin revoke their own sessions', async () => {
    serve();
    const asPlatform = {
      authValue: {
        ...mockAuthValue,
        user: {
          ...mockAuthValue.user,
          profile: { ...mockAuthValue.user.profile, sub: platform.id },
        },
      },
    };
    renderWithProviders(<AdminUsersPage />, asPlatform);
    await screen.findByText('Pat Platform');

    expect(screen.getByRole('button', { name: 'Revoke sessions of Pat Platform' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Deactivate Pat Platform' })).toBeDisabled();
  });
});
