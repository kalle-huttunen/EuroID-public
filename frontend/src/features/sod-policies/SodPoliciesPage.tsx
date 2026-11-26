/**
 * Segregation of duties: entitlement combinations one person must not hold together
 * (GET /sod-policies, every role). Policy-admins and super-admins create policies, change their
 * action and severity, turn them on or off and delete them, which only deactivates
 * (sod-policy.controller.ts guards). Where the policies act is in SodEnforcementPanel.
 */
import React, { useState } from 'react';
import {
  App,
  Button,
  Card,
  Segmented,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  sodPolicyKeys,
  useDeleteSodPolicy,
  useSodPolicies,
  useUpdateSodPolicy,
} from '@api/sod-policies-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import { usePermission } from '../../auth/usePermission';
import type { ISodPolicy } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { SodEnforcementPanel } from './SodEnforcementPanel';
import { SodEntitlementList } from './SodEntitlementList';
import { useEntitlementNames } from './useEntitlementNames';
import { SodPolicyFormModal } from './SodPolicyFormModal';
import {
  ACTION_LABEL,
  ACTION_TAG,
  DELETE_CONSEQUENCE,
  DELETE_DISABLED_REASON,
  SEVERITY_LABEL,
  SEVERITY_TAG,
  toggleConsequence,
} from './sod-labels';

const { Text } = Typography;

/** Below this width (phones) the table scrolls sideways instead of squeezing every column. */
const SOD_TABLE_MIN_WIDTH = 960;

type StatusFilter = 'all' | 'active' | 'inactive';

