/**
 * ConnectorConfigTabs.tsx
 *
 * Tabbed configuration panel for connectors with advanced config (AD, Entra, etc.).
 * Groups fields by `tab` property. Supports Test Connection, scoping validation, and extra tabs (e.g. Discovered Groups).
 */
import React, { useState } from 'react';
import {
  Tabs,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Button,
  Card,
  Space,
  Typography,
  message,
  theme,
} from 'antd';
import { ThunderboltOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type { ConfigField } from './connector-api.types';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text } = Typography;

/** DN validation: searchBase must end with rootBaseDn (case-insensitive, spaces stripped) */
function isInsideBaseDn(searchBase: string, rootBaseDn: string): boolean {
  const s = searchBase.toLowerCase().replace(/\s/g, '');
  const r = rootBaseDn.toLowerCase().replace(/\s/g, '');
  return !!s && !!r && s.endsWith(r);
}

export interface ConnectorMeta {
  id: string;
  name: string;
  configSchema: ConfigField[];
}

export interface ConnectorConfigTabsProps {
  connectorMeta: ConnectorMeta;
  connectorId: string;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  errors?: Record<string, string>;
  extraTabs?: Array<{ key: string; label: string; content: React.ReactNode }>;
  form?: FormInstance;
  onTestConnection?: (
    config: Record<string, unknown>,
  ) => Promise<{
    connected: boolean;
    groupCount?: number;
    rootBaseDnValid?: boolean;
    userSearchBaseValid?: boolean;
    error?: string;
  }>;
}

/** Renders form control for Form.Item (receives value/onChange from Form context) */
function renderFieldControl(field: ConfigField) {
  const opts = field.options;

  if (field.type === 'password') {
    return <Input.Password placeholder={field.placeholder} />;
  }
  if (field.type === 'select') {
    const options = Array.isArray(opts)
      ? opts.map((o) =>
          typeof o === 'string' ? { label: o, value: o } : { label: o.label, value: o.value },
        )
      : [];
    return (
      <Select placeholder={field.placeholder ?? `Select ${field.label}`} style={{ width: '100%' }}>
        {options.map((opt) => (
          <Select.Option key={opt.value} value={opt.value}>
            {opt.label}
          </Select.Option>
        ))}
      </Select>
    );
  }
  if (field.type === 'boolean') {
    return <Switch />;
  }
  if (field.type === 'number') {
    return <InputNumber placeholder={field.placeholder} style={{ width: '100%' }} />;
  }
  return <Input placeholder={field.placeholder} />;
}

