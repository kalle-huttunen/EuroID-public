/** Decided HR joiner batches: who approved or rejected what, and how many onboarding runs started. */
import React from 'react';
import { Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useJoinerBatches } from '@api/joiners-api';
import { EmptyState } from '../../components/common/EmptyState';
import type { IJoinerBatch } from '../../interfaces';
import { JoinerItemsTable } from './JoinerItemsTable';
import { BATCH_STATUS_LABEL, BATCH_STATUS_TAG } from './leaver-labels';

const { Text } = Typography;

const columns: ColumnsType<IJoinerBatch> = [
  {
    title: 'Decided',
    key: 'decidedAt',
    render: (_: unknown, b) => (b.decidedAt ? dayjs(b.decidedAt).format('YYYY-MM-DD HH:mm') : '-'),
  },
  {
    title: 'Source',
    dataIndex: 'sourceName',
    key: 'sourceName',
    render: (s: string) => <Text code>{s}</Text>,
  },
  { title: 'Joiners', dataIndex: 'identityCount', key: 'identityCount' },
  {
    title: 'Decision',
    key: 'status',
    render: (_: unknown, b) => (
      <Tag color={BATCH_STATUS_TAG[b.status]}>{BATCH_STATUS_LABEL[b.status]}</Tag>
    ),
  },
  { title: 'Decided by', dataIndex: 'decidedBy', key: 'decidedBy' },
  {
    title: 'Onboarding runs started',
    key: 'startedCount',
    render: (_: unknown, b) => (b.status === 'approved' ? (b.startedCount ?? 0) : '-'),
  },
  {
    title: 'Comment',
    dataIndex: 'comment',
    key: 'comment',
    render: (c?: string) => c ?? <Text type="secondary">-</Text>,
  },
];

export const JoinerBatchHistory: React.FC = () => {
  const { data, isLoading } = useJoinerBatches();
  const decided = (data ?? []).filter((b) => b.status !== 'pending');
  return (
    <Table<IJoinerBatch>
      rowKey="id"
      loading={isLoading}
      columns={columns}
      dataSource={decided}
      pagination={false}
      scroll={{ x: 'max-content' }}
      expandable={{ expandedRowRender: (b) => <JoinerItemsTable items={b.items} /> }}
      locale={{
        emptyText: (
          <EmptyState
            title="No joiner decisions yet"
            description="Approved and rejected joiner batches appear here."
          />
        ),
      }}
    />
  );
};
