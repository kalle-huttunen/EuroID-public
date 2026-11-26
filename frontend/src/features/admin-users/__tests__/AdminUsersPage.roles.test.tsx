import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import { renderWithProviders } from '../../../test/test-utils';
import { AdminUsersPage } from '../AdminUsersPage';
import {
  asMe,
  confirmDialog,
  expectListReloaded,
  formModal,
  listLoads,
  mockDelete,
  mockGet,
  mockPatch,
  mockPost,
  operator,
  RESET_CODE,
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

describe('AdminUsersPage: role change and password reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    'changes a role after a confirmation that says what the new role may do',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<AdminUsersPage />, asMe);
      await screen.findByText('Oscar Operator');

      await user.click(screen.getByRole('button', { name: 'Change the role of Oscar Operator' }));
      const modal = await formModal('Change the role of Oscar Operator');
      expect(within(modal).getByRole('radio', { name: /^Operator/ })).toBeChecked();
      expect(within(modal).getByText('(current)')).toBeInTheDocument();
      // Nothing to confirm until another role is chosen.
      expect(within(modal).getByRole('button', { name: 'Continue' })).toBeDisabled();
      await user.click(within(modal).getByRole('radio', { name: /^Policy admin/ }));
      await user.click(within(modal).getByRole('button', { name: 'Continue' }));

      const dialog = await confirmDialog('Make Oscar Operator Policy admin?');
      expect(
        within(dialog).getByText(
          /Policy admin: Operator, plus policies, simulation and deploy.*applies from their next request; they stay signed in\./,
        ),
      ).toBeInTheDocument();
      const before = listLoads();
      await user.click(within(dialog).getByRole('button', { name: 'Change role' }));

      await waitFor(() =>
        expect(mockPatch).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/api/v1/auth/users/${operator.id}$`)),
          { role: 'policy-admin' },
        ),
      );
      await expectListReloaded(before);
      expect(await screen.findByText('Oscar Operator is now Policy admin.')).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.queryByText('Change the role of Oscar Operator', { selector: '.ant-modal-title' }),
        ).not.toBeInTheDocument(),
      );
    },
  );

  it('shows the API message when a role change is refused', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<AdminUsersPage />, asMe);
    await screen.findByText('Oscar Operator');
    mockPatch.mockRejectedValue({
      response: {
        status: 409,
        data: {
          message:
            'This is the last active super-admin of the tenant. Make another admin a super-admin first.',
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Change the role of Oscar Operator' }));
    const modal = await formModal('Change the role of Oscar Operator');
    await user.click(within(modal).getByRole('radio', { name: /^Viewer/ }));
    await user.click(within(modal).getByRole('button', { name: 'Continue' }));
    const dialog = await confirmDialog('Make Oscar Operator Viewer?');
    await user.click(within(dialog).getByRole('button', { name: 'Change role' }));

    expect(
      await screen.findByText(
        'Role not changed: This is the last active super-admin of the tenant. Make another admin a super-admin first.',
      ),
    ).toBeInTheDocument();
  });

  it(
    'issues a password reset code after a confirmation and shows it once with its expiry',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<AdminUsersPage />, asMe);
      await screen.findByText('Oscar Operator');

      await user.click(
        screen.getByRole('button', { name: 'Reset the password of Oscar Operator' }),
      );
      const dialog = await confirmDialog('Issue a password reset code for Oscar Operator?');
      expect(
        within(dialog).getByText(
          /shown once.*valid for a limited time.*every session of theirs ends.*MFA stays as it is/,
        ),
      ).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Issue code' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/api/v1/auth/users/${operator.id}/password-reset$`)),
        ),
      );
      const shown = await formModal('Password reset code');
      expect(within(shown).getByLabelText('Reset code')).toHaveTextContent(RESET_CODE.token);
      expect(within(shown).getByText(/EuroID shows it only now/)).toBeInTheDocument();
      expect(
        within(shown).getByText(
          new RegExp(`Valid once, until ${dayjs(RESET_CODE.expiresAt).format('YYYY-MM-DD HH:mm')}`),
        ),
      ).toBeInTheDocument();

      await user.click(within(shown).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(document.body.textContent).not.toContain(RESET_CODE.token));
    },
  );

  it('shows the API message when no reset code is issued', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<AdminUsersPage />, asMe);
    await screen.findByText('Oscar Operator');
    mockPost.mockRejectedValue({
      response: { status: 404, data: { message: 'Admin user not found' } },
    });

    await user.click(screen.getByRole('button', { name: 'Reset the password of Oscar Operator' }));
    const dialog = await confirmDialog('Issue a password reset code for Oscar Operator?');
    await user.click(within(dialog).getByRole('button', { name: 'Issue code' }));

    expect(await screen.findByText('No reset code: Admin user not found')).toBeInTheDocument();
    expect(
      screen.queryByText('Password reset code', { selector: '.ant-modal-title' }),
    ).not.toBeInTheDocument();
  });
});
