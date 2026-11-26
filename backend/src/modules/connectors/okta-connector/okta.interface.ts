/**
 * Okta Connector — Type Definitions
 *
 * Native Okta API types for the "beyond SCIM" connector.
 * Supports app assignments and lifecycle states (no password or MFA factor operations).
 */

import { IConnector } from '../connector.interface';

// ── Configuration ──

export interface OktaConfig {
  /** Okta org URL (e.g., https://dev-123456.okta.com) */
  orgUrl: string;
  /** Okta API token (SSWS) */
  apiToken: string;
  /** Default group ID for new users (optional) */
  defaultGroupId?: string;
  /** Offboarding: deactivate the user (default), or deactivate and then delete it */
  deprovisionStrategy?: 'deactivate' | 'delete';
}

// ── Okta API Response Types ──

export interface OktaUserProfile {
  firstName: string;
  lastName: string;
  email: string;
  login: string;
  mobilePhone?: string;
  title?: string;
  department?: string;
  displayName?: string;
  employeeNumber?: string;
}

export interface OktaUser {
  id: string;
  status: string;
  profile: OktaUserProfile;
  created?: string;
  lastUpdated?: string;
  lastLogin?: string;
  passwordChanged?: string;
  /** When the user's status last changed (Okta's `statusChanged`). */
  statusChanged?: string | null;
}

export interface OktaGroup {
  id: string;
  profile: {
    name: string;
    description?: string;
  };
  type?: string;
}

export interface OktaApplication {
  id: string;
  name: string;
  label: string;
  status?: string;
}

// ── Provisioning Intent Operations ──

export interface OktaProvisioningIntent {
  operations: Array<{
    type: 'group' | 'app' | 'role';
    action: 'add' | 'remove';
    targetId: string;
  }>;
}

// ── Connector Interface ──

export interface IOktaConnector extends IConnector {
  /** Discover groups and applications */
  discover(config?: OktaConfig): Promise<Array<{ nativeId: string; name: string; type: string }>>;

  /** Health check — verify connectivity */
  healthCheck(config?: OktaConfig): Promise<boolean>;
}
