/**
 * Identities in an HR joiner batch: who joins (name, email, department, job title) and what
 * became of each one's onboarding.
 */
import React from 'react';
import { Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { IJoinerBatchItem } from '../../interfaces';
import { PAGE_SIZES } from '@config/pagination';
import { JOINER_STATUS_LABEL, JOINER_STATUS_TAG } from './joiner-labels';

const { Text } = Typography;

const columns: ColumnsType<IJoinerBatchItem> = [
  {
    title: 'Identity',
    key: 'identity',
    render: (_: unknown, item) => (
      <Space direction="vertical" size={0}>
        <Text>{item.displayName}</Text>
        {item.email && <Text type="secondary">{item.email}</Text>}
      </Space>
    ),
  },
  {
    title: 'Department',
    dataIndex: 'departmentName',
    key: 'departmentName',
    render: (v?: string) => v ?? <Text type="secondary">-</Text>,
  },
  {
    title: 'Job title',
    dataIndex: 'jobTitle',
    key: 'jobTitle',
    render: (v?: string) => v ?? <Text type="secondary">-</Text>,
  },
  {
    title: 'Status',
    key: 'status',
    render: (_: unknown, item) => {
      const tag = (
        <Tag color={JOINER_STATUS_TAG[item.status]}>{JOINER_STATUS_LABEL[item.status]}</Tag>
      );
      const why = item.closeReason ?? item.startError;
      return why ? <Tooltip title={why}>{tag}</Tooltip> : tag;
    },
  },
];

export const JoinerItemsTable: React.FC<{ items: IJoinerBatchItem[] }> = ({ items }) => (
  <Table<IJoinerBatchItem>
    rowKey="joinerEventId"
    size="small"
    columns={columns}
    dataSource={items}
    pagination={items.length > PAGE_SIZES.MEDIUM ? { pageSize: PAGE_SIZES.MEDIUM } : false}
    scroll={{ x: 'max-content' }}
  />
);
