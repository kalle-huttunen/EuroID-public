// frontend/src/pages/blueprints/connectors/index.ts
import type React from 'react';
import { EntraConnectorConfig } from './entra.connector';
import { AdConnectorConfig } from './ad.connector';
import { schemaConnectorConfig } from './schema.connector';
import type { FormInstance } from 'antd';
import type { IStandardUser } from '../../../interfaces';

/** Common shape for connector configuration entries in the registry. */
export interface ConnectorConfigEntry {
  type: string;
  icon: React.ReactNode;
  color: string;
  normalize?: (user: IStandardUser) => IStandardUser & Record<string, unknown>;
  translate?: (user: IStandardUser) => {
    action: string;
    detail: string;
    risk: string;
    metadata?: Record<string, unknown>;
  };
  renderSettings: (form: FormInstance) => React.ReactNode;
  /**
   * Its settings form has its own Test Connection (Active Directory's tests the form's values),
   * so the drawer adds none (ConnectorHealthCheck).
   */
  testsConnection?: boolean;
}

/**
 * [REGISTRY] ConnectorConfigs
 * --------------------------
 * Maps visual node types to their Step D "Worker Simulation" logic.
 */
export const ConnectorConfigs: Record<string, ConnectorConfigEntry> = {
  'Microsoft Entra ID': EntraConnectorConfig,
  'Active Directory': AdConnectorConfig,
  'Okta Identity Cloud': schemaConnectorConfig('okta'),
  'SCIM 2.0 (Generic)': schemaConnectorConfig('scim'),
  ServiceNow: schemaConnectorConfig('servicenow'),
  GitHub: schemaConnectorConfig('github'),
  'Google Sheets': schemaConnectorConfig('google-sheets'),
  'Discord Webhook': schemaConnectorConfig('discord-webhook'),
  'File Outbound': schemaConnectorConfig('file-outbound'),
};
