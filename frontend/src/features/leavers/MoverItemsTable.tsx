/**
 * Identities in an HR mover batch: who, which trigger attributes the HR sync changed against the
 * access the identity has (before -> after), and what became of each.
 */
import React from 'react';
import { Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { IMoverBatchItem, ITriggerAttributeChange } from '../../interfaces';
import { PAGE_SIZES } from '@config/pagination';
import {
  MOVER_ITEM_STATUS_LABEL,
  MOVER_ITEM_STATUS_TAG,
  fieldLabel,
  valueText,
} from './mover-labels';

const { Text } = Typography;

const Changes: React.FC<{ changes: ITriggerAttributeChange[] }> = ({ changes }) => (
  <Space direction="vertical" size={2}>
    {changes.map((c) => (
      <Text key={c.field}>
        <Text type="secondary">{fieldLabel(c.field)}:</Text> {valueText(c.before)} →{' '}
        <Text strong>{valueText(c.after)}</Text>
      </Text>
    ))}
  </Space>
);

const columns: ColumnsType<IMoverBatchItem> = [
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
    title: 'HR change (access applied → HR now)',
    key: 'changes',
    render: (_: unknown, item) => <Changes changes={item.changes} />,
  },
  {
    title: 'Status',
    key: 'status',
    render: (_: unknown, item) => {
      const tag = (
        <Tag color={MOVER_ITEM_STATUS_TAG[item.status]}>{MOVER_ITEM_STATUS_LABEL[item.status]}</Tag>
      );
      return item.closeReason ? <Tooltip title={item.closeReason}>{tag}</Tooltip> : tag;
    },
  },
];

export const MoverItemsTable: React.FC<{ items: IMoverBatchItem[] }> = ({ items }) => (
  <Table<IMoverBatchItem>
    rowKey="itemId"
    size="small"
    columns={columns}
    dataSource={items}
    pagination={items.length > PAGE_SIZES.MEDIUM ? { pageSize: PAGE_SIZES.MEDIUM } : false}
    scroll={{ x: 'max-content' }}
  />
);
