/**
 * MyRequests — list of user's access requests
 */
import React from 'react';
import { Table, Tag, Button, Space, Typography, theme } from 'antd';
import { EmptyState } from '../../components/common/EmptyState';
import { EyeOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useMyRequests } from '@api/access-requests-api';

const { Text } = Typography;

const STATUS_COLORS: Record<string, string> = {
  PENDING_APPROVAL: 'processing',
  APPROVED: 'success',
  REJECTED: 'error',
  PROVISIONING: 'processing',
  ACTIVE: 'success',
  EXPIRED: 'default',
  REVOKED: 'warning',
  CANCELLED: 'default',
  // The approval workflow could not be started when the request was created
  FAILED: 'error',
};

export const MyRequests: React.FC = () => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { data, isLoading } = useMyRequests({ page: 1, limit: 50 });

  const requests = data?.data ?? [];
  const total = data?.total ?? 0;

  const columns = [
    {
      title: 'Request ID',
      dataIndex: 'requestId',
      key: 'requestId',
      width: 280,
      render: (id: string) => (
        <Text copyable style={{ fontFamily: token.fontFamilyCode, fontSize: 12 }}>
          {id.slice(0, 8)}...
        </Text>
      ),
    },
    {
      title: 'Entitlements',
      key: 'entitlements',
      render: (_: unknown, record: { entitlements?: Array<{ entitlementName: string }> }) =>
        record.entitlements?.map((e) => e.entitlementName).join(', ') ?? '—',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (status: string) => <Tag color={STATUS_COLORS[status] ?? 'default'}>{status}</Tag>,
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 110,
      render: (d: string) => (d ? new Date(d).toLocaleDateString() : '—'),
    },
    {
      title: 'Action',
      key: 'action',
      width: 100,
      render: (_: unknown, record: { requestId: string }) => (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => navigate(`/access-requests/${record.requestId}`)}
        >
          View
        </Button>
      ),
    },
  ];

  return (
    <Table
      dataSource={requests}
      columns={columns}
      rowKey="requestId"
      loading={isLoading}
      pagination={{
        pageSize: 20,
        total,
        showSizeChanger: false,
      }}
      locale={{
        emptyText: (
          <EmptyState
            title="No access requests yet"
            description="Browse the catalog to request access to systems and entitlements."
          />
        ),
      }}
    />
  );
};
