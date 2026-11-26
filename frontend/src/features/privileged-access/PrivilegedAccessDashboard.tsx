/**
 * Privileged Access Dashboard — list all admin accounts across identities
 */
import React from 'react';
import { Table, Typography, Skeleton, Space, Tag, Button } from 'antd';
import { EmptyState } from '../../components/common/EmptyState';
import { useAllAdminAccounts, type AdminAccountRow } from '@api/privileged-access-api';
import { AdminSessionTags } from './admin-session';
import {
  canActivate,
  canDeactivate,
  useAdminSessionActions,
  useMayRunAdminSession,
} from './admin-session-actions';
import type { ColumnsType } from 'antd/es/table';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { ErrorState } from '@shared/ErrorState';

const { Text } = Typography;

export const PrivilegedAccessDashboard: React.FC = () => {
  const { data: adminAccounts, isLoading, isError, error, refetch } = useAllAdminAccounts();
  const { handleActivate, handleDeactivate, pendingId } = useAdminSessionActions();
  const mayRunSession = useMayRunAdminSession();

  const columns: ColumnsType<AdminAccountRow> = [
    {
      title: 'Admin UPN',
      dataIndex: 'adminEmail',
      key: 'adminEmail',
      render: (email: string) => (
        <Text strong copyable className="mono">
          {email}
        </Text>
      ),
    },
    {
      title: 'Parent Identity',
      dataIndex: 'parentEmail',
      key: 'parentEmail',
    },
    {
      title: 'Tier',
      dataIndex: 'adminTier',
      key: 'adminTier',
      render: (tier: string) => (
        <Tag color={tier === 'TIER_0' ? 'red' : tier === 'TIER_1' ? 'orange' : 'blue'}>{tier}</Tag>
      ),
    },
    {
      title: 'Session',
      dataIndex: 'status',
      key: 'status',
      render: (_: string, record: AdminAccountRow) => (
        <Space size={4} wrap>
          <AdminSessionTags session={record} />
          {record.parentDeleted && <Tag color="red">Parent identity deleted</Tag>}
        </Space>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, record: AdminAccountRow) =>
        !mayRunSession(record.parentEmail) ? null : (
          <Space>
            {/* The API refuses to activate the account of a deleted identity */}
            {canActivate(record.status) && !record.parentDeleted && (
              <Button
                type="link"
                size="small"
                onClick={() => handleActivate(record.adminIdentityId)}
                loading={pendingId === record.adminIdentityId}
              >
                Activate
              </Button>
            )}
            {canDeactivate(record.status) && (
              <Button
                type="link"
                size="small"
                danger
                onClick={() => handleDeactivate(record.adminIdentityId)}
                loading={pendingId === record.adminIdentityId}
              >
                Deactivate
              </Button>
            )}
          </Space>
        ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Privileged access"
        subtitle="Admin identities linked to privileged roles, kept separate from daily-driver accounts. Their accounts stay disabled in the target systems until a session activates them, for the tier's maximum session length."
      />
      {isLoading ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : isError || !adminAccounts ? (
        <ErrorState title="Could not load admin accounts" error={error} onRetry={() => refetch()} />
      ) : (
        <Table<AdminAccountRow>
          rowKey="adminIdentityId"
          dataSource={adminAccounts}
          columns={columns}
          pagination={{ pageSize: 20 }}
          locale={{
            emptyText: (
              <EmptyState
                title="No admin accounts yet"
                description="Link admin accounts to identities to enable privileged access management."
              />
            ),
          }}
        />
      )}
    </PageContainer>
  );
};
