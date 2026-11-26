/**
 * The action buttons of one admin row. An action the API would refuse is disabled, with the
 * reason in its tooltip: your own role, deactivation or reset code (400), a platform admin's
 * account (403), a reset code for a single sign-on or deactivated account (409), a deactivated
 * admin's sessions (none left).
 */
import React from 'react';
import { Button, Space, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  KeyOutlined,
  LogoutOutlined,
  StopOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import type { IAdminUser } from '../../interfaces';
import { PLATFORM_ADMIN_REASON } from './admin-user-labels';
import type { useAdminActions } from './useAdminActions';

export const AdminRowActions: React.FC<{
  admin: IAdminUser;
  actions: ReturnType<typeof useAdminActions>;
  onChangeRole: (admin: IAdminUser) => void;
  onResetPassword: (admin: IAdminUser) => void;
}> = ({ admin, actions, onChangeRole, onResetPassword }) => {
  const me = actions.isMe(admin);
  /** The API refuses (403) a tenant role's action on a platform admin other than the caller. */
  const locked = admin.isPlatformAdmin && !me;
  const roleReason = locked
    ? PLATFORM_ADMIN_REASON
    : me
      ? 'You cannot change your own role. Another super-admin can.'
      : 'Change role';
  const canReset = !locked && !me && admin.authSource !== 'saml' && admin.isActive;
  const resetReason = locked
    ? PLATFORM_ADMIN_REASON
    : me
      ? 'Change your own password under Account security.'
      : admin.authSource === 'saml'
        ? 'Signs in through single sign-on: there is no EuroID password to reset.'
        : !admin.isActive
          ? 'Deactivated: reactivate the account first.'
          : 'Reset password';
  const revokeReason = locked
    ? PLATFORM_ADMIN_REASON
    : !admin.isActive
      ? 'Deactivated: no session is left to revoke.'
      : me
        ? 'Sign yourself out everywhere'
        : 'Revoke sessions';
  const activeReason = locked
    ? PLATFORM_ADMIN_REASON
    : me
      ? 'You cannot deactivate your own account. Another super-admin can.'
      : admin.isActive
        ? 'Deactivate'
        : 'Reactivate';

  // Wraps onto a second line rather than overflowing a column narrower than the four buttons.
  return (
    <Space size={[4, 4]} wrap>
      <Tooltip title={roleReason}>
        <Button
          size="small"
          icon={<UserSwitchOutlined />}
          aria-label={`Change the role of ${admin.name}`}
          disabled={locked || me}
          onClick={() => onChangeRole(admin)}
        />
      </Tooltip>
      <Tooltip title={resetReason}>
        <Button
          size="small"
          icon={<KeyOutlined />}
          aria-label={`Reset the password of ${admin.name}`}
          disabled={!canReset}
          onClick={() => onResetPassword(admin)}
        />
      </Tooltip>
      <Tooltip title={revokeReason}>
        <Button
          size="small"
          danger
          icon={<LogoutOutlined />}
          aria-label={`Revoke sessions of ${admin.name}`}
          disabled={locked || !admin.isActive}
          onClick={() => actions.confirmRevoke(admin)}
        />
      </Tooltip>
      <Tooltip title={activeReason}>
        {admin.isActive ? (
          <Button
            size="small"
            danger
            icon={<StopOutlined />}
            aria-label={`Deactivate ${admin.name}`}
            disabled={locked || me || actions.activeChanging}
            onClick={() => actions.confirmDeactivate(admin)}
          />
        ) : (
          <Button
            size="small"
            icon={<CheckCircleOutlined />}
            aria-label={`Reactivate ${admin.name}`}
            disabled={locked || actions.activeChanging}
            onClick={() => actions.confirmReactivate(admin)}
          />
        )}
      </Tooltip>
    </Space>
  );
};
