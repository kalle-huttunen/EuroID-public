/**
 * DriftTab – discrepancy view for an identity.
 * Diff-style table with red/green highlighting, Fix button.
 */

import React from 'react';
import { App, Table, Typography, Button, Space, Tag, Skeleton, theme } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchDrifts, correctDrift, reconciliationKeys } from '@api/reconciliation-api';
import type { IDrift, DriftType, DriftSeverity } from '../../../interfaces';
import type { ColumnsType } from 'antd/es/table';
import { DRIFT_TYPE_LABELS } from '../../../interfaces/reconciliation.interface';
import { relativeTime } from '../../../utils/date-helpers';
import { EmptyState } from '../../../components/common/EmptyState';
import { apiErrorMessage } from '../../dead-letter/dead-letter-labels';

const { Text } = Typography;

export interface DriftTabProps {
  identityId: string;
}

export const DriftTab: React.FC<DriftTabProps> = ({ identityId }) => {
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const { data: drifts = [], isLoading } = useQuery({
    queryKey: reconciliationKeys.drifts({ identityId }),
    queryFn: () => fetchDrifts({ identityId }),
    enabled: !!identityId,
  });

  const correctMutation = useMutation({
    mutationFn: correctDrift,
    onSuccess: () => {
      // Every drift list (badge, Profile, map, Reconciliation page): the drift leaves them all.
      queryClient.invalidateQueries({ queryKey: reconciliationKeys.driftsPrefix() });
      message.success('Drift correction initiated');
    },
    onError: (err) => {
      message.error(apiErrorMessage(err, 'Failed to correct drift'));
    },
  });

  const columns: ColumnsType<IDrift> = [
    {
      title: 'Field',
      dataIndex: 'field',
      key: 'field',
      width: 120,
      render: (v: string) => v ?? '—',
    },
    {
      title: 'Expected (Hub)',
      dataIndex: 'hubValue',
      key: 'hubValue',
      width: 140,
      render: (v: string) =>
        v ? (
          <Text
            style={{ backgroundColor: token.colorSuccessBg, padding: '2px 6px', borderRadius: 4 }}
          >
            {v} <span style={{ fontSize: 10, opacity: 0.8 }}>(expected)</span>
          </Text>
        ) : (
          '—'
        ),
    },
    {
      title: 'Actual (Target)',
      dataIndex: 'targetValue',
      key: 'targetValue',
      width: 140,
      render: (v: string) =>
        v ? (
          <Text
            style={{ backgroundColor: token.colorErrorBg, padding: '2px 6px', borderRadius: 4 }}
          >
            {v} <span style={{ fontSize: 10, opacity: 0.8 }}>(actual)</span>
          </Text>
        ) : (
          '—'
        ),
    },
    {
      title: 'Connector',
      dataIndex: 'targetSystem',
      key: 'targetSystem',
      width: 140,
      render: (t: string) => (t ? <Tag>{t}</Tag> : '—'),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 120,
      render: (t: DriftType) => <Tag>{DRIFT_TYPE_LABELS[t] ?? t}</Tag>,
    },
    {
      title: 'Detected',
      dataIndex: 'detectedAt',
      key: 'detectedAt',
      width: 100,
      render: (iso: string) => <Text type="secondary">{relativeTime(iso)}</Text>,
    },
    {
      title: 'Action',
      key: 'action',
      width: 100,
      render: (_, record) =>
        record.autoCorrectEligible ? (
          <Button
            type="link"
            size="small"
            icon={<ThunderboltOutlined />}
            loading={correctMutation.isPending}
            onClick={() => correctMutation.mutate(record.id)}
          >
            Fix
          </Button>
        ) : null,
    },
  ];

  if (isLoading) {
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }

  if (drifts.length === 0) {
    return (
      <EmptyState
        title="Identity in sync"
        description="No drift detected — this identity matches across all connected systems."
      />
    );
  }

  return (
    <Table<IDrift>
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={drifts}
      columns={columns}
      scroll={{ x: 800 }}
    />
  );
};
