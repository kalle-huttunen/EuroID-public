/**
 * OrphanedAccountsList – table of orphaned accounts with Adopt/Delete actions.
 * Fetches from GET /api/v1/reconciliation/drifts?type=ORPHAN_ACCOUNT.
 */

import React, { useState } from 'react';
import { App, Table, Tag, Space, Button, Select, Typography, Skeleton, Modal, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  UserOutlined,
  DeleteOutlined,
  LinkOutlined,
  ExclamationCircleFilled,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchOrphans,
  fetchOrphanStats,
  signalOrphan,
  simulateOrphanDelete,
  reconciliationKeys,
} from '@api/reconciliation-api';
import { fetchIdentitiesForSelect, identityKeys } from '@api/identity-api';
import { relativeTime } from '../../utils/date-helpers';
import { EmptyState } from '../../components/common/EmptyState';
import type { IOrphanDrift } from '../../interfaces/reconciliation.interface';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text } = Typography;

/**
 * EuroID never deletes an Active Directory account (no recycle bin guarantee, and a deleted
 * account's SID is lost): the API refuses the delete, so the list offers none.
 */
const isNeverDeleted = (targetSystem: string) =>
  ['ad', 'activedirectory'].includes(targetSystem.toLowerCase().replace(/-/g, ''));

const STATUS_COLORS: Record<string, string> = {
  quarantined: 'orange',
  corrected: 'green',
  ignored: 'default',
  open: 'blue',
};

