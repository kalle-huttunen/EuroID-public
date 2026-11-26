/**
 * The peer group check in the request form (operator, like POST /intelligence/unusual-check):
 * for each entitlement being requested that has a native id, whether few or none of the
 * requester's peers have it. The requester is the identity with the signed-in user's email, the
 * way the access request routes find it (GET /identity/v2/by-email). Advice only: the request can
 * still be submitted. A role below operator is shown nothing and sends no check.
 */
import React from 'react';
import { Alert, Tag, Typography } from 'antd';
import {
  useIdentityIdByEmail,
  useUnusualRequestChecks,
  type CheckableEntry,
} from '@api/access-intelligence-api';
import { useAuthContext } from '../../auth/auth-context';
import { usePermission } from '../../auth/usePermission';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text } = Typography;

export const PeerCheckWarnings: React.FC<{ entries: CheckableEntry[] }> = ({ entries }) => {
  const isOperator = usePermission('operator');
  const auth = useAuthContext();
  const email = auth.user?.profile?.email as string | undefined;
  const requester = useIdentityIdByEmail(email, isOperator);
  const checks = useUnusualRequestChecks(
    isOperator ? (requester.data ?? undefined) : undefined,
    entries,
  );
  const warnings = checks.filter((c) => c.result.data);
  const failed = checks.find((c) => c.result.isError);

  if (!warnings.length && !failed) return null;
  const critical = warnings.some((c) => c.result.data?.severity === 'CRITICAL');
  return (
    <>
      {warnings.length > 0 && (
        <Alert
          type={critical ? 'error' : 'warning'}
          showIcon
          style={{ marginBottom: 16 }}
          message="Unusual for your peer group"
          description={
            <>
              <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
                {warnings.map(({ entry, result }) => (
                  <li key={entry._id}>
                    <Text strong>{entry.name}</Text>: {result.data?.warning}{' '}
                    <Tag color={result.data?.severity === 'CRITICAL' ? 'error' : 'warning'}>
                      {result.data?.severity === 'CRITICAL' ? 'Critical' : 'Warning'}
                    </Tag>
                  </li>
                ))}
              </ul>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Your peers are the people with your department and job title, and their access is
                what they hold: what the role-based rules give them on their synced accounts and
                what their active access requests give them, as the nightly intelligence batch
                computed it. This does not block the request.
              </Text>
            </>
          }
        />
      )}
      {failed && (
        <Text type="secondary" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
          The peer group check could not run:{' '}
          {apiErrorMessage(failed.result.error, 'the request failed')}
        </Text>
      )}
    </>
  );
};
