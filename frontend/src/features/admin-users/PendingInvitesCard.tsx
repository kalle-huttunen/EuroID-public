/**
 * The tenant's pending invites (unused, unexpired): who was invited with which role, by whom and
 * until when, with [Cancel invite] after a confirmation. The API never answers an invite's code,
 * so none is shown: it is shown once, when the invite is created.
 */
import React from 'react';
import { App, Button, Card, Skeleton, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCancelInvite, usePendingInvites } from '@api/admin-users-api';
import { ErrorState } from '@shared/ErrorState';
import type { IAdminUser, IPendingInvite } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { ROLE_LABEL } from './admin-user-labels';

const { Paragraph, Text } = Typography;

/** Below this width (phones) the table scrolls sideways. */
const TABLE_MIN_WIDTH = 760;

/** The inviter as the page can name them: you, an admin of the list, or the id the API holds. */
function inviterName(createdBy: string, admins: IAdminUser[], mySub?: string): string {
  if (mySub && createdBy === mySub) return 'You';
  if (createdBy === 'emergency-admin') return 'Emergency access';
  return admins.find((a) => a.id === createdBy)?.name ?? createdBy;
}

export const PendingInvitesCard: React.FC<{ admins: IAdminUser[]; mySub?: string }> = ({
  admins,
  mySub,
}) => {
  const { modal, message } = App.useApp();
  const invites = usePendingInvites();
  const cancel = useCancelInvite();

  const confirmCancel = (invite: IPendingInvite) =>
    modal.confirm({
      title: `Cancel the invite for ${invite.email}?`,
      content:
        'Its code stops working at once: nobody can register with it. You can invite the address again later.',
      okText: 'Cancel invite',
      okButtonProps: { danger: true },
      cancelText: 'Keep invite',
      onOk: async () => {
        try {
          await cancel.mutateAsync(invite.id);
          message.success(`The invite for ${invite.email} is cancelled.`);
        } catch (err) {
          message.error(`Not cancelled: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });

  const columns: ColumnsType<IPendingInvite> = [
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      width: 240,
      render: (email: string) => <Text ellipsis={{ tooltip: email }}>{email}</Text>,
    },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      width: 140,
      render: (role: IPendingInvite['role']) => <Tag>{ROLE_LABEL[role] ?? role}</Tag>,
    },
    {
      title: 'Invited by',
      dataIndex: 'createdBy',
      key: 'createdBy',
      width: 160,
      render: (createdBy: string) => {
        const name = inviterName(createdBy, admins, mySub);
        return (
          <Text ellipsis={{ tooltip: name === createdBy ? createdBy : undefined }}>{name}</Text>
        );
      },
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 140,
      render: (iso?: string) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: 'Expires',
      dataIndex: 'expiresAt',
      key: 'expiresAt',
      width: 140,
      render: (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_: unknown, invite) => (
        <Tooltip title="Cancel invite">
          <Button
            size="small"
            danger
            icon={<StopOutlined />}
            aria-label={`Cancel the invite for ${invite.email}`}
            disabled={cancel.isPending}
            onClick={() => confirmCancel(invite)}
          />
        </Tooltip>
      ),
    },
  ];

  let body: React.ReactNode;
  if (invites.isLoading) {
    body = <Skeleton active paragraph={{ rows: 2 }} />;
  } else if (invites.isError) {
    body = (
      <ErrorState
        title="Could not load the pending invites"
        error={invites.error}
        onRetry={() => invites.refetch()}
      />
    );
  } else if (!invites.data?.length) {
    body = <Text type="secondary">No pending invites.</Text>;
  } else {
    body = (
      <Table<IPendingInvite>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={invites.data}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: TABLE_MIN_WIDTH }}
      />
    );
  }

  return (
    <Card
      size="small"
      title="Pending invites"
      role="region"
      aria-label="Pending invites"
      aria-busy={invites.isFetching}
      style={{ marginTop: 16 }}
    >
      {body}
      <Paragraph type="secondary" style={{ margin: '12px 0 0', fontSize: 12 }}>
        An invite is valid once, for 72 hours. Its code is shown only when you create it.
      </Paragraph>
    </Card>
  );
};
