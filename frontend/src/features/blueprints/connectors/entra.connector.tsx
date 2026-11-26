/**
 * Microsoft Entra ID connector config. Field translation only; business logic lives in the Policy Engine.
 * Includes Connection, Sync Status, and Discovered Groups & Licenses tabs.
 */
import { ReloadOutlined, SafetyCertificateOutlined, SyncOutlined } from '@ant-design/icons';
import {
  Badge,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  message,
  Select,
  Space,
  Table,
  Tag,
  Tabs,
  Typography,
} from 'antd';
import type { FormInstance } from 'antd';
import React, { useEffect, useState } from 'react';
import type { AxiosError } from 'axios';
import { IStandardUser } from '../../../interfaces/standard-user.interface';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { relativeTimeNullable } from '../../../utils/date-helpers';

const SYNC_INTERVAL_OPTIONS = [
  { label: 'Manual only', value: '0' },
  { label: 'Every hour', value: '1' },
  { label: 'Every 6 hours', value: '6' },
  { label: 'Every 12 hours', value: '12' },
  { label: 'Every 24 hours', value: '24' },
];

const EntraSyncStatusCard: React.FC = () => {
  const [syncStatus, setSyncStatus] = useState<{
    lastSyncAt?: string | null;
    lastSyncStatus?: string | null;
    lastSyncCount?: number | null;
    lastSyncError?: string | null;
    syncIntervalHours?: number;
    nextSyncAt?: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchSyncStatus = async () => {
    try {
      const { data } = await axiosInstance.get(`${API_BASE}/connectors/entra-id/sync-status`);
      setSyncStatus(data);
    } catch {
      setSyncStatus(null);
    }
  };

  useEffect(() => {
    fetchSyncStatus();
  }, []);

  const handleSyncNow = async () => {
    setLoading(true);
    try {
      const { data } = await axiosInstance.post<{
        success?: boolean;
        count?: number;
        error?: string;
      }>(`${API_BASE}/connectors/entra-id/discover`);
      await fetchSyncStatus();
      if (data?.success) {
        message.success(`Sync complete: ${data.count ?? 0} entitlements discovered`);
      } else if (data?.error) {
        message.error(data.error);
      }
    } catch (err) {
      const axiosErr = err as AxiosError<{ message?: string; error?: string }>;
      const msg =
        axiosErr.response?.data?.message ??
        axiosErr.response?.data?.error ??
        (err instanceof Error ? err.message : 'Sync failed');
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card size="small" title="Sync Status" style={{ marginTop: 12 }}>
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <div>
          <Typography.Text type="secondary">Last sync: </Typography.Text>
          <Typography.Text>{relativeTimeNullable(syncStatus?.lastSyncAt ?? null)}</Typography.Text>
          {syncStatus?.lastSyncStatus && (
            <Badge
              status={
                syncStatus.lastSyncStatus === 'success'
                  ? 'success'
                  : syncStatus.lastSyncStatus === 'running'
                    ? 'processing'
                    : 'error'
              }
              text={syncStatus.lastSyncStatus}
              style={{ marginLeft: 8 }}
            />
          )}
        </div>
        {syncStatus?.lastSyncCount != null && (
          <div>
            <Typography.Text type="secondary">
              {syncStatus.lastSyncCount} entitlements discovered
            </Typography.Text>
          </div>
        )}
        {syncStatus?.lastSyncError && (
          <Typography.Text type="danger">{syncStatus.lastSyncError}</Typography.Text>
        )}
        <div>
          <Typography.Text type="secondary">Next sync: </Typography.Text>
          <Typography.Text>
            {syncStatus?.syncIntervalHours &&
            syncStatus.syncIntervalHours > 0 &&
            syncStatus.nextSyncAt
              ? `In ~${Math.max(0, Math.round((new Date(syncStatus.nextSyncAt).getTime() - Date.now()) / 3600000))} hours`
              : 'Manual only'}
          </Typography.Text>
        </div>
        <Button icon={<SyncOutlined />} onClick={handleSyncNow} loading={loading}>
          Sync Now
        </Button>
      </Space>
    </Card>
  );
};

const EntraDiscoveredTab: React.FC = () => {
  const [entitlements, setEntitlements] = useState<
    { nativeId: string; name: string; type?: string; origin?: string }[]
  >([]);
  const [loading, setLoading] = useState(false);

  const fetchEntitlements = async () => {
    try {
      const { data } = await axiosInstance.get(`${API_BASE}/entitlement-catalog?system=entra-id`);
      setEntitlements(data.entitlements ?? []);
    } catch {
      setEntitlements([]);
    }
  };

  useEffect(() => {
    fetchEntitlements();
  }, []);

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const { data } = await axiosInstance.post<{
        success?: boolean;
        count?: number;
        error?: string;
      }>(`${API_BASE}/connectors/entra-id/discover`);
      await fetchEntitlements();
      if (data?.success) {
        message.success(`Discovery complete: ${data.count ?? 0} entitlements found`);
      } else if (data?.error) {
        message.error(data.error);
      }
    } catch (err) {
      const axiosErr = err as AxiosError<{ message?: string; error?: string }>;
      const msg =
        axiosErr.response?.data?.message ??
        axiosErr.response?.data?.error ??
        (err instanceof Error ? err.message : 'Discovery failed');
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <Button
        icon={<ReloadOutlined />}
        onClick={handleRefresh}
        loading={loading}
        style={{ marginBottom: 12 }}
      >
        Refresh / Run Discovery
      </Button>
      {entitlements.length === 0 ? (
        <Empty description="No entitlements discovered yet. Save the connector config and run discovery." />
      ) : (
        <Table
          size="small"
          dataSource={entitlements}
          rowKey="nativeId"
          columns={[
            { title: 'Name', dataIndex: 'name', key: 'name' },
            {
              title: 'Native ID',
              dataIndex: 'nativeId',
              key: 'nativeId',
              render: (v: string) => <code>{v}</code>,
            },
            { title: 'Type', dataIndex: 'type', key: 'type', render: (v: string) => v || 'Group' },
            {
              title: 'Origin',
              dataIndex: 'origin',
              key: 'origin',
              render: (v: string) => v || 'EXTERNAL',
            },
          ]}
          pagination={{ pageSize: 10 }}
        />
      )}
    </div>
  );
};

export const EntraConnectorConfig = {
  type: 'Microsoft Entra ID',
  icon: <SafetyCertificateOutlined />,
  color: '#0078d4',

  normalize: (user: IStandardUser) => {
    const upn =
      user.userPrincipalName ||
      user.email ||
      `${user.firstName?.toLowerCase()}.${user.lastName?.toLowerCase()}@euroid.com`;

    const mailNickname =
      user.samAccountName ||
      user.email?.split('@')[0] ||
      `${user.firstName?.toLowerCase()}${user.lastName?.toLowerCase()}`;

    return {
      ...user,
      userPrincipalName: upn,
      mailNickname: mailNickname,
      displayName: user.displayName || `${user.firstName} ${user.lastName}`,
    };
  },

  translate: (user: IStandardUser) => {
    const upn = user.userPrincipalName || user.email;
    const displayName = user.displayName || `${user.firstName} ${user.lastName}`;
    const details = [];
    details.push(`UPN: ${upn}`);
    if (user.displayName) details.push(`Display Name: ${displayName}`);
    if (user.jobTitle) details.push(`Job Title: ${user.jobTitle}`);
    if (user.departmentCode || user.departmentName) {
      details.push(`Department: ${user.departmentName || user.departmentCode}`);
    }
    if (user.location) details.push(`Location: ${user.location}`);

    return {
      action: 'Provision User to Entra ID',
      detail: details.filter((d) => d).join(' | '),
      risk: 'Low', // Risk will be calculated by Policy Engine
      metadata: {
        upn,
        displayName,
        givenName: user.firstName,
        surname: user.lastName,
        middleName: user.middleName,
        jobTitle: user.jobTitle,
        department: user.departmentName || user.departmentCode,
        officeLocation: user.officeName || user.location,
        mobilePhone: user.mobilePhone,
        businessPhones: user.workPhone ? [user.workPhone] : undefined,
        city: user.city,
        state: user.stateProvince,
        country: user.countryCode,
        usageLocation: user.countryCode || 'US',
        employeeId: user.employeeId,
        companyName: user.division,
      },
    };
  },

  renderSettings: (_form: FormInstance) => (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Tag color="blue">Microsoft Entra ID Configuration</Tag>
      <Tabs
        items={[
          {
            key: 'connection',
            label: 'Connection',
            children: (
              <>
                <Form.Item
                  label="Tenant ID"
                  name="tenantId"
                  rules={[{ required: true, message: 'Tenant ID is required' }]}
                  extra="Your Azure AD tenant identifier"
                  style={{ marginBottom: 8 }}
                >
                  <Input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
                </Form.Item>
                <Form.Item
                  label="Client ID (Application ID)"
                  name="clientId"
                  rules={[{ required: true, message: 'Client ID is required' }]}
                  extra="App registration ID with User.ReadWrite.All permissions"
                  style={{ marginBottom: 8 }}
                >
                  <Input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
                </Form.Item>
                <Form.Item
                  label="Client Secret"
                  name="clientSecret"
                  rules={[{ required: true, message: 'Client Secret is required' }]}
                  extra="Client secret value (not the secret ID)"
                  style={{ marginBottom: 8 }}
                >
                  <Input.Password placeholder="Enter client secret" />
                </Form.Item>
                <Form.Item
                  label="Default Domain"
                  name="defaultDomain"
                  initialValue="euroid.com"
                  extra="Primary verified domain in your tenant"
                  style={{ marginBottom: 8 }}
                >
                  <Input placeholder="euroid.com" />
                </Form.Item>
                <Form.Item
                  label="Default Usage Location"
                  name="defaultUsageLocation"
                  initialValue="US"
                  extra="ISO 3166-1 alpha-2 country code (required for licensing)"
                  style={{ marginBottom: 8 }}
                >
                  <Input placeholder="US" />
                </Form.Item>
                <Form.Item
                  label="Discovery Sync Interval"
                  name="syncIntervalHours"
                  initialValue="0"
                  extra="How often to automatically discover entitlements (groups, licenses). 0 = manual only."
                  style={{ marginBottom: 8 }}
                >
                  <Select placeholder="Manual only" options={SYNC_INTERVAL_OPTIONS} />
                </Form.Item>

                <EntraSyncStatusCard />

                <Descriptions title="Field Mapping" bordered size="small" column={1}>
                  <Descriptions.Item label="Identity">
                    UPN, Display Name, Given Name, Surname
                  </Descriptions.Item>
                  <Descriptions.Item label="Contact">
                    Mobile Phone, Business Phones
                  </Descriptions.Item>
                  <Descriptions.Item label="Employment">
                    Job Title, Department, Employee ID, Company Name
                  </Descriptions.Item>
                  <Descriptions.Item label="Location">
                    Office Location, City, State, Country, Usage Location
                  </Descriptions.Item>
                </Descriptions>

                <Tag color="orange" style={{ marginTop: 12 }}>
                  Licenses, groups, and policies are managed by the Policy Engine
                </Tag>
              </>
            ),
          },
          {
            key: 'discovered',
            label: 'Discovered Groups & Licenses',
            children: <EntraDiscoveredTab />,
          },
        ]}
      />
    </Space>
  ),
};
