/**
 * ServiceNow Connector — Config and types.
 *
 * Ticket integration connector: creates incidents/change requests
 * for provisioning events, optionally syncs user records.
 */

/** Configuration for ServiceNow Connector */
export interface ServiceNowConfig {
  /** ServiceNow instance URL (e.g., https://mycompany.service-now.com) */
  instanceUrl: string;
  /** OAuth2 Client ID */
  clientId: string;
  /** OAuth2 Client Secret */
  clientSecret: string;
  /** Username for Basic auth fallback */
  username?: string;
  /** Password for Basic auth fallback */
  password?: string;
  /** Default assignment group sys_id for incidents */
  defaultAssignmentGroup?: string;
  /** Default incident category */
  incidentCategory?: string;
  /** Default incident priority (1=Critical, 2=High, 3=Moderate, 4=Low) */
  incidentPriority?: string;
}

/** Cached OAuth2 token with expiry */
export interface ServiceNowOAuthToken {
  accessToken: string;
  expiresAt: number;
}

/** ServiceNow user record from sys_user table */
export interface ServiceNowUser {
  sys_id: string;
  user_name: string;
  email: string;
  first_name: string;
  last_name: string;
  title?: string;
  department?: string;
  active: string; // 'true' | 'false'
  locked_out?: string; // 'true' | 'false'
}

/** ServiceNow incident record */
export interface ServiceNowIncident {
  sys_id: string;
  number: string;
  state: string;
  short_description: string;
  description?: string;
  priority: string;
  category?: string;
  assignment_group?: string;
}

/** ServiceNow assignment group */
export interface ServiceNowGroup {
  sys_id: string;
  name: string;
  description?: string;
  active: string;
}

/** ServiceNow API list response envelope */
export interface ServiceNowListResponse<T> {
  result: T[];
}

/** ServiceNow API single-record response envelope */
export interface ServiceNowSingleResponse<T> {
  result: T;
}
