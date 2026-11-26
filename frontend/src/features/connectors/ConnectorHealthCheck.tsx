/**
 * Test Connection for a connector whose settings a drawer edits (the Design studio's source and
 * target drawers). Shown only when the connector's manifest (GET /connectors/available) declares
 * `healthCheck`. It checks the saved settings (POST /connectors/:name/health-check with no
 * config): several connectors' checks read only those, so while the form differs from the saved
 * settings it says so. Active Directory keeps its own Test Connection in its Connection tab
 * (ConnectorConfigTabs), which tests the form's values.
 */
import React, { useState } from 'react';
import { Alert, App, Button, Form, Space, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { checkConnectorHealth, useAvailableConnectors } from '@api/connectors-api';
import { useConnectorStore } from '@stores/connector-store';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text } = Typography;

/** Form fields of a source drawer that are canvas settings, not the connector's. */
const NODE_ONLY_FIELDS = new Set(['ingestPriority', 'contractTag', 'masteryFields']);

export interface ConnectorHealthCheckProps {
  /** Backend connector id (e.g. csv-hr, okta). */
  connectorId: string;
  /** The drawer's form: its values are compared with the saved settings. */
  form: FormInstance;
}

type Outcome = { healthy: true; message?: string } | { healthy: false; error: string };

export const ConnectorHealthCheck: React.FC<ConnectorHealthCheckProps> = ({
  connectorId,
  form,
}) => {
  const { message } = App.useApp();
  const { data: manifests } = useAvailableConnectors();
  const { getConfig } = useConnectorStore();
  const values = Form.useWatch([], form) as Record<string, unknown> | undefined;
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const manifest = manifests?.find((m) => m.id === connectorId);
  if (!manifest?.capabilities?.includes('healthCheck')) return null;

  const saved = getConfig(connectorId)?.config ?? {};
  const unsaved = Object.entries(values ?? {}).some(
    ([key, value]) =>
      !NODE_ONLY_FIELDS.has(key) &&
      (typeof value !== 'object' || value === null) &&
      String(value ?? '') !== String(saved[key] ?? ''),
  );

  const handleCheck = async () => {
    setChecking(true);
    setOutcome(null);
    try {
      const result = await checkConnectorHealth(connectorId);
      if (result.healthy ?? result.connected) {
        setOutcome({ healthy: true, message: result.message });
        message.success(result.message ?? `${manifest.name}: connection healthy`);
      } else {
        const error = result.error ?? 'Health check failed';
        setOutcome({ healthy: false, error });
        message.error(`${manifest.name}: ${error}`);
      }
    } catch (err: unknown) {
      // The API's reason, e.g. a connector that is not installed
      const error = apiErrorMessage(err, 'Connection test failed');
      setOutcome({ healthy: false, error });
      message.error(error);
    } finally {
      setChecking(false);
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Button icon={<ThunderboltOutlined />} onClick={handleCheck} loading={checking}>
          Test Connection
        </Button>
        {unsaved && (
          <Text type="secondary">
            The check uses the saved settings: save to test your changes.
          </Text>
        )}
      </Space>
      {outcome &&
        (outcome.healthy ? (
          <Alert
            type="success"
            showIcon
            message="Connection healthy"
            description={outcome.message}
          />
        ) : (
          <Alert type="error" showIcon message="Connection failed" description={outcome.error} />
        ))}
    </Space>
  );
};
