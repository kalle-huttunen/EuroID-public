/**
 * Connector Registry -- Single Source of Truth
 *
 * Every connector in the system is defined here once.
 * All other files (canvas, drawers, field mapping) import from this registry
 * instead of duplicating names, icons, colors, or ID-parsing logic.
 * Only connectors the backend registers belong here
 * (backend/src/modules/connectors/plugin/register-connectors.ts).
 *
 * Source connectors: Forest Green family (BRAND.success).
 * Target connectors: Brand colors for recognition (Microsoft, GitHub, etc.).
 */
import React from 'react';
import { BRAND } from '../../../theme';
import {
  CloudOutlined,
  SafetyCertificateOutlined,
  FileTextOutlined,
  ApiOutlined,
  MessageOutlined,
  GithubOutlined,
  TableOutlined,
  ApartmentOutlined,
  ToolOutlined,
} from '@ant-design/icons';

// ── Types ────────────────────────────────────────────────────────────

export type ConnectorDirection = 'source' | 'target';

export type ConnectorCategory = 'HR' | 'Identity' | 'Collaboration' | 'DevOps' | 'Cloud';

/** Select option: a bare value is shown as its own label. */
export type ConnectorConfigOption = string | { label: string; value: string };

export interface ConnectorConfigField {
  key: string;
  label: string;
  /** 'json': a JSON object as text (an HR column or field map); the API checks its entries. */
  type: 'text' | 'password' | 'select' | 'number' | 'boolean' | 'json';
  required: boolean;
  placeholder?: string;
  options?: ConnectorConfigOption[];
  tab?: string;
  helpText?: string;
  validationFn?: string;
  dependsOn?: string;
}

export interface ConnectorMeta {
  /** Backend connector ID (e.g. csv-hr, entra-id). Used for install/API matching. When absent, `name` is used. */
  id?: string;
  /** Display name (must match ConnectorConfigs keys for targets) */
  name: string;
  /** Ant Design icon element */
  icon: React.ReactElement;
  /** Brand colour used in field-mapping columns, tags, etc. */
  color: string;
  /** Source = feeds data INTO the Brain, Target = receives data FROM the Brain */
  direction: ConnectorDirection;
  /** Key used inside FIELD_MAPPINGS.targets (may differ from name) */
  fieldMappingKey?: string;
  /** Does this connector have a backend module? */
  hasBackend: boolean;
  /** Substrings used to recognise this connector from a ReactFlow node ID */
  idPatterns: string[];
  /** Short description for the marketplace card */
  description: string;
  /** Category for filtering in the Connector Marketplace */
  category: ConnectorCategory;
  /** Config fields required for installation */
  configSchema: ConnectorConfigField[];
  /** Policy actions the Design studio's node rail offers for this target connector */
  policyActions?: ConnectorPolicyAction[];
}

/** A policy action on a target connector, e.g. assigning one of its groups. */
export interface ConnectorPolicyAction {
  /** Action type of the policy action node (`data.actionType`) */
  actionType: string;
  /** Label on the node rail */
  label: string;
}

// ── Registry ─────────────────────────────────────────────────────────