export const OrphanedAccountsList: React.FC = () => {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [targetFilter, setTargetFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [adoptModal, setAdoptModal] = useState<{ drift: IOrphanDrift; identityId: string } | null>(
    null,
  );

  const { data: orphanResult, isLoading } = useQuery({
    queryKey: reconciliationKeys.orphans({
      page,
      targetSystem: targetFilter !== 'all' ? targetFilter : undefined,
      status: statusFilter !== 'all' ? statusFilter : undefined,
    }),
    queryFn: () =>
      fetchOrphans({
        page,
        limit: 50,
        targetSystem: targetFilter !== 'all' ? targetFilter : undefined,
        status: statusFilter !== 'all' ? statusFilter : undefined,
      }),
  });

  const { data: stats } = useQuery({
    queryKey: reconciliationKeys.orphanStats(),
    queryFn: fetchOrphanStats,
  });

  const { data: identities = [], isLoading: identitiesLoading } = useQuery({
    queryKey: identityKeys.listForSelect(),
    queryFn: () => fetchIdentitiesForSelect({ limit: 500 }),
    enabled: !!adoptModal,
  });

  const adoptMutation = useMutation({
    mutationFn: ({ driftId, identityId }: { driftId: string; identityId: string }) =>
      signalOrphan(driftId, 'ADOPT', identityId),
    onSuccess: () => {
      message.success('Adopt signal sent');
      setAdoptModal(null);
      queryClient.invalidateQueries({ queryKey: reconciliationKeys.orphans() });
      queryClient.invalidateQueries({ queryKey: reconciliationKeys.orphanStats() });
    },
    // The API says why (a drift already decided is 409, Temporal unreachable names that). The
    // toast is not returned: React Query would keep the mutation pending until it closes.
    onError: (err) => {
      message.error(apiErrorMessage(err, 'Failed to send adopt signal'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (driftId: string) => signalOrphan(driftId, 'DELETE'),
    onSuccess: () => {
      message.success('Delete signal sent');
      queryClient.invalidateQueries({ queryKey: reconciliationKeys.orphans() });
      queryClient.invalidateQueries({ queryKey: reconciliationKeys.orphanStats() });
    },
    onError: (err) => {
      message.error(apiErrorMessage(err, 'Failed to send delete signal'));
    },
  });

  const handleDelete = async (drift: IOrphanDrift) => {
    let impact = `This will permanently delete ${drift.userDisplayName || drift.userEmail} from ${drift.targetSystem}. This action cannot be undone.`;
    try {
      const sim = await simulateOrphanDelete(drift.id);
      if (sim?.impact) impact = sim.impact;
    } catch {
      // Fallback to basic message if simulation fails
    }
    modal.confirm({
      title: 'Delete orphaned account?',
      icon: <ExclamationCircleFilled />,
      content: (
        <div>
          <Text strong>Simulation:</Text>
          <p style={{ marginTop: 8, marginBottom: 0 }}>{impact}</p>
        </div>
      ),
      okText: 'Delete',
      okType: 'danger',
      onOk: () => deleteMutation.mutate(drift.id),
    });
  };

  const drifts = orphanResult?.drifts ?? [];
  const total = orphanResult?.total ?? 0;
  const targetSystems = Array.from(new Set(drifts.map((d) => d.targetSystem))).sort();

  const columns: ColumnsType<IOrphanDrift> = [
    {
      title: 'System',
      dataIndex: 'targetSystem',
      key: 'targetSystem',
      width: 140,
      render: (t: string) => <Tag>{t}</Tag>,
    },
    {
      title: 'Account',
      key: 'account',
      width: 260,
      render: (_, record) => (
        <Space>
          <UserOutlined />
          <Space direction="vertical" size={0}>
            <Text strong>{record.userDisplayName || record.orphanDetails?.accountName || '—'}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.userEmail}
            </Text>
          </Space>
        </Space>
      ),
    },
    {
      title: 'Discovered',
      dataIndex: 'detectedAt',
      key: 'detectedAt',
      width: 120,
      render: (iso: string) => <Text type="secondary">{relativeTime(iso)}</Text>,
    },
    {
      title: 'Grace period',
      key: 'gracePeriod',
      width: 140,
      render: (_, record) => {
        const endsAt = record.orphanDetails?.gracePeriodEndsAt;
        if (!endsAt) return '—';
        const d = new Date(endsAt);
        const now = new Date();
        const daysLeft = Math.ceil((d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        return daysLeft > 0 ? (
          <Text type="warning">{daysLeft}d left</Text>
        ) : (
          <Text type="secondary">Ended</Text>
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s: string, record) => (
        <Space size={4} wrap>
          <Tag color={STATUS_COLORS[s] ?? 'default'}>{s ?? 'quarantined'}</Tag>
          {record.orphanDetails?.keptReason && (
            <Tooltip title={record.orphanDetails.keptReason}>
              <Tag>Kept, never deleted</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          {record.status === 'quarantined' && (
            <>
              <Button
                type="link"
                size="small"
                icon={<LinkOutlined />}
                onClick={() => setAdoptModal({ drift: record, identityId: '' })}
              >
                Adopt
              </Button>
              {!isNeverDeleted(record.targetSystem) && (
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => handleDelete(record)}
                >
                  Delete
                </Button>
              )}
            </>
          )}
        </Space>
      ),
    },
  ];

  if (isLoading) {
    return <Skeleton active paragraph={{ rows: 8 }} />;
  }

  return (
    <div style={{ padding: '0 24px 24px' }}>
      {stats && (
        <Space wrap style={{ marginBottom: 16 }} size="large">
          <Text>
            Total: <Text strong>{stats.total}</Text>
          </Text>
          <Text>
            Quarantined: <Text strong>{stats.quarantined}</Text>
          </Text>
          <Text>
            Resolved: <Text strong>{stats.resolved}</Text>
          </Text>
        </Space>
      )}
      <Space wrap style={{ marginBottom: 16 }} size="middle">
        <Select
          value={targetFilter}
          onChange={setTargetFilter}
          style={{ width: 180 }}
          options={[
            { value: 'all', label: 'All systems' },
            ...targetSystems.map((t) => ({ value: t, label: t })),
          ]}
        />
        <Select
          value={statusFilter}
          onChange={setStatusFilter}
          style={{ width: 140 }}
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'quarantined', label: 'Quarantined' },
            { value: 'corrected', label: 'Corrected' },
            { value: 'ignored', label: 'Ignored' },
          ]}
        />
      </Space>
      <Table<IOrphanDrift>
        rowKey="id"
        columns={columns}
        dataSource={drifts}
        scroll={{ x: 900 }}
        pagination={{
          current: page,
          pageSize: 50,
          total,
          onChange: setPage,
          showTotal: (t, range) => `${range[0]}-${range[1]} of ${t}`,
        }}
        locale={{
          emptyText: (
            <EmptyState
              title="No orphaned accounts"
              description="All target system accounts are linked to known identities."
            />
          ),
        }}
      />
      <Modal
        title="Adopt orphaned account"
        open={!!adoptModal}
        onCancel={() => setAdoptModal(null)}
        onOk={() => {
          if (adoptModal?.identityId) {
            adoptMutation.mutate({
              driftId: adoptModal.drift.id,
              identityId: adoptModal.identityId,
            });
          } else {
            message.warning('Select an identity to adopt');
          }
        }}
        confirmLoading={adoptMutation.isPending}
        okText="Adopt"
      >
        {adoptModal && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text>
              Link <strong>{adoptModal.drift.userDisplayName || adoptModal.drift.userEmail}</strong>{' '}
              to an identity.
            </Text>
            <div>
              <Text type="secondary">Select identity:</Text>
              <Select
                showSearch
                placeholder="Search by name or email..."
                value={adoptModal.identityId || undefined}
                onChange={(val) => setAdoptModal({ ...adoptModal, identityId: val ?? '' })}
                style={{ width: '100%', marginTop: 8 }}
                loading={identitiesLoading}
                optionFilterProp="label"
                filterOption={(input, opt) =>
                  (opt?.label ?? '').toLowerCase().includes(input.toLowerCase())
                }
                options={identities.map((i) => ({
                  value: i.id,
                  label: i.displayName
                    ? `${i.displayName}${i.email ? ` (${i.email})` : ''}`
                    : i.email || i.id,
                }))}
                notFoundContent={identitiesLoading ? 'Loading...' : 'No identities found'}
              />
            </div>
          </Space>
        )}
      </Modal>
    </div>
  );
};
