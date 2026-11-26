/**
 * EntitlementBrowser — searchable catalog of requestable entitlements
 */
import React, { useState } from 'react';
import { App, Table, Input, Select, Button, Space, Tag, Typography } from 'antd';
import { SearchOutlined, PlusOutlined } from '@ant-design/icons';
import { EmptyState } from '../../components/common/EmptyState';
import { useRequestableCatalog, type RequestableCatalogEntry } from '@api/access-requests-api';
import { RequestForm } from './RequestForm';

const { Text } = Typography;

/** Below this width (phones) the catalog scrolls sideways inside its container, not the page. */
const ENTITLEMENT_TABLE_MIN_WIDTH = 760;

export const EntitlementBrowser: React.FC = () => {
  const { message } = App.useApp();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [selectedEntries, setSelectedEntries] = useState<RequestableCatalogEntry[] | null>(null);

  const { data, isLoading } = useRequestableCatalog({
    search: search || undefined,
    category,
    page,
    limit: 20,
  });

  const catalog = data?.data ?? [];
  const total = data?.total ?? 0;

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: RequestableCatalogEntry) => (
        <Space direction="vertical" size={0}>
          <Text strong>{name}</Text>
          {record.userDescription && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.userDescription}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: 'System',
      dataIndex: 'system',
      key: 'system',
      width: 120,
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 80,
    },
    {
      title: 'Category',
      dataIndex: 'category',
      key: 'category',
      width: 120,
      render: (c: string) => (c ? <Tag>{c}</Tag> : '—'),
    },
    {
      title: 'Risk',
      dataIndex: 'riskLevel',
      key: 'riskLevel',
      width: 90,
      render: (r: string) => {
        const color =
          r === 'CRITICAL' ? 'red' : r === 'HIGH' ? 'orange' : r === 'MEDIUM' ? 'gold' : 'green';
        return r ? <Tag color={color}>{r}</Tag> : '—';
      },
    },
    {
      title: 'Action',
      key: 'action',
      width: 100,
      render: (_: unknown, record: RequestableCatalogEntry) => (
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setSelectedEntries([record])}
        >
          Request
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Input
          placeholder="Search entitlements..."
          prefix={<SearchOutlined />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
          allowClear
        />
        <Select
          placeholder="Category"
          allowClear
          value={category}
          onChange={setCategory}
          style={{ width: 160 }}
          options={[...new Set(catalog.map((e) => e.category).filter(Boolean))].map((c) => ({
            label: c,
            value: c,
          }))}
        />
      </Space>

      <Table
        dataSource={catalog}
        columns={columns}
        rowKey="_id"
        loading={isLoading}
        scroll={{ x: ENTITLEMENT_TABLE_MIN_WIDTH }}
        pagination={{
          current: page,
          pageSize: 20,
          total,
          showSizeChanger: false,
          onChange: setPage,
        }}
        locale={{
          emptyText: (
            <EmptyState
              title="No requestable entitlements"
              description="Mark entitlements as requestable in the catalog to enable self-service."
            />
          ),
        }}
      />

      {selectedEntries && (
        <RequestForm
          entries={selectedEntries}
          onSuccess={() => {
            setSelectedEntries(null);
            message.success('Request submitted successfully');
          }}
          onCancel={() => setSelectedEntries(null)}
        />
      )}
    </Space>
  );
};
