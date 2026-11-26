/**
 * Types for GET /api/v1/connectors/available response.
 * Matches backend ConnectorManifest (excluding backend-only fields).
 */
export interface ConfigField {
  key: string;
  label: string;
  /** 'json': a JSON object as text (an HR column or field map); the API checks its entries. */
  type: 'text' | 'password' | 'select' | 'boolean' | 'number' | 'json';
  required: boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
  defaultValue?: string | number | boolean;
  tab?: string;
  helpText?: string;
  validationFn?: string;
  dependsOn?: string;
}

export interface AvailableConnector {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: string;
  capabilities: string[];
  configSchema: ConfigField[];
}

export interface ConnectorSyncStatus {
  lastSyncAt: string | null;
  lastSyncStatus: 'success' | 'failed' | 'running' | null;
  lastSyncCount: number | null;
  lastSyncError: string | null;
  syncIntervalHours: number;
  nextSyncAt: string | null;
}
