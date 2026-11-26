/** Decided leaver batches: who approved or rejected what, and how many offboardings started. */
import React from 'react';
import { Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useLeaverBatches } from '@api/leavers-api';
import { EmptyState } from '../../components/common/EmptyState';
import type { ILeaverBatch } from '../../interfaces';
import { LeaverItemsTable } from './LeaverItemsTable';
import { BATCH_STATUS_LABEL, BATCH_STATUS_TAG } from './leaver-labels';

const { Text } = Typography;

/** Below this width (phones) the table scrolls sideways; above it Comment takes the rest. */
const BATCH_TABLE_MIN_WIDTH = 960;

const columns: ColumnsType<ILeaverBatch> = [
  {
    title: 'Decided',
    key: 'decidedAt',
    width: 150,
    render: (_: unknown, b) => (b.decidedAt ? dayjs(b.decidedAt).format('YYYY-MM-DD HH:mm') : '-'),
  },
  {
    title: 'Source',
    dataIndex: 'sourceName',
    key: 'sourceName',
    width: 140,
    render: (s: string) => <Text code>{s}</Text>,
  },
  { title: 'Leavers', dataIndex: 'identityCount', key: 'identityCount', width: 90 },
  {
    title: 'Decision',
    key: 'status',
    width: 120,
    render: (_: unknown, b) => (
      <Tag color={BATCH_STATUS_TAG[b.status]}>{BATCH_STATUS_LABEL[b.status]}</Tag>
    ),
  },
  {
    title: 'Decided by',
    dataIndex: 'decidedBy',
    key: 'decidedBy',
    width: 200,
    ellipsis: true,
  },
  {
    title: 'Offboardings started',
    key: 'startedCount',
    width: 170,
    render: (_: unknown, b) => (b.status === 'approved' ? (b.startedCount ?? 0) : '-'),
  },
  {
    title: 'Comment',
    dataIndex: 'comment',
    key: 'comment',
    ellipsis: { showTitle: false },
    render: (c?: string) =>
      c ? (
        <Tooltip title={c}>
          <span>{c}</span>
        </Tooltip>
      ) : (
        <Text type="secondary">-</Text>
      ),
  },
];

export const LeaverBatchHistory: React.FC = () => {
  const { data, isLoading } = useLeaverBatches();
  const decided = (data ?? []).filter((b) => b.status !== 'pending');
  return (
    <Table<ILeaverBatch>
      rowKey="id"
      loading={isLoading}
      columns={columns}
      dataSource={decided}
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: BATCH_TABLE_MIN_WIDTH }}
      expandable={{ expandedRowRender: (b) => <LeaverItemsTable items={b.items} /> }}
      locale={{
        emptyText: (
          <EmptyState
            title="No decisions yet"
            description="Approved and rejected leaver batches appear here."
          />
        ),
      }}
    />
  );
};
