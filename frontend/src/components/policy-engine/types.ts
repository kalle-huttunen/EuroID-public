/**
 * Policy Engine Types
 *
 * Core type definitions for the Visual Policy Engine Studio.
 * Policies follow IF-THEN logic: IF (conditions match) THEN (execute actions).
 */

// --- Condition Types ---

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'in'
  | 'not_in'
  | 'regex'
  | 'greater_than'
  | 'less_than'
  | 'is_empty'
  | 'is_not_empty';

export type ConditionJoinType = 'AND' | 'OR';

export interface PolicyCondition {
  id: string;
  field: string; // StandardUserDto field (department, jobTitle, etc.)
  operator: ConditionOperator;
  value: string | string[];
}

export interface ConditionGroup {
  id: string;
  join: ConditionJoinType;
  conditions: PolicyCondition[];
}

// --- Action Types ---

export type ActionType =
  | 'assign_group'
  | 'assign_license'
  | 'assign_role'
  | 'set_attribute'
  | 'enable_mfa'
  | 'apply_conditional_access'
  | 'set_manager'
  | 'send_notification'
  | 'trigger_workflow';

/**
 * Target of a policy action. The Policy Engine page offers the registry's policy-action targets
 * (`ad`, `entra-id`, `scim`) and `all` (ActionRow). `active-directory` and `salesforce` appear only
 * in policies saved before that; they are displayed, not offered.
 */
export type ActionTarget = 'ad' | 'active-directory' | 'entra-id' | 'scim' | 'salesforce' | 'all';

export interface PolicyAction {
  id: string;
  type: ActionType;
  target: ActionTarget;
  params: Record<string, string>;
  // Display fields
  label?: string;
  description?: string;
}

// --- Policy ---

export type PolicyStatus = 'active' | 'disabled' | 'draft' | 'testing';
export type PolicyPriority = 1 | 2 | 3 | 4 | 5;
export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';

export interface Policy {
  id: string;
  name: string;
  description: string;
  status: PolicyStatus;
  priority: PolicyPriority;
  risk: RiskLevel;
  conditionGroups: ConditionGroup[];
  actions: PolicyAction[];
  // Metadata
  createdBy: string;
  /** Who last changed the conditions, actions or role bundle; may not activate the policy. */
  lastEditedBy?: string;
  lastEditedAt?: string;
  createdAt: string;
  updatedAt: string;
  lastTriggered?: string;
  // Impact stats
  affectedUsers?: number;
  totalExecutions?: number;
  // Tags
  tags?: string[];
  // Role bundle reference
  roleBundleId?: string;
}

// --- Role Bundles ---

export interface RoleBundle {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  actions: PolicyAction[];
  inheritance?: string[]; // Parent bundle IDs
  // Common example: "Standard Employee" → AD group + Entra license + Salesforce profile
  tags?: string[];
  usedByPolicies?: number;
}

// --- Available Fields for Condition Builder ---

export interface FieldOption {
  value: string;
  label: string;
  category: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum';
  enumValues?: string[];
}

export const AVAILABLE_FIELDS: FieldOption[] = [
  // Core Identity
  { value: 'department', label: 'Department', category: 'Organization', type: 'string' },
  { value: 'departmentCode', label: 'Department Code', category: 'Organization', type: 'string' },
  { value: 'jobTitle', label: 'Job Title', category: 'Organization', type: 'string' },
  {
    value: 'employmentType',
    label: 'Employment Type',
    category: 'Organization',
    type: 'enum',
    enumValues: ['Full-Time', 'Part-Time', 'Contractor', 'Intern'],
  },
  { value: 'location', label: 'Location', category: 'Organization', type: 'string' },
  { value: 'country', label: 'Country', category: 'Organization', type: 'string' },
  { value: 'office', label: 'Office', category: 'Organization', type: 'string' },
  { value: 'division', label: 'Division', category: 'Organization', type: 'string' },
  { value: 'costCenter', label: 'Cost Center', category: 'Organization', type: 'string' },

  // Role & Access
  {
    value: 'managerLevel',
    label: 'Manager Level',
    category: 'Role',
    type: 'enum',
    enumValues: ['IC', 'Lead', 'Manager', 'Director', 'VP', 'C-Level'],
  },
  { value: 'isManager', label: 'Is Manager', category: 'Role', type: 'boolean' },
  { value: 'directReports', label: 'Direct Reports Count', category: 'Role', type: 'number' },

  // Status
  {
    value: 'status',
    label: 'Account Status',
    category: 'Status',
    type: 'enum',
    enumValues: ['Active', 'Inactive', 'Suspended', 'Terminated'],
  },
  { value: 'startDate', label: 'Start Date', category: 'Status', type: 'date' },
  { value: 'terminationDate', label: 'Termination Date', category: 'Status', type: 'date' },
];

