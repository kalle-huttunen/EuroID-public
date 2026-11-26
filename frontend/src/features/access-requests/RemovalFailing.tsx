/**
 * RemovalFailing: the tenant's ACTIVE access requests past their end date whose removal keeps
 * failing (GET /access-requests?removalFailing=true, policy-admin). Each links to its request
 * page, where [Mark removed manually] closes it once the access is removed in Entra ID.
 */
import React, { useState } from 'react';
import { Alert, Button, Table, Typography, theme } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useRemovalFailingRequests, type AccessRequest } from '@api/access-requests-api';
import { PAGE_SIZES } from '@config/pagination';
import { EmptyState } from '../../components/common/EmptyState';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text } = Typography;

/** The end date the workflow removes the access at: the stored one, else the requested one. */
const endDateOf = (r: AccessRequest) => r.expiresAt ?? r.timeConstraint?.expiresAt;

export const RemovalFailing: React.FC = () => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error } = useRemovalFailingRequests(page, PAGE_SIZES.MEDIUM);

  if (isError) {
    return (
      <Alert
        type="error"
        showIcon
        message={`The failing removals could not be loaded: ${apiErrorMessage(error, 'unknown error')}`}
      />
    );
  }

  const columns = [
    {
      title: 'Request ID',
      dataIndex: 'requestId',
      key: 'requestId',
      width: 140,
      render: (id: string) => (
        <Text copyable={{ text: id }} style={{ fontFamily: token.fontFamilyCode, fontSize: 12 }}>
          {id.slice(0, 8)}...
        </Text>
      ),
    },
    {
      title: 'Entitlements',
      key: 'entitlements',
      render: (_: unknown, r: AccessRequest) =>
        r.entitlements?.map((e) => e.entitlementName).join(', ') || '—',
    },
    {
      title: 'End date',
      key: 'endDate',
      width: 120,
      render: (_: unknown, r: AccessRequest) => {
        const end = endDateOf(r);
        return end ? new Date(end).toLocaleDateString() : '—';
      },
    },
    {
      title: 'Why the removal fails',
      dataIndex: 'statusReason',
      key: 'statusReason',
      ellipsis: true,
    },
    {
      title: 'Action',
      key: 'action',
      width: 100,
      render: (_: unknown, r: AccessRequest) => (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => navigate(`/access-requests/${r.requestId}`)}
        >
          Open
        </Button>
      ),
    },
  ];

  return (
    <>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        Requests past their end date whose access EuroID could not remove. Remove the access in
        Entra ID, then open the request and mark it removed manually.
      </Text>
      <Table
        dataSource={data?.data ?? []}
        columns={columns}
        rowKey="requestId"
        loading={isLoading}
        pagination={{
          current: page,
          pageSize: PAGE_SIZES.MEDIUM,
          total: data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        locale={{
          emptyText: (
            <EmptyState
              title="No failing removals"
              description="Every request past its end date had its access removed."
            />
          ),
        }}
      />
    </>
  );
};
