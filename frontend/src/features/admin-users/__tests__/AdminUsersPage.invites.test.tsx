import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import { renderWithProviders } from '../../../test/test-utils';
import { AdminUsersPage } from '../AdminUsersPage';
import { InviteAdminModal } from '../InviteAdminModal';
import { PendingInvitesCard } from '../PendingInvitesCard';
import {
  ALL,
  asMe,
  confirmDialog,
  formModal,
  INVITE,
  ME_ID,
  inviteLoads,
  invitesRegion,
  mockDelete,
  mockGet,
  mockPatch,
  mockPost,
  PENDING,
  serve,
} from './AdminUsersPage.fixtures';

// Dev builds (VITE_AUTH_DISABLED) grant every role.
vi.mock('../../../auth/usePermission', () => ({ usePermission: () => true }));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

describe('AdminUsersPage: invites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const onClose = vi.fn();

  /**
   * The invite modal alone, as the page opens it with the admins' addresses (no list to render).
   * The first test opens it from the page and checks that the pending invites reload.
   */
  async function openInvite() {
    const user = userEvent.setup();
    renderWithProviders(
      <InviteAdminModal open emailsInUse={ALL.map((a) => a.email)} onClose={onClose} />,
      asMe,
    );
    return { user, modal: await formModal('Invite an admin') };
  }

  /** The pending invites card alone, as the page shows it below the admins. */
  function renderInvitesCard() {
    renderWithProviders(<PendingInvitesCard admins={ALL} mySub={ME_ID} />, asMe);
  }

  it(
    'invites with the chosen role and shows the code once, with how to use it',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<AdminUsersPage />, asMe);
      await screen.findByText('Olivia Owner');

      await user.click(screen.getByRole('button', { name: /Invite admin/ }));
      const modal = await formModal('Invite an admin');
      // A super-admin may grant every tenant role, and no role beyond them exists.
      const roles = within(modal).getAllByRole('radio');
      expect(roles).toHaveLength(5);
      expect(within(modal).getByRole('radio', { name: /^Viewer/ })).toBeChecked();
      expect(within(modal).queryByText(/platform-admin/i)).not.toBeInTheDocument();

      await user.click(within(modal).getByLabelText('Email'));
      await user.paste('  New.Admin@Corp.example ');
      await user.click(within(modal).getByRole('radio', { name: /^Operator/ }));
      await user.click(within(modal).getByRole('button', { name: 'Create invite' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/auth\/invites$/), {
          email: 'new.admin@corp.example',
          roles: ['operator'],
        }),
      );
      const done = await formModal('Invite created');
      expect(within(done).getByLabelText('Invite code')).toHaveTextContent(INVITE.token);
      expect(within(done).getByText('new.admin@corp.example')).toBeInTheDocument();
      expect(within(done).getByText(/EuroID shows it only now/)).toBeInTheDocument();
      expect(within(done).getByText('Operator')).toBeInTheDocument();
      expect(within(done).getByText(/Valid once, until 2026-11-26/)).toBeInTheDocument();

      // The new invite shows up among the pending ones (without its code).
      await waitFor(() => expect(inviteLoads()).toBeGreaterThan(1));

      await user.click(within(done).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(document.body.textContent).not.toContain(INVITE.token));
    },
  );

  it(
    'refuses an address that already has an account before asking the API',
    { timeout: 30_000 },
    async () => {
      serve();
      const { user, modal } = await openInvite();
      await user.click(within(modal).getByLabelText('Email'));
      await user.paste('Oscar@corp.example');
      await user.click(within(modal).getByRole('button', { name: 'Create invite' }));

      expect(
        await within(modal).findByText('This address already has an admin account.'),
      ).toBeInTheDocument();
      expect(mockPost).not.toHaveBeenCalled();
    },
  );

  it(
    'keeps the form open with the API message when the invite fails',
    { timeout: 30_000 },
    async () => {
      serve();
      mockPost.mockRejectedValue({
        response: { status: 400, data: { message: 'At least one valid role is required' } },
      });
      const { user, modal } = await openInvite();
      await user.click(within(modal).getByLabelText('Email'));
      await user.paste('someone@corp.example');
      await user.click(within(modal).getByRole('button', { name: 'Create invite' }));

      expect(
        await within(modal).findByText('Not invited: At least one valid role is required'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Invite an admin', { selector: '.ant-modal-title' }),
      ).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it('lists the pending invites with role, inviter and expiry, and never a code', async () => {
    serve();
    renderInvitesCard();

    await within(await screen.findByRole('region', { name: 'Pending invites' })).findByText(
      'nina@corp.example',
    );
    expect(mockGet).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/auth\/invites$/));
    const nina = within(invitesRegion()).getByText('nina@corp.example').closest('tr')!;
    expect(within(nina as HTMLElement).getByText('Policy admin')).toBeInTheDocument();
    expect(within(nina as HTMLElement).getByText('You')).toBeInTheDocument();
    expect(
      within(nina as HTMLElement).getByText(dayjs(PENDING[0].expiresAt).format('YYYY-MM-DD HH:mm')),
    ).toBeInTheDocument();
    // An inviter who is not in the list (an OIDC super-admin) is shown by the id the API holds.
    const sam = within(invitesRegion()).getByText('sam@corp.example').closest('tr')!;
    expect(
      within(sam as HTMLElement).getByText('auth0|5f7c8ec7c33c6c004bbafe82'),
    ).toBeInTheDocument();
    expect(within(invitesRegion()).queryByLabelText('Invite code')).not.toBeInTheDocument();
  });

  it('says so when no invite is pending', async () => {
    serve(ALL, []);
    renderInvitesCard();

    expect(await screen.findByText('No pending invites.')).toBeInTheDocument();
  });

  it(
    'cancels an invite after a confirmation and reloads the invites',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderInvitesCard();
      await screen.findByText('nina@corp.example');

      await user.click(
        screen.getByRole('button', { name: 'Cancel the invite for nina@corp.example' }),
      );
      let dialog = await confirmDialog('Cancel the invite for nina@corp.example?');
      expect(within(dialog).getByText(/nobody can register with it/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Keep invite' }));
      expect(mockDelete).not.toHaveBeenCalled();

      await user.click(
        screen.getByRole('button', { name: 'Cancel the invite for nina@corp.example' }),
      );
      dialog = await confirmDialog('Cancel the invite for nina@corp.example?');
      const before = inviteLoads();
      await user.click(within(dialog).getByRole('button', { name: 'Cancel invite' }));

      await waitFor(() =>
        expect(mockDelete).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/api/v1/auth/invites/${PENDING[0].id}$`)),
        ),
      );
      await waitFor(() => expect(inviteLoads()).toBeGreaterThan(before));
      expect(
        await screen.findByText('The invite for nina@corp.example is cancelled.'),
      ).toBeInTheDocument();
    },
  );

  it('shows the API message when an invite cannot be cancelled', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve();
    renderInvitesCard();
    await screen.findByText('sam@corp.example');
    mockDelete.mockRejectedValue({
      response: {
        status: 404,
        data: {
          message:
            'No pending invite with this id in your tenant: it was used, expired or cancelled.',
        },
      },
    });

    await user.click(
      screen.getByRole('button', { name: 'Cancel the invite for sam@corp.example' }),
    );
    const dialog = await confirmDialog('Cancel the invite for sam@corp.example?');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel invite' }));

    expect(
      await screen.findByText(
        'Not cancelled: No pending invite with this id in your tenant: it was used, expired or cancelled.',
      ),
    ).toBeInTheDocument();
  });
});
