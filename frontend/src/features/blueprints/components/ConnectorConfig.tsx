/**
 * ConnectorConfig — Target connector connection settings + remove.
 * Extracted from ConfigDrawer.
 */
import React from 'react';
import { Form, Button, Space, Alert, Input, Typography, Popconfirm, Divider, theme } from 'antd';
import { ApiOutlined, DeleteOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd';
import { ConnectorHealthCheck } from '@features/connectors/ConnectorHealthCheck';

const { Text } = Typography;

export interface ConnectorConfigProps {
  form: FormInstance;
  onSave: (values: Record<string, unknown>) => void;
  connectorConfig:
    | { renderSettings: (form: FormInstance) => React.ReactNode; testsConnection?: boolean }
    | undefined;
  onDeleteConnector: (nodeId: string) => void;
  onClose: () => void;
  nodeId: string;
  /** Backend connector id of the node: Test Connection when its manifest declares a check. */
  connectorId?: string;
  /** Below policy-admin: nothing here can be changed or removed (the drawer offers no Save). */
  readOnly?: boolean;
  /**
   * A policy-admin without connector-admin: the connection settings are read-only (their PATCH
   * needs connector-admin); Save still saves the canvas node.
   */
  connectionReadOnly?: boolean;
}

export const ConnectorConfig: React.FC<ConnectorConfigProps> = ({
  form,
  onSave,
  connectorConfig,
  onDeleteConnector,
  onClose,
  nodeId,
  connectorId,
  readOnly = false,
  connectionReadOnly = false,
}) => {
  const { token } = theme.useToken();
  const fieldsDisabled = readOnly || connectionReadOnly;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Alert
        message="Connection Settings Only"
        description="Connectors are simple endpoints. All business logic (field mappings, policies) is configured in the Brain."
        type="info"
        showIcon
        icon={<ApiOutlined />}
      />
      {connectionReadOnly && !readOnly && <ConnectionReadOnlyNote />}

      {connectorConfig ? (
        <Form form={form} layout="vertical" onFinish={onSave} disabled={fieldsDisabled}>
          {connectorConfig.renderSettings(form)}
        </Form>
      ) : (
        <Form form={form} layout="vertical" onFinish={onSave} disabled={fieldsDisabled}>
          <Form.Item label="API Endpoint" name="endpoint">
            <Input placeholder="https://api.example.com" />
          </Form.Item>
          <Form.Item label="API Key" name="apiKey">
            <Input.Password placeholder="Enter API key" />
          </Form.Item>
        </Form>
      )}

      {connectorId && !connectorConfig?.testsConnection && (
        <ConnectorHealthCheck connectorId={connectorId} form={form} />
      )}

      {!readOnly && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              background: token.colorErrorBg,
              borderRadius: 6,
              border: `1px solid ${token.colorErrorBorder}`,
            }}
          >
            <div>
              <Text strong style={{ color: token.colorErrorActive }}>
                Remove Connector
              </Text>
              <br />
              <Text type="secondary" style={{ fontSize: 11 }}>
                Remove this connector from the canvas. You can re-add it anytime.
              </Text>
            </div>
            <Popconfirm
              title="Remove this connector?"
              description="It will be removed from the canvas. You can re-add it anytime from 'Add Connector'."
              onConfirm={() => {
                onDeleteConnector(nodeId);
                onClose();
              }}
              okText="Yes, Remove"
              cancelText="Cancel"
              okButtonProps={{ danger: true }}
            >
              <Button danger icon={<DeleteOutlined />}>
                Remove
              </Button>
            </Popconfirm>
          </div>
        </>
      )}
    </Space>
  );
};

/** Why the connection settings are read-only for a policy-admin without connector-admin. */
export const ConnectionReadOnlyNote: React.FC = () => (
  <Alert
    type="warning"
    showIcon
    message="Connection settings need the connector-admin role"
    description="You can change and save this node on the canvas; a connector admin changes its connection settings."
  />
);
