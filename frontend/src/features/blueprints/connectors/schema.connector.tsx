/**
 * Settings form for a target connector whose Design studio form is exactly its
 * registry configSchema (Okta, SCIM, ServiceNow, GitHub, Google Sheets, Discord
 * Webhook, File Outbound). Rendered with the same tabbed
 * fields as Active Directory; secrets are password inputs. No simulation logic.
 */
import { Space, Tag } from 'antd';
import type { FormInstance } from 'antd';
import { ConnectorConfigTabs } from '../../connectors/ConnectorConfigTabs';
import type { ConfigField } from '../../connectors/connector-api.types';
import { getConnectorById } from '../shared';
import type { ConnectorConfigField } from '../shared';

const toConfigFields = (schema: ConnectorConfigField[]): ConfigField[] =>
  schema.map(({ options, ...field }) => ({
    ...field,
    options: options?.map((o) => (typeof o === 'string' ? { label: o, value: o } : o)),
  }));

/** ConnectorConfigs entry for the registry connector with this backend id. */
export function schemaConnectorConfig(id: string) {
  const meta = getConnectorById(id);
  if (!meta) throw new Error(`Connector "${id}" is not in CONNECTOR_REGISTRY`);
  const configSchema = toConfigFields(meta.configSchema);
  return {
    type: meta.name,
    icon: meta.icon,
    color: meta.color,
    // Field values live in `form`; ConnectorConfigTabs' values/onChange only
    // serve Active Directory's scoping checks and test connection.
    renderSettings: (form: FormInstance) => (
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Tag color="blue">{meta.name} Configuration</Tag>
        <ConnectorConfigTabs
          connectorMeta={{ id, name: meta.name, configSchema }}
          connectorId={id}
          values={{}}
          onChange={() => undefined}
          form={form}
        />
      </Space>
    ),
  };
}