// --- Available Actions ---

export interface ActionOption {
  value: ActionType;
  label: string;
  category: string;
  targets: ActionTarget[];
  paramsSchema: {
    key: string;
    label: string;
    type: 'text' | 'select' | 'multi-select';
    options?: string[];
  }[];
}

export const AVAILABLE_ACTIONS: ActionOption[] = [
  {
    value: 'assign_group',
    label: 'Assign Security Group',
    category: 'Access',
    targets: ['active-directory', 'entra-id'],
    paramsSchema: [{ key: 'groupName', label: 'Group Name', type: 'text' }],
  },
  {
    value: 'assign_license',
    label: 'Assign License',
    category: 'Licensing',
    targets: ['entra-id'],
    paramsSchema: [
      // The entitlement catalog's licenses (LicenseSkuSelect), by Entra ID skuPartNumber
      { key: 'licenseSku', label: 'License SKU', type: 'select' },
    ],
  },
  {
    value: 'assign_role',
    label: 'Assign Directory Role',
    category: 'Access',
    targets: ['entra-id'],
    paramsSchema: [
      { key: 'roleName', label: 'Role Name', type: 'text' },
      { key: 'roleTemplateId', label: 'Role Template ID', type: 'text' },
    ],
  },
  {
    value: 'set_attribute',
    label: 'Set Attribute',
    category: 'Identity',
    targets: ['active-directory', 'entra-id', 'salesforce', 'all'],
    paramsSchema: [
      { key: 'attributeName', label: 'Attribute', type: 'text' },
      { key: 'attributeValue', label: 'Value', type: 'text' },
    ],
  },
  {
    value: 'enable_mfa',
    label: 'Enforce MFA',
    category: 'Security',
    targets: ['entra-id'],
    paramsSchema: [
      {
        key: 'mfaMethod',
        label: 'MFA Method',
        type: 'select',
        options: ['Authenticator App', 'SMS', 'Phone Call', 'Hardware Token'],
      },
    ],
  },
  {
    value: 'apply_conditional_access',
    label: 'Apply Conditional Access Policy',
    category: 'Security',
    targets: ['entra-id'],
    paramsSchema: [{ key: 'policyName', label: 'Policy Name', type: 'text' }],
  },
  {
    value: 'send_notification',
    label: 'Send Notification',
    category: 'Automation',
    targets: ['all'],
    paramsSchema: [
      {
        key: 'channel',
        label: 'Channel',
        type: 'select',
        options: ['Email', 'Teams', 'Slack', 'Webhook'],
      },
      { key: 'message', label: 'Message Template', type: 'text' },
    ],
  },
  {
    value: 'trigger_workflow',
    label: 'Trigger Workflow',
    category: 'Automation',
    targets: ['all'],
    paramsSchema: [{ key: 'workflowName', label: 'Workflow Name', type: 'text' }],
  },
];

// --- Data from API (no mocks in production) ---
// Policies: GET /api/v1/policy
// Role bundles: GET /api/v1/role-bundles (see RoleBundleManager, OnboardingWizard, PolicyEditor)