export const SodPoliciesPage: React.FC = () => {
  const qc = useQueryClient();
  const { modal, message } = App.useApp();
  const canEdit = usePermission('policy-admin');
  const list = useSodPolicies();
  const update = useUpdateSodPolicy();
  const remove = useDeleteSodPolicy();
  const [filter, setFilter] = useState<StatusFilter>('all');
  /** null: closed; 'new': create; a policy: edit it. */
  const [editing, setEditing] = useState<ISodPolicy | 'new' | null>(null);

  const policies = list.data ?? [];
  const lookup = useEntitlementNames(policies);
  const activeCount = policies.filter((p) => p.isActive).length;
  const shown = policies.filter((p) =>
    filter === 'all' ? true : filter === 'active' ? p.isActive : !p.isActive,
  );

  const confirmToggle = (policy: ISodPolicy) => {
    const verb = policy.isActive ? 'Turn off' : 'Turn on';
    modal.confirm({
      title: `${verb} "${policy.name}"?`,
      content: toggleConsequence(policy),
      okText: verb,
      okButtonProps: { danger: policy.isActive },
      onOk: async () => {
        try {
          await update.mutateAsync({ id: policy.id, changes: { isActive: !policy.isActive } });
          message.success(`Policy "${policy.name}" turned ${policy.isActive ? 'off' : 'on'}`);
        } catch (err) {
          message.error(`${verb} failed: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });
  };

  const confirmDelete = (policy: ISodPolicy) => {
    modal.confirm({
      title: `Delete "${policy.name}"?`,
      content: DELETE_CONSEQUENCE,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await remove.mutateAsync(policy.id);
          message.success(`Policy "${policy.name}" deleted. It stays in the list as inactive.`);
        } catch (err) {
          message.error(`Delete failed: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });
  };

  const columns: ColumnsType<ISodPolicy> = [
    {
      title: 'Policy',
      key: 'name',
      width: 240,
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
      title: 'Conflicting entitlements (all at once)',
      key: 'entitlements',
      render: (_: unknown, p) => (
        <SodEntitlementList entitlements={p.conflictingEntitlements} lookup={lookup} />
      ),
    },
    {
      title: 'Action',
      dataIndex: 'action',
      key: 'action',
      width: 90,
      render: (action: ISodPolicy['action']) => (
        <Tag color={ACTION_TAG[action]}>{ACTION_LABEL[action] ?? action}</Tag>
      ),
    },
    {
      title: 'Severity',
      dataIndex: 'severity',
      key: 'severity',
      width: 100,
      render: (severity: ISodPolicy['severity']) => (
        <Tag color={SEVERITY_TAG[severity]}>{SEVERITY_LABEL[severity] ?? severity}</Tag>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: canEdit ? 130 : 100,
      render: (_: unknown, p) =>
        canEdit ? (
          <Space size={6}>
            <Switch
              size="small"
              checked={p.isActive}
              loading={update.isPending && update.variables?.id === p.id}
              aria-label={`Active: ${p.name}`}
              onChange={() => confirmToggle(p)}
            />
            <Text>{p.isActive ? 'Active' : 'Inactive'}</Text>
          </Space>
        ) : (
          <Tag color={p.isActive ? 'success' : 'default'}>{p.isActive ? 'Active' : 'Inactive'}</Tag>
        ),
    },
    ...(canEdit
      ? [
          {
            title: '',
            key: 'actions',
            width: 190,
            render: (_: unknown, p: ISodPolicy) => (
              <Space size={4} wrap>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  aria-label={`Edit ${p.name}`}
                  onClick={() => setEditing(p)}
                >
                  Edit
                </Button>
                <Tooltip title={p.isActive ? undefined : DELETE_DISABLED_REASON}>
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={`Delete ${p.name}`}
                    disabled={!p.isActive}
                    onClick={() => confirmDelete(p)}
                  >
                    Delete
                  </Button>
                </Tooltip>
              </Space>
            ),
          },
        ]
      : []),
  ];

  let body: React.ReactNode;
  if (list.isLoading) {
    body = <Skeleton active paragraph={{ rows: 5 }} />;
  } else if (list.isError) {
    body = (
      <ErrorState
        title="Could not load the SoD policies"
        error={list.error}
        onRetry={() => list.refetch()}
      />
    );
  } else if (!policies.length) {
    body = (
      <EmptyState
        title="No SoD policies yet"
        description="A policy names entitlements one person must not hold together, for example creating vendors and approving their payments."
        action={
          canEdit
            ? {
                label: 'Create the first policy',
                icon: <PlusOutlined />,
                onClick: () => setEditing('new'),
              }
            : undefined
        }
      />
    );
  } else if (!shown.length) {
    body = (
      <EmptyState
        title={`No ${filter} policies`}
        action={{ label: 'Show all', type: 'default', onClick: () => setFilter('all') }}
      />
    );
  } else {
    body = (
      <Table<ISodPolicy>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={shown}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: SOD_TABLE_MIN_WIDTH }}
      />
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Segregation of duties"
        subtitle="Entitlements one person must not hold together. Block refuses or stops what would grant them all; Warn reports it."
        actions={
          <>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => qc.invalidateQueries({ queryKey: sodPolicyKeys.all })}
            >
              Refresh
            </Button>
            {canEdit && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
                New policy
              </Button>
            )}
          </>
        }
      />
      <div style={{ marginBottom: 16 }}>
        <SodEnforcementPanel />
      </div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap size="middle" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Segmented<StatusFilter>
            aria-label="Status filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All (${policies.length})` },
              { value: 'active', label: `Active (${activeCount})` },
              { value: 'inactive', label: `Inactive (${policies.length - activeCount})` },
            ]}
          />
          {!canEdit && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Creating and changing policies needs the policy-admin role.
            </Text>
          )}
        </Space>
      </Card>
      <Card size="small" role="region" aria-label="SoD policies" aria-busy={list.isFetching}>
        {body}
      </Card>
      {editing && (
        <SodPolicyFormModal
          policy={editing === 'new' ? undefined : editing}
          lookup={lookup}
          onClose={() => setEditing(null)}
        />
      )}
    </PageContainer>
  );
};
