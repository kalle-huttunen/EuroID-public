/**
 * The admin users page's row actions, each behind a confirmation that says what happens: revoke
 * sessions, deactivate, reactivate, change the role, issue a password reset code. Each shows the
 * API's own message when it is refused, and every change reloads the list (the mutations' prefix
 * key).
 */
import { App } from 'antd';
import {
  useChangeAdminRole,
  useIssuePasswordReset,
  useRevokeAdminSessions,
  useSetAdminActive,
} from '@api/admin-users-api';
import type { AdminRole, IAdminUser, IPasswordResetCode } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { ROLE_LABEL, ROLE_OPTIONS } from './admin-user-labels';

/** How the person signs in again after a revocation. */
const signInAgain = (admin: IAdminUser) =>
  admin.authSource === 'saml'
    ? 'through single sign-on'
    : `with their password${admin.mfaEnabled ? ' and MFA code' : ''}`;

export function useAdminActions(mySub: string | undefined) {
  const { modal, message } = App.useApp();
  const revoke = useRevokeAdminSessions();
  const setActive = useSetAdminActive();
  const changeRole = useChangeAdminRole();
  const issueReset = useIssuePasswordReset();

  const isMe = (admin: IAdminUser) => !!mySub && admin.id === mySub;

  const confirmRevoke = (admin: IAdminUser) => {
    const me = isMe(admin);
    modal.confirm({
      title: me ? 'Sign yourself out everywhere?' : `Sign ${admin.name} out everywhere?`,
      content: me
        ? 'Every session of yours ends, this one included: you are signed out here and on every other device and have to sign in again. Your account and role stay as they are.'
        : `Every session of ${admin.name} (${admin.email}) ends: the tokens they hold are refused from their next request, on every device. The account stays active and keeps its role: they can sign in again ${signInAgain(admin)}.`,
      okText: 'Revoke sessions',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await revoke.mutateAsync(admin.id);
          message.success(
            me ? 'Your sessions were revoked.' : `${admin.name} is signed out everywhere.`,
          );
        } catch (err) {
          message.error(`Revoke failed: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });
  };

  const changeActive = async (admin: IAdminUser, isActive: boolean) => {
    try {
      await setActive.mutateAsync({ id: admin.id, isActive });
      message.success(
        isActive ? `${admin.name} can sign in again.` : `${admin.name} is deactivated.`,
      );
    } catch (err) {
      message.error(
        `${isActive ? 'Reactivation' : 'Deactivation'} failed: ${apiErrorMessage(err, 'the request failed')}`,
      );
    }
  };

  const confirmDeactivate = (admin: IAdminUser) =>
    modal.confirm({
      title: `Deactivate ${admin.name}?`,
      content: `${admin.name} (${admin.email}) is signed out at once on every device and can no longer sign in, with a password or through single sign-on. EuroID stops sending them notification emails. The account keeps its role and MFA, so a super-admin can reactivate it later.`,
      okText: 'Deactivate',
      okButtonProps: { danger: true },
      onOk: () => changeActive(admin, false),
    });

  const confirmReactivate = (admin: IAdminUser) =>
    modal.confirm({
      title: `Reactivate ${admin.name}?`,
      content: `${admin.name} (${admin.email}) can sign in again ${signInAgain(admin)}, as ${ROLE_LABEL[admin.role] ?? admin.role}.`,
      okText: 'Reactivate',
      onOk: () => changeActive(admin, true),
    });

  /** After the role modal: what the new role may do, then the change. `onDone` closes the modal. */
  const confirmRoleChange = (admin: IAdminUser, role: AdminRole, onDone: () => void) => {
    const label = ROLE_LABEL[role] ?? role;
    const description = ROLE_OPTIONS.find((o) => o.value === role)?.description ?? '';
    modal.confirm({
      title: `Make ${admin.name} ${label}?`,
      content: `${label}: ${description} The change applies from their next request; they stay signed in.`,
      okText: 'Change role',
      onOk: async () => {
        try {
          await changeRole.mutateAsync({ id: admin.id, role });
          onDone();
          message.success(`${admin.name} is now ${label}.`);
        } catch (err) {
          message.error(`Role not changed: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });
  };

  /** The code goes to `onIssued` (the page shows it once); it is kept nowhere else. */
  const confirmPasswordReset = (admin: IAdminUser, onIssued: (code: IPasswordResetCode) => void) =>
    modal.confirm({
      title: `Issue a password reset code for ${admin.name}?`,
      content: `The code is shown once and is valid for a limited time. ${admin.name} (${admin.email}) uses it on the sign-in page to set a new password; every session of theirs ends then, and their MFA stays as it is. Until then their current password still works. A newer code or reset link replaces this one.`,
      okText: 'Issue code',
      onOk: async () => {
        try {
          onIssued(await issueReset.mutateAsync(admin.id));
        } catch (err) {
          message.error(`No reset code: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });

  return {
    isMe,
    confirmPasswordReset,
    confirmRevoke,
    confirmDeactivate,
    confirmReactivate,
    confirmRoleChange,
    activeChanging: setActive.isPending,
  };
}
