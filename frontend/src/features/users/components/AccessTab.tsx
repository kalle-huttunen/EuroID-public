/**
 * AccessTab – calculated entitlements for an identity.
 * Shows expired access the expiry run could not remove (ExpiredAccessPanel, only when there is
 * some), linked admin accounts (PAM), "Re-evaluate access" (preview, then the mover workflow;
 * AccessReevaluationPanel), access revoked in access reviews that the policies no longer grant
 * (ReviewExclusionsPanel, only when there is some) and entitlements when endpoints exist.
 */

import React from 'react';
import { Table, Typography, Skeleton, Space, Tag, Button } from 'antd';
import { EmptyState } from '../../../components/common/EmptyState';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { useLinkedAdminAccounts, type LinkedAdminAccount } from '@api/privileged-access-api';
import { AdminSessionTags } from '../../privileged-access/admin-session';
import {
  canActivate,
  canDeactivate,
  useAdminSessionActions,
  useMayRunAdminSession,
} from '../../privileged-access/admin-session-actions';
import { useFailedExpiries } from '@api/expired-access-api';
import { useReviewExclusions } from '@api/review-exclusions-api';
import type { ColumnsType } from 'antd/es/table';
import { ErrorState } from '@shared/ErrorState';
import { AccessReevaluationPanel } from './AccessReevaluationPanel';
import { ExpiredAccessPanel } from './ExpiredAccessPanel';
import { ReviewExclusionsPanel } from './ReviewExclusionsPanel';

const { Text } = Typography;

export interface EntitlementRow {
  id: string;
  entitlement: string;
  source: string;
  targetSystem: string;
  status: 'Active' | 'Pending' | 'Revoked';
}

export interface AccessTabProps {
  identityId: string;
  /** The identity's email: its own person may run its linked admin accounts' sessions. */
  identityEmail?: string;
}

export const AccessTab: React.FC<AccessTabProps> = ({ identityId, identityEmail }) => {
  const { data: linkedAdmins, isLoading: linkedLoading } = useLinkedAdminAccounts(identityId);
  const { handleActivate, handleDeactivate, pendingId } = useAdminSessionActions();
  const mayRunSession = useMayRunAdminSession()(identityEmail);
  // The panel reads the same query; rendered only when it has something to show
  const failedExpiries = useFailedExpiries(identityId);
  const showExpired = failedExpiries.isError || (failedExpiries.data?.length ?? 0) > 0;
  const reviewExclusions = useReviewExclusions(identityId);
  const showExclusions = reviewExclusions.isError || (reviewExclusions.data?.length ?? 0) > 0;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['identity', 'entitlements', identityId],
    queryFn: async () => {
      const res = await axiosInstance.get(`${API_BASE}/identity/${identityId}/entitlements`);
      return res.data;
    },
    retry: false,
    enabled: !!identityId,
  });

  const entitlements: EntitlementRow[] =
    data?.entitlements && Array.isArray(data.entitlements)
      ? data.entitlements.map(
          (
            e: {
              id?: string;
              entitlement?: string;
              name?: string;
              source?: string;
              policy?: string;
              targetSystem?: string;
              system?: string;
              status?: string;
            },
            i: number,
          ) => ({
            id: e.id ?? `e-${i}`,
            entitlement: e.entitlement ?? e.name ?? '—',
            source: e.source ?? e.policy ?? '—',
            targetSystem: e.targetSystem ?? e.system ?? '—',
            status: (e.status ?? 'Active') as EntitlementRow['status'],
          }),
        )
      : [];

  const columns: ColumnsType<EntitlementRow> = [
    { title: 'Entitlement', dataIndex: 'entitlement', key: 'entitlement' },
    { title: 'Source', dataIndex: 'source', key: 'source' },
    { title: 'Target System', dataIndex: 'targetSystem', key: 'targetSystem' },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={status === 'Active' ? 'green' : status === 'Revoked' ? 'red' : 'blue'}>
          {status}
        </Tag>
      ),
    },
  ];

  const useVirtual = entitlements.length > 100;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {showExpired && <ExpiredAccessPanel identityId={identityId} />}
      {!linkedLoading && linkedAdmins && linkedAdmins.length > 0 ? (
        <>
          <Text strong>
            <SafetyCertificateOutlined /> Linked Admin Accounts
          </Text>
          <Table
            size="small"
            rowKey="identityId"
            pagination={false}
            dataSource={linkedAdmins}
            columns={[
              { title: 'Admin ID', dataIndex: 'identityId', key: 'identityId', ellipsis: true },
              {
                title: 'Tier',
                dataIndex: 'adminTier',
                key: 'adminTier',
                render: (t: string) => (
                  <Tag color={t === 'TIER_0' ? 'red' : t === 'TIER_1' ? 'orange' : 'blue'}>{t}</Tag>
                ),
              },
              {
                title: 'Session',
                dataIndex: 'status',
                key: 'status',
                render: (_: string, r: LinkedAdminAccount) => <AdminSessionTags session={r} />,
              },
              {
                title: 'Actions',
                key: 'actions',
                render: (_: unknown, r: LinkedAdminAccount) =>
                  !mayRunSession ? null : (
                    <Space>
                      {canActivate(r.status) && (
                        <Button
                          type="link"
                          size="small"
                          onClick={() => handleActivate(r.identityId)}
                          loading={pendingId === r.identityId}
                        >
                          Activate
                        </Button>
                      )}
                      {canDeactivate(r.status) && (
                        <Button
                          type="link"
                          size="small"
                          danger
                          onClick={() => handleDeactivate(r.identityId)}
                          loading={pendingId === r.identityId}
                        >
                          Deactivate
                        </Button>
                      )}
                    </Space>
                  ),
              },
            ]}
            locale={{
              emptyText: (
                <EmptyState
                  title="No linked admin accounts"
                  description="This identity has no privileged access accounts."
                />
              ),
            }}
          />
        </>
      ) : null}
      <AccessReevaluationPanel identityId={identityId} />
      {showExclusions && <ReviewExclusionsPanel identityId={identityId} />}
      <Text strong>Entitlements</Text>
      {isLoading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : isError ? (
        <ErrorState
          compact
          title="Could not load entitlements"
          error={error}
          onRetry={() => refetch()}
        />
      ) : (
        <Table<EntitlementRow>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={entitlements}
          columns={columns}
          virtual={useVirtual}
          scroll={useVirtual ? { y: 400 } : undefined}
          locale={{
            emptyText: (
              <EmptyState
                title="No entitlements"
                description="Entitlements will appear once policies are evaluated."
              />
            ),
          }}
        />
      )}
    </Space>
  );
};
