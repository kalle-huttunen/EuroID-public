/** Shared Graph API response types used across Entra sub-services. */

export interface GraphUserResponse {
  id: string;
  mail?: string;
  userPrincipalName?: string;
}

/** An account's state before a change: the attributes that change writes, or `existed: false`. */
export interface EntraUserState {
  existed: boolean;
  objectId?: string;
  attributes?: Record<string, unknown>;
}

export interface GraphSku {
  skuPartNumber?: string;
  skuId?: string;
  consumedUnits?: number;
  prepaidUnits?: { enabled?: number };
}

export interface GraphGroup {
  id: string;
  displayName?: string;
}

export interface GraphVerifiedDomain {
  name: string;
}

export interface GraphOrganization {
  verifiedDomains?: GraphVerifiedDomain[];
}

/** Microsoft Graph unifiedRoleDefinition (roleManagement/directory/roleDefinitions) */
export interface GraphRoleDefinition {
  id?: string;
  templateId?: string;
  displayName?: string;
  description?: string;
  isBuiltIn?: boolean;
}

/** Microsoft Graph unifiedRoleAssignment (roleManagement/directory/roleAssignments) */
export interface GraphRoleAssignment {
  id: string;
  principalId: string;
  roleDefinitionId: string;
  directoryScopeId?: string;
}

export interface ConfigKeyStatus {
  status: 'ok' | 'missing' | 'placeholder';
  hint?: string;
}
