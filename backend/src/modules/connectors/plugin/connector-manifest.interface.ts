import { Type } from '@nestjs/common';

/** Capabilities a connector may support */
export type ConnectorCapability =
  | 'discover' // Can scan target system for entitlements
  | 'provision' // Can create/update users
  | 'deprovision' // Can disable/delete users
  | 'healthCheck' // Can verify connectivity
  | 'reconciliation' // Can participate in drift detection
  | 'ingest' // Can fetch users from HR source (IHrConnector)
  | 'hrWriteback' // Can push generated attributes back to HR (IHrConnectorWriteBack)
  | 'credentialManagement'; // Reads credential state (password age, MFA); resets no password

/** Config field definition for dynamic form generation */
export interface ConfigField {
  key: string; // e.g. 'tenantId', 'clientSecret'
  label: string; // e.g. 'Tenant ID', 'Client Secret'
  /**
   * 'password' marks the field secret: GET /connectors returns it masked, and an update
   * that sends the mask (or '') back keeps the stored value. Any value that embeds a
   * credential (token, key, webhook URL with a token) must be 'password'. 'json' is a JSON object
   * as text (stored as a string, like every config value); its validationFn names the rule the API
   * checks it with at install and update (connector-config-validation.ts).
   */
  type: 'text' | 'password' | 'select' | 'boolean' | 'number' | 'json';
  required: boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>; // For 'select' type
  defaultValue?: string | number | boolean;
  tab?: string; // Tab name (e.g. 'Connection', 'Scoping')
  helpText?: string; // Shown below the field
  validationFn?: string; // Named validation rule (e.g. 'isInsideBaseDn', 'hrFieldMap')
  dependsOn?: string; // Key of another field this validation depends on
}

/** The self-describing manifest every connector must export */
export interface ConnectorManifest {
  /** Unique connector identifier (e.g., 'entra-id', 'jira', 'ad') */
  id: string;

  /** Human-readable display name (e.g., 'Microsoft Entra ID') */
  name: string;

  /** Semver version of this connector */
  version: string;

  /** Short description for the marketplace UI */
  description: string;

  /** Ant Design icon name (e.g., 'WindowsOutlined', 'CloudOutlined') */
  icon?: string;

  /** What this connector can do */
  capabilities: ConnectorCapability[];

  /** Config fields for the installation form (dynamic form generation) */
  configSchema: ConfigField[];

  /** Temporal task queue name for bulkhead isolation. Omit to use default queue. */
  taskQueue?: string;

  /** NestJS module class for this connector. Registered dynamically by the plugin system. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS Type<T> requires any for dynamic module/service resolution
  module: Type<any>;

  /** Service class implementing IConnector. Used for validateCapabilities resolution. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS Type<T> requires any for dynamic service resolution
  serviceClass?: Type<any>;

  /** Activity class for Temporal worker registration */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS Type<T> requires any for dynamic activity resolution
  activityClass?: Type<any>;

  /**
   * Activity method bindings for the Temporal worker.
   * Maps activity function names to method names on the activity class.
   * Example: { 'provisionUserToEntra': 'provisionUserToEntra' }
   */
  activityBindings?: Record<string, string>;
}

// ── TASK 107 RECAP ──
// Added: serviceClass?: Type<any> — used by PluginRegistryService to resolve connector for validateCapabilities.
