/**
 * Credential policies (policy-admin, like every /credential-lifecycle/policies route): what each
 * applies to, the maximum password age and the warning window the nightly check uses, on or off.
 * Create and edit in CredentialPolicyFormModal; delete removes the policy for good after a
 * confirmation. The list reloads after every change.
 */
import React, { useState } from 'react';
import { App, Button, Skeleton, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useCredentialPolicies, useDeleteCredentialPolicy } from '@api/credential-lifecycle-api';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import type { ICredentialPolicy } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { CredentialPolicyFormModal } from './CredentialPolicyFormModal';
import { employmentTypeLabel, systemLabel } from './credential-labels';

const { Text } = Typography;

const TABLE_MIN_WIDTH = 900;

const DELETE_CONSEQUENCE =
  'The policy is deleted for good. From the next nightly check, the accounts it covered get the ' +
  'next most specific active policy, or show as could not be checked when none applies.';

function scopeText(list: string[] | undefined, label: (v: string) => string, all: string) {
  return list?.length ? list.map(label).join(', ') : all;
}

export const CredentialPoliciesTab: React.FC = () => {
  const { modal, message } = App.useApp();
  const list = useCredentialPolicies(true);
  const remove = useDeleteCredentialPolicy();
  /** null: closed; 'new': create; a policy: edit it. */
  const [editing, setEditing] = useState<ICredentialPolicy | 'new' | null>(null);

  const confirmDelete = (policy: ICredentialPolicy) => {
    modal.confirm({
      title: `Delete "${policy.name}"?`,
      content: DELETE_CONSEQUENCE,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await remove.mutateAsync(policy._id);
          message.success(`Policy "${policy.name}" deleted`);
        } catch (err) {
          message.error(`Delete failed: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });
  };

  const columns: ColumnsType<ICredentialPolicy> = [
    {
      title: 'Policy',
      key: 'name',
      width: 220,
      render: (_: unknown, p) => (
        <div style={{ minWidth: 0 }}>
          <Text strong style={{ wordBreak: 'break-word' }}>
            {p.name}
          </Text>
          {p.description && (
            <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              {p.description}
            </Text>
          )}
        </div>
      ),
    },
    {
      title: 'Applies to',
      key: 'scope',
      render: (_: unknown, p) => (
        <div style={{ wordBreak: 'break-word' }}>
          <div>{scopeText(p.targetScope?.connectorTypes, systemLabel, 'Every system')}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {scopeText(
              p.targetScope?.employmentTypes,
              employmentTypeLabel,
              'Every employment type',
            )}
          </Text>
        </div>
      ),
    },
    {
      title: 'Maximum age',
      key: 'maxAge',
      width: 120,
      render: (_: unknown, p) =>
        p.passwordPolicy?.maxAgeDays ? `${p.passwordPolicy.maxAgeDays} days` : 'Not set',
    },
    {
      title: 'Warn before',
      key: 'warn',
      width: 110,
      render: (_: unknown, p) => `${p.rotationPolicy?.notifyDaysBefore ?? 14} days`,
    },
    {
      title: 'Status',
      key: 'status',
      width: 100,
      render: (_: unknown, p) => (
        <Tag color={p.isActive ? 'success' : 'default'}>{p.isActive ? 'Active' : 'Inactive'}</Tag>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 190,
      render: (_: unknown, p) => (
        <Space size={4} wrap>
          <Button
            size="small"
            icon={<EditOutlined />}
            aria-label={`Edit ${p.name}`}
            onClick={() => setEditing(p)}
          >
            Edit
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            aria-label={`Delete ${p.name}`}
            onClick={() => confirmDelete(p)}
          >
            Delete
          </Button>
        </Space>
      ),
    },
  ];

  const policies = list.data ?? [];
  let body: React.ReactNode;
  if (list.isLoading) {
    body = <Skeleton active paragraph={{ rows: 4 }} />;
  } else if (list.isError) {
    body = (
      <ErrorState
        title="Could not load the credential policies"
        error={list.error}
        onRetry={() => list.refetch()}
      />
    );
  } else if (!policies.length) {
    body = (
      <EmptyState
        title="No credential policies yet"
        description="Without a policy every account shows as could not be checked: the policy sets the maximum password age."
        action={{
          label: 'Create the first policy',
          icon: <PlusOutlined />,
          onClick: () => setEditing('new'),
        }}
      />
    );
  } else {
    body = (
      <Table<ICredentialPolicy>
        size="small"
        rowKey="_id"
        aria-label="Credential policies"
        columns={columns}
        dataSource={policies}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: TABLE_MIN_WIDTH }}
      />
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text type="secondary">
          The most specific active policy applies to each account: the one naming its system first,
          then the one naming its employment type.
        </Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
          New policy
        </Button>
      </Space>
      {body}
      {editing && (
        <CredentialPolicyFormModal
          policy={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Space>
  );
};
