/**
 * Admin users: the people who can sign in to this EuroID console (not the identities EuroID
 * manages). A super-admin lists the tenant's admins with role, sign-in method, MFA, status and
 * last sign-in, invites a new one (centered modal, the invite code shown once), lists and cancels
 * pending invites, changes an admin's role, issues a password reset code (shown once), revokes an
 * admin's sessions, and deactivates or reactivates an account. Route, nav entry and every route
 * of the API need super-admin.
 */
import React, { useState } from 'react';
import { Button, Card, Result, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, UserAddOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { adminUserKeys, useAdminUsers } from '@api/admin-users-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import { useAuthContext } from '../../auth/auth-context';
import { usePermission } from '../../auth/usePermission';
import type { IAdminUser, IPasswordResetCode } from '../../interfaces';
import { PLATFORM_ADMIN_REASON, ROLE_LABEL } from './admin-user-labels';
import { AdminRowActions } from './AdminRowActions';
import { ChangeRoleModal } from './ChangeRoleModal';
import { InviteAdminModal } from './InviteAdminModal';
import { PendingInvitesCard } from './PendingInvitesCard';
import { ResetCodeModal } from './ResetCodeModal';
import { useAdminActions } from './useAdminActions';

const { Paragraph, Text } = Typography;

/**
 * The sum of the column widths. It fits the card at 1440 px with the sidebar open (1118 px card,
 * 1092 px inside its padding), so the row actions show without scrolling; below it (phones) the
 * table scrolls sideways inside the card instead of squeezing every column.
 */
const TABLE_MIN_WIDTH = 1060;

export const AdminUsersPage: React.FC = () => {
  const qc = useQueryClient();
  const isSuperAdmin = usePermission('super-admin');
  const mySub = useAuthContext().user?.profile?.sub;
  const list = useAdminUsers(isSuperAdmin);
  const actions = useAdminActions(mySub);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleFor, setRoleFor] = useState<IAdminUser | null>(null);
  const [resetCode, setResetCode] = useState<{
    admin: IAdminUser;
    code: IPasswordResetCode;
  } | null>(null);

  const admins = list.data ?? [];

  const columns: ColumnsType<IAdminUser> = [
    {
      title: 'Admin',
      key: 'admin',
      width: 240,
      render: (_: unknown, admin) => (
        <div style={{ minWidth: 0 }}>
          <Space size={6} wrap>
            <Text strong>{admin.name}</Text>
            {actions.isMe(admin) && <Tag style={{ marginInlineEnd: 0 }}>You</Tag>}
            {admin.isPlatformAdmin && (
              <Tooltip title={PLATFORM_ADMIN_REASON}>
                <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                  Platform admin
                </Tag>
              </Tooltip>
            )}
          </Space>
          <Text
            type="secondary"
            ellipsis={{ tooltip: admin.email }}
            style={{ display: 'block', fontSize: 12 }}
          >
            {admin.email}
          </Text>
        </div>
      ),
    },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      width: 140,
      render: (role: IAdminUser['role']) => (
        <Tag color={role === 'super-admin' ? 'processing' : undefined}>
          {ROLE_LABEL[role] ?? role}
        </Tag>
      ),
    },
    {
      title: 'Sign-in',
      dataIndex: 'authSource',
      key: 'authSource',
      width: 120,
      render: (source: IAdminUser['authSource']) =>
        source === 'saml' ? 'Single sign-on' : 'Password',
    },
    {
      title: 'MFA',
      key: 'mfa',
      width: 70,
      render: (_: unknown, admin) => {
        if (admin.mfaEnabled) return <Tag color="success">On</Tag>;
        return admin.authSource === 'saml' ? (
          <Tooltip title="Not set up in EuroID. The identity provider may ask for a second factor.">
            <Tag>Off</Tag>
          </Tooltip>
        ) : (
          <Tag color="warning">Off</Tag>
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'isActive',
      key: 'status',
      width: 110,
      render: (active: boolean) =>
        active ? <Tag color="success">Active</Tag> : <Tag>Deactivated</Tag>,
    },
    {
      title: 'Added',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 100,
      render: (iso?: string) => (iso ? dayjs(iso).format('YYYY-MM-DD') : '-'),
    },
    {
      title: 'Last sign-in',
      dataIndex: 'lastLoginAt',
      key: 'lastLoginAt',
      width: 150,
      render: (iso: string | null) =>
        iso ? (
          dayjs(iso).format('YYYY-MM-DD HH:mm')
        ) : (
          <Tooltip title="No sign-in recorded since EuroID started recording them.">
            <Text type="secondary">Never</Text>
          </Tooltip>
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 130,
      render: (_: unknown, admin) => (
        <AdminRowActions
          admin={admin}
          actions={actions}
          onChangeRole={setRoleFor}
          onResetPassword={(target) =>
            actions.confirmPasswordReset(target, (code) => setResetCode({ admin: target, code }))
          }
        />
      ),
    },
  ];

  if (!isSuperAdmin) {
    return (
      <PageContainer>
        <PageHeader title="Admin users" />
        <Result status="403" title="Admin users need the super-admin role." />
      </PageContainer>
    );
  }

  let body: React.ReactNode;
  if (list.isLoading) {
    body = <Skeleton active paragraph={{ rows: 4 }} />;
  } else if (list.isError) {
    body = (
      <ErrorState
        title="Could not load the admin users"
        error={list.error}
        onRetry={() => list.refetch()}
      />
    );
  } else if (!admins.length) {
    body = (
      <EmptyState
        title="No admin users in this tenant"
        description="People who sign in through OIDC are not stored here. Invite someone to give them an account of their own."
        action={{
          label: 'Invite admin',
          icon: <UserAddOutlined />,
          onClick: () => setInviteOpen(true),
        }}
      />
    );
  } else {
    body = (
      <Table<IAdminUser>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={admins}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: TABLE_MIN_WIDTH }}
      />
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Admin users"
        subtitle="People who can sign in to this EuroID console. The identities EuroID manages are in the Identity hub."
        actions={
          <>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => qc.invalidateQueries({ queryKey: adminUserKeys.all })}
            >
              Refresh
            </Button>
            <Button type="primary" icon={<UserAddOutlined />} onClick={() => setInviteOpen(true)}>
              Invite admin
            </Button>
          </>
        }
      />
      <Card size="small" role="region" aria-label="Admin users" aria-busy={list.isFetching}>
        {body}
        <Paragraph type="secondary" style={{ margin: '12px 0 0', fontSize: 12 }}>
          A role change applies from the admin's next request; they stay signed in. People who sign
          in through OIDC are not stored here.
        </Paragraph>
      </Card>
      <PendingInvitesCard admins={admins} mySub={mySub} />
      <InviteAdminModal
        open={inviteOpen}
        emailsInUse={admins.map((a) => a.email)}
        onClose={() => setInviteOpen(false)}
      />
      <ChangeRoleModal
        admin={roleFor}
        onChoose={(admin, role) => actions.confirmRoleChange(admin, role, () => setRoleFor(null))}
        onClose={() => setRoleFor(null)}
      />
      <ResetCodeModal issued={resetCode} onClose={() => setResetCode(null)} />
    </PageContainer>
  );
};
