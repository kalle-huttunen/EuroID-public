/**
 * GroupListView - Identity Hub / Group List
 *
 * Lists entitlements (groups, licenses) from the catalog with:
 * - Source: Policy vs External
 * - Governance Mode: Strict vs Open
 *
 * Data from GET /api/v1/entitlement-catalog?system=entra-id
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Space, Select, Typography, Spin, notification, theme } from 'antd';
import { SafetyOutlined, CloudOutlined, LockOutlined, UnlockOutlined } from '@ant-design/icons';
import { API_BASE } from '@api/constants';
import { axiosInstance } from '@api/data';
const CATALOG_API = `${API_BASE}/entitlement-catalog`;

export interface EntitlementItem {
  nativeId?: string;
  name: string;
  type: 'Group' | 'License';
  origin: 'POLICY' | 'EXTERNAL';
  governanceLevel: 'STRICT' | 'OPEN';
}

export const GroupListView: React.FC = () => {
  const { token } = theme.useToken();
  const [entitlements, setEntitlements] = useState<EntitlementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [system, setSystem] = useState<string>('entra-id');
  const [api, contextHolder] = notification.useNotification();

  const fetchCatalog = useCallback(async () => {
    if (!system) return;
    setLoading(true);
    try {
      const { data } = await axiosInstance.get(CATALOG_API, { params: { system } });
      setEntitlements(data.entitlements || []);
    } catch (err) {
      console.error('Failed to fetch entitlement catalog:', err);
      api.error({
        message: 'Failed to load Group List',
        description: 'Is the backend running? Ensure Entra discovery has run to populate the catalog.',
        placement: 'top',
      });
      setEntitlements([]);
    } finally {
      setLoading(false);
    }
  }, [system, api]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: EntitlementItem) => (
        <Space>
          <Typography.Text strong>{name}</Typography.Text>
          {record.nativeId && (
            <Typography.Text type="secondary" style={{ fontSize: 10 }} code>
              {record.nativeId.slice(0, 8)}…
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 100,
      render: (type: string) => (
        <Tag color={type === 'Group' ? 'blue' : 'green'}>{type}</Tag>
      ),
    },
    {
      title: 'Source',
      dataIndex: 'origin',
      key: 'origin',
      width: 140,
      render: (origin: 'POLICY' | 'EXTERNAL') =>
        origin === 'POLICY' ? (
          <Tag icon={<SafetyOutlined />} color="purple">
            Policy
          </Tag>
        ) : (
          <Tag icon={<CloudOutlined />} color="default">
            External
          </Tag>
        ),
    },
    {
      title: 'Governance Mode',
      dataIndex: 'governanceLevel',
      key: 'governanceLevel',
      width: 140,
      render: (level: 'STRICT' | 'OPEN') =>
        level === 'STRICT' ? (
          <Tag icon={<LockOutlined />} color="red">
            Strict
          </Tag>
        ) : (
          <Tag icon={<UnlockOutlined />} color="default">
            Open
          </Tag>
        ),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {contextHolder}
      <Card size="small" style={{ background: token.colorFillQuaternary }}>
        <Space style={{ marginBottom: 12 }}>
          <Typography.Text strong>System:</Typography.Text>
          <Select
            value={system}
            onChange={setSystem}
            style={{ width: 160 }}
            options={[
              { value: 'entra-id', label: 'Entra ID' },
            ]}
          />
          <Typography.Text type="secondary">
            {entitlements.length} entitlement(s) • Source: Policy vs External • Governance: Strict vs Open
          </Typography.Text>
        </Space>
      </Card>
      <Spin spinning={loading}>
        <Table
          dataSource={entitlements}
          columns={columns}
          rowKey={(r) => r.nativeId || r.name}
          size="small"
          pagination={{ pageSize: 20 }}
          locale={{
            emptyText: loading
              ? ' '
              : 'No entitlements yet. Run Entra discovery or create policies that assign groups to populate the catalog.',
          }}
        />
      </Spin>
    </Space>
  );
};
