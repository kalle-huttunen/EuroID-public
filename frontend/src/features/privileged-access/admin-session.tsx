/**
 * A linked admin account's privileged session as the Privileged access page and the identity
 * Access tab show it: the state tags (the actions: admin-session-actions.ts). The backend enables
 * the accounts in the target systems for a session and disables them at its end (PAM
 * docs/ARCHITECTURE.md).
 */
import React from 'react';
import { Space, Tag, Tooltip } from 'antd';
import type { AdminSessionFields } from '@api/privileged-access-api';
import { sessionTime as time } from './admin-session-actions';

/** Activating, Active until <time>, Inactive, Pending; Activation failed / Disable failed with the reason. */
export const AdminSessionTags: React.FC<{ session: AdminSessionFields }> = ({ session }) => {
  const { status, expiresAt, activationError, disableError } = session;
  return (
    <Space size={4} wrap>
      {status === 'ACTIVE' ? (
        <Tag color="green">{expiresAt ? `Active until ${time(expiresAt)}` : 'Active'}</Tag>
      ) : status === 'ACTIVATING' ? (
        <Tag color="processing">Activating</Tag>
      ) : status === 'INACTIVE' && activationError ? (
        <Tooltip title={activationError}>
          <Tag color="red">Activation failed</Tag>
        </Tooltip>
      ) : (
        <Tag>{status === 'INACTIVE' ? 'Inactive' : status === 'PENDING' ? 'Pending' : status}</Tag>
      )}
      {disableError && (
        <Tooltip title={`${disableError} (retried every hour)`}>
          <Tag color="warning">Disable failed</Tag>
        </Tooltip>
      )}
    </Space>
  );
};