export const ConnectorConfigTabs: React.FC<ConnectorConfigTabsProps> = ({
  connectorMeta,
  connectorId,
  values,
  onChange: _onChange,
  errors = {},
  extraTabs = [],
  form,
  onTestConnection,
}) => {
  const { token } = theme.useToken();
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<{
    connected: boolean;
    groupCount?: number;
    rootBaseDnValid?: boolean;
    userSearchBaseValid?: boolean;
    error?: string;
  } | null>(null);

  const fieldsByTab = React.useMemo(() => {
    const map: Record<string, ConfigField[]> = {};
    for (const f of connectorMeta.configSchema) {
      const tab = f.tab || 'General';
      if (!map[tab]) map[tab] = [];
      map[tab].push(f);
    }
    return map;
  }, [connectorMeta.configSchema]);

  const tabKeys = Object.keys(fieldsByTab);

  const handleTestConnection = async () => {
    setTestLoading(true);
    setTestResult(null);
    const configToTest = (form?.getFieldsValue?.() ?? values) as Record<string, string>;
    try {
      if (onTestConnection) {
        const result = await onTestConnection(configToTest);
        setTestResult(result);
        if (result.connected) {
          message.success(`Connected! Found ${result.groupCount ?? '?'} groups.`);
        } else {
          message.error(`Connection failed: ${result.error ?? 'Unknown error'}`);
        }
      } else {
        const { data } = await axiosInstance.post(
          `${API_BASE}/connectors/${connectorId}/health-check`,
          { config: configToTest },
        );
        setTestResult(data);
        if (data.connected) {
          message.success(`Connected! Found ${data.groupCount ?? '?'} groups.`);
        } else {
          message.error(`Connection failed: ${data.error ?? 'Unknown error'}`);
        }
      }
    } catch (err: unknown) {
      // The API's reason, e.g. a masked secret with a changed host (type it again)
      const msg = apiErrorMessage(err, 'Connection test failed');
      setTestResult({ connected: false, error: msg });
      message.error(msg);
    } finally {
      setTestLoading(false);
    }
  };

  const validateUserSearchBase = (searchBase: string, rootBaseDn: string): string | undefined => {
    if (!searchBase?.trim()) return undefined;
    if (!rootBaseDn?.trim()) return undefined;
    return isInsideBaseDn(searchBase, rootBaseDn)
      ? undefined
      : 'User Search Base must be inside the Root Base DN';
  };

  const items = [
    ...tabKeys.map((tabKey) => ({
      key: tabKey,
      label: tabKey,
      children: (
        <div style={{ marginTop: 8 }}>
          {fieldsByTab[tabKey].map((field) => {
            const val = values[field.key];
            const err = errors[field.key];
            const scopingError =
              field.validationFn === 'isInsideBaseDn' && field.dependsOn
                ? validateUserSearchBase(String(val ?? ''), String(values[field.dependsOn] ?? ''))
                : undefined;
            const displayError = err || scopingError;

            const rules: Array<{
              required?: boolean;
              message?: string;
              validator?: (rule: unknown, value: string) => Promise<void>;
            }> = field.required ? [{ required: true, message: `${field.label} is required` }] : [];
            if (field.validationFn === 'isInsideBaseDn' && field.dependsOn) {
              rules.push({
                validator: (_: unknown, v: string) => {
                  const root = String(
                    form?.getFieldValue?.(field.dependsOn!) ?? values[field.dependsOn!] ?? '',
                  );
                  if (!v?.trim() || !root?.trim()) return Promise.resolve();
                  return isInsideBaseDn(v, root)
                    ? Promise.resolve()
                    : Promise.reject(new Error('User Search Base must be inside the Root Base DN'));
                },
              });
            }

            return (
              <Form.Item
                key={field.key}
                name={field.key}
                label={field.label}
                rules={rules}
                validateStatus={displayError ? 'error' : undefined}
                help={displayError || field.helpText || field.description}
              >
                {renderFieldControl(field)}
              </Form.Item>
            );
          })}
          {tabKey === 'Connection' && connectorMeta.id === 'ad' && (
            <Space direction="vertical" style={{ width: '100%', marginTop: 16 }}>
              <Button
                icon={<ThunderboltOutlined />}
                onClick={handleTestConnection}
                loading={testLoading}
              >
                Test Connection
              </Button>
              {testResult && (
                <Card size="small">
                  <Space direction="vertical" size="small">
                    <div>
                      {testResult.connected ? (
                        <>
                          <CheckCircleOutlined style={{ color: token.colorSuccess }} /> Connected
                        </>
                      ) : (
                        <>
                          <CloseCircleOutlined style={{ color: token.colorError }} /> Failed
                        </>
                      )}
                    </div>
                    {testResult.rootBaseDnValid !== undefined && (
                      <div>Root Base DN valid: {testResult.rootBaseDnValid ? '✓' : '✗'}</div>
                    )}
                    {testResult.userSearchBaseValid !== undefined && (
                      <div>
                        User Search Base valid: {testResult.userSearchBaseValid ? '✓' : '✗'}
                      </div>
                    )}
                    {testResult.groupCount !== undefined && (
                      <div>Groups found: {testResult.groupCount}</div>
                    )}
                    {testResult.error && <Text type="danger">{testResult.error}</Text>}
                  </Space>
                </Card>
              )}
            </Space>
          )}
        </div>
      ),
    })),
    ...extraTabs.map((t) => ({ key: t.key, label: t.label, children: t.content })),
  ];

  return <Tabs items={items} />;
};
