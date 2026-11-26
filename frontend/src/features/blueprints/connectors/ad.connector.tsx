/**
 * Active Directory connector config. Tabbed layout: Connection, Scoping, Discovered Groups.
 */
import { ApartmentOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Empty, Space, Table, Tag } from 'antd';
import type { FormInstance } from 'antd';
import React, { useEffect, useState } from 'react';
import { ConnectorConfigTabs } from '../../connectors/ConnectorConfigTabs';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';

const AD_CONFIG_SCHEMA = [
  {
    key: 'host',
    label: 'Host / IP',
    type: 'text' as const,
    required: true,
    placeholder: '10.0.0.1 or dc01.corp.local',
    tab: 'Connection',
  },
  {
    key: 'port',
    label: 'Port',
    type: 'number' as const,
    required: false,
    placeholder: '636',
    description: 'Default: 636 (LDAPS) or 389 (LDAP)',
    tab: 'Connection',
  },
  {
    key: 'useLdaps',
    label: 'Use LDAPS',
    type: 'select' as const,
    required: false,
    options: [
      { label: 'Yes', value: 'true' },
      { label: 'No', value: 'false' },
    ],
    tab: 'Connection',
  },
  {
    key: 'serviceAccount',
    label: 'Service Account DN',
    type: 'text' as const,
    required: true,
    placeholder: 'CN=svc_euroid,OU=ServiceAccounts,DC=gov,DC=fi',
    tab: 'Connection',
  },
  {
    key: 'password',
    label: 'Password',
    type: 'password' as const,
    required: true,
    tab: 'Connection',
  },
  {
    key: 'rootBaseDn',
    label: 'Root Base DN',
    type: 'text' as const,
    required: true,
    placeholder: 'DC=gov,DC=fi',
    tab: 'Scoping',
  },
  {
    key: 'userSearchBase',
    label: 'User Search Base',
    type: 'text' as const,
    required: false,
    placeholder: 'OU=Helsinki,DC=gov,DC=fi',
    validationFn: 'isInsideBaseDn',
    dependsOn: 'rootBaseDn',
    tab: 'Scoping',
  },
  {
    key: 'userOu',
    label: 'New User OU (relative)',
    type: 'text' as const,
    required: false,
    placeholder: 'OU=Users',
    tab: 'Scoping',
  },
  {
    key: 'defaultDomain',
    label: 'Default Domain',
    type: 'text' as const,
    required: false,
    placeholder: 'gov.fi',
    tab: 'Scoping',
  },
];

const AdConnectorConfigContent: React.FC<{ form: FormInstance }> = ({ form }) => {
  const [discoveredGroups, setDiscoveredGroups] = useState<
    { nativeId: string; name: string; origin?: string }[]
  >([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);

  useEffect(() => {
    const fetchGroups = async () => {
      try {
        const { data } = await axiosInstance.get(
          `${API_BASE}/entitlement-catalog?system=ad&type=Group`,
        );
        setDiscoveredGroups(data.entitlements ?? []);
      } catch {
        setDiscoveredGroups([]);
      }
    };
    fetchGroups();
  }, []);

  const handleDiscover = async () => {
    setDiscoverLoading(true);
    try {
      await axiosInstance.post(`${API_BASE}/connectors/ad/discover`);
      const { data } = await axiosInstance.get(
        `${API_BASE}/entitlement-catalog?system=ad&type=Group`,
      );
      setDiscoveredGroups(data.entitlements ?? []);
    } finally {
      setDiscoverLoading(false);
    }
  };

  const values = form?.getFieldsValue?.() ?? {};
  const onChange = (k: string, v: unknown) => form?.setFieldsValue?.({ [k]: v });

  const discoveredTab = {
    key: 'discovered',
    label: 'Discovered Groups',
    content: (
      <div style={{ marginTop: 8 }}>
        <Button
          icon={<ReloadOutlined />}
          onClick={handleDiscover}
          loading={discoverLoading}
          style={{ marginBottom: 12 }}
        >
          Refresh / Run Discovery
        </Button>
        {discoveredGroups.length === 0 ? (
          <Empty description="No groups discovered yet. Save the connector config and run discovery." />
        ) : (
          <Table
            size="small"
            dataSource={discoveredGroups}
            rowKey="nativeId"
            columns={[
              { title: 'Name', dataIndex: 'name', key: 'name' },
              {
                title: 'DN / ID',
                dataIndex: 'nativeId',
                key: 'nativeId',
                render: (v: string) => <code>{v}</code>,
              },
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
    ),
  };

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Tag color="blue">Active Directory Configuration</Tag>
      <ConnectorConfigTabs
        connectorMeta={{ id: 'ad', name: 'Active Directory', configSchema: AD_CONFIG_SCHEMA }}
        connectorId="ad"
        values={values}
        onChange={onChange}
        form={form}
        extraTabs={[discoveredTab]}
      />
    </Space>
  );
};

export const AdConnectorConfig = {
  type: 'Active Directory',
  icon: <ApartmentOutlined />,
  color: '#0078d4',

  renderSettings: (form: FormInstance) => <AdConnectorConfigContent form={form} />,
  // ConnectorConfigTabs' Test Connection in the Connection tab, with the form's values
  testsConnection: true,
};