export const CONNECTOR_REGISTRY: ConnectorMeta[] = [
  // ─── Sources ───
  {
    id: 'csv-hr',
    name: 'CSV HR',
    icon: React.createElement(FileTextOutlined),
    color: BRAND.success,
    direction: 'source',
    hasBackend: true,
    idPatterns: ['csv-hr'],
    description: 'Import user data from CSV files. Map columns to StandardUserDto fields.',
    category: 'HR',
    configSchema: [
      {
        key: 'filePath',
        label: 'File Path',
        type: 'text',
        required: true,
        placeholder: '/path/to/employees.csv',
      },
      {
        key: 'sourceSystem',
        label: 'Source System Name',
        type: 'text',
        required: false,
        placeholder: 'csv-hr',
      },
      {
        key: 'columnMap',
        label: 'Column Map',
        type: 'json',
        required: false,
        placeholder:
          '{"Employee ID": "sourceUserId", "Email": "email", "Employee Number": "employeeNumber"}',
        helpText:
          'CSV column header → field, as a JSON object. Replaces the default map; leave empty to use it. Fields: sourceUserId, email (required), firstName, lastName, jobTitle, departmentName, employeeId, employeeNumber, employmentType, mobilePhone, location, startDate, endDate, hrStatus, customAttributes.<key>.',
      },
      {
        key: 'syncIntervalHours',
        label: 'Sync Interval',
        type: 'select',
        required: false,
        options: ['0', '1', '6', '12', '24'],
        helpText: 'How often to automatically pull data. 0 = manual only.',
      },
    ],
  },
  {
    id: 'json-api-hr',
    name: 'JSON API HR',
    icon: React.createElement(ApiOutlined),
    color: BRAND.success,
    direction: 'source',
    hasBackend: true,
    idPatterns: ['json-api-hr'],
    description: 'Import user data from HTTP endpoints returning JSON arrays.',
    category: 'HR',
    configSchema: [
      {
        key: 'url',
        label: 'API URL',
        type: 'text',
        required: true,
        placeholder: 'https://api.example.com/users',
      },
      {
        key: 'responsePath',
        label: 'Response Path',
        type: 'text',
        required: false,
        placeholder: 'data',
      },
      {
        key: 'sourceSystem',
        label: 'Source System Name',
        type: 'text',
        required: false,
        placeholder: 'json-api-hr',
      },
      {
        key: 'fieldMap',
        label: 'Field Map',
        type: 'json',
        required: false,
        placeholder: '{"emp_id": "sourceUserId", "email": "email", "staff_no": "employeeNumber"}',
        helpText:
          'JSON property name → field, as a JSON object. Replaces the default map; leave empty to use it. Fields: sourceUserId, email (required), firstName, lastName, jobTitle, departmentName, employeeId, employeeNumber, employmentType, mobilePhone, location, startDate, endDate, hrStatus, customAttributes.<key>.',
      },
      {
        key: 'syncIntervalHours',
        label: 'Sync Interval',
        type: 'select',
        required: false,
        options: ['0', '1', '6', '12', '24'],
        helpText: 'How often to automatically pull data. 0 = manual only.',
      },
    ],
  },

  // ─── Targets ───
  {
    id: 'ad',
    name: 'Active Directory',
    icon: React.createElement(ApartmentOutlined),
    color: '#0078d4',
    direction: 'target',
    hasBackend: true,
    idPatterns: ['ad', 'active-directory', 'ldap'],
    description: 'On-premises AD — User provisioning via LDAP/LDAPS with Base DN partitioning.',
    category: 'Identity',
    policyActions: [{ actionType: 'assign_group', label: 'Assign AD Group' }],
    configSchema: [
      {
        key: 'host',
        label: 'Host / IP',
        type: 'text',
        required: true,
        placeholder: '10.0.0.1 or dc01.corp.local',
        tab: 'Connection',
      },
      {
        key: 'port',
        label: 'Port',
        type: 'number',
        required: false,
        placeholder: '636',
        tab: 'Connection',
        helpText: 'Default: 636 (LDAPS) or 389 (LDAP)',
      },
      {
        key: 'useLdaps',
        label: 'Use LDAPS',
        type: 'select',
        required: false,
        options: ['true', 'false'],
        tab: 'Connection',
        helpText: 'LDAPS encrypts the connection. Strongly recommended.',
      },
      {
        key: 'serviceAccount',
        label: 'Service Account DN',
        type: 'text',
        required: true,
        placeholder: 'CN=svc_euroid,OU=ServiceAccounts,DC=gov,DC=fi',
        tab: 'Connection',
      },
      { key: 'password', label: 'Password', type: 'password', required: true, tab: 'Connection' },
      {
        key: 'rootBaseDn',
        label: 'Root Base DN',
        type: 'text',
        required: true,
        placeholder: 'DC=gov,DC=fi',
        tab: 'Scoping',
        helpText: 'Top-level DN boundary. All operations confined within this scope.',
      },
      {
        key: 'userSearchBase',
        label: 'User Search Base',
        type: 'text',
        required: false,
        placeholder: 'OU=Helsinki,DC=gov,DC=fi',
        tab: 'Scoping',
        helpText: 'Narrower OU to search for users. Must be inside the Root Base DN.',
        validationFn: 'isInsideBaseDn',
        dependsOn: 'rootBaseDn',
      },
      {
        key: 'userOu',
        label: 'New User OU (relative)',
        type: 'text',
        required: false,
        placeholder: 'OU=Users',
        tab: 'Scoping',
        helpText: 'Sub-OU under the search base where new users are created.',
      },
      {
        key: 'defaultDomain',
        label: 'Default Domain',
        type: 'text',
        required: false,
        placeholder: 'gov.fi',
        tab: 'Scoping',
        helpText: 'Used for UPN generation (e.g., john.doe@gov.fi).',
      },
      {
        key: 'syncIntervalHours',
        label: 'Discovery Sync Interval',
        type: 'select',
        required: false,
        options: ['0', '1', '6', '12', '24'],
        tab: 'Scoping',
        helpText: 'How often to automatically discover groups. 0 = manual only.',
      },
    ],
  },
  {
    id: 'entra-id',
    name: 'Microsoft Entra ID',
    icon: React.createElement(SafetyCertificateOutlined),
    color: '#0078d4',
    direction: 'target',
    fieldMappingKey: 'Entra ID',
    hasBackend: true,
    idPatterns: ['entra', 'azure', 'microsoft-entra'],
    description:
      'Provision users, groups, and licenses to Azure AD / Entra ID via Microsoft Graph.',
    category: 'Identity',
    policyActions: [{ actionType: 'assign_group', label: 'Assign Entra ID Group' }],
    configSchema: [
      {
        key: 'tenantId',
        label: 'Tenant ID',
        type: 'text',
        required: true,
        placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true },
      {
        key: 'syncIntervalHours',
        label: 'Discovery Sync Interval',
        type: 'select',
        required: false,
        options: ['0', '1', '6', '12', '24'],
        helpText: 'How often to automatically discover entitlements. 0 = manual only.',
      },
    ],
  },
  // Okta, SCIM and ServiceNow fields mirror their backend manifests
  // (backend/src/modules/connectors/<name>-connector/connector.manifest.ts).
  {
    id: 'okta',
    name: 'Okta Identity Cloud',
    icon: React.createElement(CloudOutlined),
    color: '#007DC1',
    direction: 'target',
    hasBackend: true,
    idPatterns: ['okta'],
    description: 'Provision users, groups, and app assignments to Okta via the native Okta API.',
    category: 'Identity',
    configSchema: [
      {
        key: 'orgUrl',
        label: 'Okta Org URL',
        type: 'text',
        required: true,
        placeholder: 'https://dev-123456.okta.com',
        helpText: 'Your Okta organization URL',
      },
      {
        key: 'apiToken',
        label: 'API Token',
        type: 'password',
        required: true,
        helpText: 'Okta API token (SSWS). Create in Security > API > Tokens.',
      },
      {
        key: 'defaultGroupId',
        label: 'Default Group ID',
        type: 'text',
        required: false,
        placeholder: '00g1234567890abcdef',
        helpText: 'Okta group ID to assign new users to by default',
      },
      {
        key: 'deprovisionStrategy',
        label: 'Deprovision Strategy',
        type: 'select',
        required: false,
        helpText: 'What offboarding does to the Okta user. Default: Deactivate.',
        options: [
          { label: 'Deactivate', value: 'deactivate' },
          { label: 'Deactivate, then delete', value: 'delete' },
        ],
      },
    ],
  },
  {
    id: 'scim',
    name: 'SCIM 2.0 (Generic)',
    icon: React.createElement(ApiOutlined),
    color: '#8c8c8c',
    direction: 'target',
    hasBackend: true,
    idPatterns: ['scim'],
    description: 'Provision users to any SCIM 2.0 compliant SaaS application.',
    category: 'Cloud',
    policyActions: [{ actionType: 'assign_group', label: 'Assign SCIM Resource' }],
    configSchema: [
      {
        key: 'baseUrl',
        label: 'SCIM Base URL',
        type: 'text',
        required: true,
        placeholder: 'https://api.example.com/scim/v2',
      },
      {
        key: 'authType',
        label: 'Authentication Type',
        type: 'select',
        required: true,
        options: [
          { label: 'Bearer Token', value: 'bearer' },
          { label: 'Basic Auth', value: 'basic' },
          { label: 'OAuth2 Client Credentials', value: 'oauth2' },
        ],
      },
      {
        key: 'bearerToken',
        label: 'Bearer Token',
        type: 'password',
        required: false,
        helpText: 'Required when auth type is Bearer Token',
      },
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        required: false,
        helpText: 'Required when auth type is Basic Auth',
      },
      {
        key: 'password',
        label: 'Password',
        type: 'password',
        required: false,
        helpText: 'Required when auth type is Basic Auth',
      },
      {
        key: 'oauth2TokenUrl',
        label: 'OAuth2 Token URL',
        type: 'text',
        required: false,
        placeholder: 'https://auth.example.com/oauth/token',
        helpText: 'Required when auth type is OAuth2',
      },
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: false,
        helpText: 'Required when auth type is OAuth2',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        required: false,
        helpText: 'Required when auth type is OAuth2',
      },
      {
        key: 'deprovisionStrategy',
        label: 'Deprovision Strategy',
        type: 'select',
        required: false,
        helpText: 'How to handle user deprovisioning. Default: Deactivate.',
        options: [
          { label: 'Deactivate (set active=false)', value: 'deactivate' },
          { label: 'Delete user', value: 'delete' },
        ],
      },
    ],
  },
  {
    id: 'servicenow',
    name: 'ServiceNow',
    icon: React.createElement(ToolOutlined),
    color: '#62D84E',
    direction: 'target',
    hasBackend: true,
    idPatterns: ['servicenow'],
    description: 'Creates incidents for provisioning events and syncs user records to ServiceNow.',
    category: 'DevOps',
    configSchema: [
      {
        key: 'instanceUrl',
        label: 'Instance URL',
        type: 'text',
        required: true,
        placeholder: 'https://mycompany.service-now.com',
        tab: 'Connection',
        helpText: 'ServiceNow instance URL (e.g., https://mycompany.service-now.com)',
      },
      {
        key: 'clientId',
        label: 'OAuth2 Client ID',
        type: 'text',
        required: true,
        placeholder: 'abc123...',
        tab: 'Connection',
        helpText: 'OAuth2 client ID from ServiceNow Application Registry',
      },
      {
        key: 'clientSecret',
        label: 'OAuth2 Client Secret',
        type: 'password',
        required: true,
        tab: 'Connection',
        helpText: 'OAuth2 client secret',
      },
      {
        key: 'username',
        label: 'Username (Basic Auth Fallback)',
        type: 'text',
        required: false,
        placeholder: 'admin',
        tab: 'Connection',
        helpText: 'Username for Basic auth fallback if OAuth2 is unavailable',
      },
      {
        key: 'password',
        label: 'Password (Basic Auth Fallback)',
        type: 'password',
        required: false,
        tab: 'Connection',
        helpText: 'Password for Basic auth fallback',
      },
      {
        key: 'defaultAssignmentGroup',
        label: 'Default Assignment Group',
        type: 'text',
        required: false,
        placeholder: 'sys_id of the assignment group',
        tab: 'Incidents',
        helpText: 'sys_id of the default assignment group for incidents',
      },
      {
        key: 'incidentCategory',
        label: 'Incident Category',
        type: 'text',
        required: false,
        placeholder: 'Software',
        tab: 'Incidents',
        helpText: 'Default category for created incidents',
      },
      {
        key: 'incidentPriority',
        label: 'Incident Priority',
        type: 'select',
        required: false,
        tab: 'Incidents',
        helpText: 'Default priority for created incidents. Default: 3 - Moderate.',
        options: [
          { label: '1 - Critical', value: '1' },
          { label: '2 - High', value: '2' },
          { label: '3 - Moderate', value: '3' },
          { label: '4 - Low', value: '4' },
        ],
      },
    ],
  },
  // File Outbound, Discord Webhook, GitHub and Google Sheets fields mirror their
  // backend manifests too; help text is the manifest field description.
  {
    id: 'file-outbound',
    name: 'File Outbound',
    icon: React.createElement(FileTextOutlined),
    color: '#8c8c8c',
    direction: 'target',
    hasBackend: true,
    idPatterns: ['file-outbound'],
    description: 'Dev connector: appends provisioning intent to a local JSONL file.',
    category: 'Cloud',
    configSchema: [
      {
        key: 'outputFilePath',
        label: 'Output File Path',
        type: 'text',
        required: true,
        placeholder: './provisioning-log.jsonl',
        helpText:
          'Path to the JSONL file inside the directory FILE_OUTBOUND_ALLOWED_DIR names on the server (relative paths resolve against it); a path outside it is refused.',
      },
    ],
  },
  {
    id: 'discord-webhook',
    name: 'Discord Webhook',
    icon: React.createElement(MessageOutlined),
    color: '#5865F2',
    direction: 'target',
    hasBackend: true,
    idPatterns: ['discord-webhook'],
    description: 'Dev connector: POSTs a welcome message to a Discord webhook on provision.',
    category: 'Collaboration',
    configSchema: [
      {
        key: 'webhookUrl',
        label: 'Webhook URL',
        type: 'password',
        required: true,
        placeholder: 'https://discord.com/api/webhooks/...',
        helpText: 'Discord webhook URL for the target channel',
      },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: React.createElement(GithubOutlined),
    color: '#24292f',
    direction: 'target',
    hasBackend: true,
    idPatterns: ['github'],
    description:
      'Dev connector: invites users to a GitHub organization (their GitHub account when the identity has a GitHub login, else their email); offboarding removes them.',
    category: 'DevOps',
    configSchema: [
      {
        key: 'personalAccessToken',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        placeholder: 'ghp_xxxx',
        helpText: 'GitHub PAT with admin:org scope',
      },
      {
        key: 'orgName',
        label: 'Organization Name',
        type: 'text',
        required: true,
        placeholder: 'my-company',
        helpText: 'GitHub organization slug',
      },
    ],
  },
  {
    id: 'google-sheets',
    name: 'Google Sheets',
    icon: React.createElement(TableOutlined),
    color: '#34A853',
    direction: 'target',
    hasBackend: true,
    idPatterns: ['google-sheets'],
    description: 'Dev connector: appends user rows to a Google Sheet on provision.',
    category: 'Cloud',
    configSchema: [
      {
        key: 'sheetId',
        label: 'Sheet ID',
        type: 'text',
        required: true,
        placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        helpText: 'Google Sheet ID from URL (/d/SHEET_ID/edit)',
      },
      {
        key: 'serviceAccountJson',
        label: 'Service Account JSON',
        type: 'password',
        required: true,
        placeholder: '{"type":"service_account",...}',
        helpText:
          'Full JSON of service account credentials. Create in GCP: enable Sheets API, create service account, share sheet with client_email.',
      },
      {
        key: 'sheetName',
        label: 'Worksheet Name',
        type: 'text',
        required: false,
        placeholder: 'Sheet1',
        helpText: 'Worksheet name (optional, default: first sheet)',
      },
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

/** All source connectors */
export const SOURCE_CONNECTORS = CONNECTOR_REGISTRY.filter((c) => c.direction === 'source');

/** All target connectors */
export const TARGET_CONNECTORS = CONNECTOR_REGISTRY.filter((c) => c.direction === 'target');

/** Policy action target that stands for every target system. */
export const ALL_SYSTEMS_TARGET = 'all';

/**
 * Target systems a policy action can name: the target connectors the backend registers (by
 * backend id), then All Systems. The action drawer offers only these, so no policy action names a
 * system EuroID has no connector for.
 */
export const POLICY_ACTION_TARGETS: { value: string; label: string }[] = [
  ...TARGET_CONNECTORS.map((c) => ({ value: c.id ?? c.name, label: c.name })),
  { value: ALL_SYSTEMS_TARGET, label: 'All Systems' },
];

/** Target connectors that offer policy actions (`policyActions`), in registry order. */
export const POLICY_ACTION_CONNECTORS = TARGET_CONNECTORS.filter(
  (c) => (c.policyActions?.length ?? 0) > 0,
);

/**
 * The target connector a policy action names: by backend id (`ad`, `entra-id`) or by an exact
 * alias from its `idPatterns` (`active-directory`, which older policies saved).
 */
export const getPolicyTargetConnector = (target: string): ConnectorMeta | undefined =>
  TARGET_CONNECTORS.find((c) => c.id === target || c.idPatterns.includes(target));

/** Display name of a policy action target: the connector's name, All Systems, or the raw value. */
export const getPolicyTargetLabel = (target: string): string =>
  target === ALL_SYSTEMS_TARGET
    ? 'All Systems'
    : (getPolicyTargetConnector(target)?.name ?? target);

/** The registry label of a connector's policy action (e.g. Assign AD Group), when it has one. */
export const getPolicyActionLabel = (target: string, actionType: string): string | undefined =>
  getPolicyTargetConnector(target)?.policyActions?.find((a) => a.actionType === actionType)?.label;

/** Look up a connector by its display name */
export const getConnectorByName = (name: string): ConnectorMeta | undefined =>
  CONNECTOR_REGISTRY.find((c) => c.name === name);

/** Look up a connector by its backend ID (e.g. csv-hr, entra-id) */
export const getConnectorById = (id: string): ConnectorMeta | undefined =>
  CONNECTOR_REGISTRY.find((c) => c.id === id);

/** Get the icon for a connector by name */
export const getConnectorIcon = (name: string): React.ReactElement =>
  getConnectorByName(name)?.icon ?? React.createElement(CloudOutlined);

/**
 * Parse a ReactFlow node ID into a connector name.
 * e.g. "entra-target" → "Microsoft Entra ID", "github-target-17234" → "GitHub"
 */
export const parseConnectorNameFromNodeId = (nodeId: string): string => {
  for (const connector of CONNECTOR_REGISTRY) {
    if (connector.idPatterns.some((p) => nodeId.includes(p))) {
      return connector.name;
    }
  }
  return '';
};
