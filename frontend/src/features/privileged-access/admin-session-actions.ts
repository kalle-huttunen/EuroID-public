/**
 * Activate and Deactivate of a linked admin account's privileged session, with the outcome in a
 * toast of the app (App.useApp, the app's theme), and when each is offered.
 */
import { App } from 'antd';
import dayjs from 'dayjs';
import { useActivateAdminAccount, useDeactivateAdminAccount } from '@api/privileged-access-api';
import { useAuthContext } from '../../auth/auth-context';
import { usePermission } from '../../auth/usePermission';

/** A session time as the page writes it (local time). */
export const sessionTime = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm');

/** The server's reason (502 names the target and why), else the fallback. */
function reasonOf(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof msg === 'string' && msg ? msg : fallback;
}

/** Whether Activate is offered: never activated, or ended. */
export const canActivate = (status: string) => status === 'PENDING' || status === 'INACTIVE';

/** Whether Deactivate is offered: a session that is active or still enabling. */
export const canDeactivate = (status: string) => status === 'ACTIVE' || status === 'ACTIVATING';

/**
 * Who may run an admin account's session, as the API decides: the account's own person (its
 * parent identity, matched by the signed-in email) or a connector-admin (super-admin included).
 */
export function useMayRunAdminSession(): (parentEmail: string | undefined) => boolean {
  const isConnectorAdmin = usePermission('connector-admin');
  const email = useAuthContext().user?.profile?.email?.toLowerCase();
  return (parentEmail) =>
    isConnectorAdmin || (!!email && !!parentEmail && parentEmail.toLowerCase() === email);
}

/** Activate and Deactivate with their outcome in a themed toast. */
export function useAdminSessionActions() {
  const { message } = App.useApp();
  const activate = useActivateAdminAccount();
  const deactivate = useDeactivateAdminAccount();

  const handleActivate = async (adminId: string) => {
    try {
      const result = await activate.mutateAsync(adminId);
      if (result?.state === 'ACTIVE') {
        message.success(`Admin account active until ${sessionTime(result.expiresAt)}`);
      } else {
        message.info('Activating: the admin accounts are being enabled in the target systems');
      }
    } catch (err: unknown) {
      message.error(reasonOf(err, 'Failed to activate admin account'));
    }
  };

  const handleDeactivate = async (adminId: string) => {
    try {
      const result = await deactivate.mutateAsync(adminId);
      if (result?.state === 'DEACTIVATING') {
        message.info('Deactivating: the admin accounts are being disabled in the target systems');
      } else {
        message.success('Admin account deactivated');
      }
    } catch (err: unknown) {
      message.error(reasonOf(err, 'Failed to deactivate admin account'));
    }
  };

  return {
    handleActivate,
    handleDeactivate,
    activating: activate.isPending,
    deactivating: deactivate.isPending,
    /** The admin account whose activation or deactivation is running, for its row's spinner. */
    pendingId: activate.isPending
      ? activate.variables
      : deactivate.isPending
        ? deactivate.variables
        : undefined,
  };
}
