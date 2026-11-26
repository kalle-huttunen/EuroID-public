/**
 * Shared mock factories for unit tests.
 * Provides realistic test data matching our DTOs and schemas.
 */
import { StandardUserDto, UserStatus, EmploymentType } from '@shared/dtos/standard-user.dto';
import { Policy } from '@modules/policy/schemas/policy.schema';
import { TEST_TENANT_ID } from './test-helpers';

// ── Auth mock factory types ───────────────────────────────────────────

/** Shape matching AdminUserDocument for test mocks. */
export interface MockAdminUser {
  _id: { toString(): string };
  email: string;
  passwordHash: string;
  name: string;
  role: string;
  tenantId: string;
  isActive: boolean;
  tokenVersion: number;
  passwordHistory: string[];
  refreshTokenHash?: string;
  refreshTokenExpiresAt?: Date;
  mfaSecret?: string;
  mfaEnabled: boolean;
  mfaBackupCodes: string[];
  authSource: 'local' | 'saml';
}

/** Shape matching a SAML profile as returned by SamlAuthService.validateCallback. */
export interface MockSamlProfile {
  email: string;
  name?: string;
  role?: string;
  tenantId?: string;
  nameID?: string;
  nameIDFormat?: string;
}

/** Minimal valid StandardUserDto for testing */
export function createMockUser(overrides: Partial<StandardUserDto> = {}): StandardUserDto {
  return {
    _id: 'test-user-id-001',
    sourceSystem: 'TestHR',
    sourceUserId: 'EMP-001',
    tenantId: TEST_TENANT_ID,
    contractType: 'primary',
    firstName: 'John',
    lastName: 'Doe',
    email: 'john.doe@example.com',
    displayName: 'John Doe',
    userPrincipalName: 'john.doe@example.com',
    status: UserStatus.ACTIVE,
    departmentName: 'Engineering',
    departmentCode: 'ENG',
    jobTitle: 'Software Engineer',
    employmentType: EmploymentType.FULL_TIME,
    location: 'Helsinki',
    city: 'Helsinki',
    countryCode: 'FI',
    employeeId: 'EMP-001',
    startDate: new Date('2024-01-15'),
    ...overrides,
  } as StandardUserDto;
}

/** Create a mock policy matching the Policy schema */
export function createMockPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    _id: 'test-policy-id-001',
    tenantId: TEST_TENANT_ID,
    name: 'Test Policy',
    description: 'A test policy',
    status: 'active',
    priority: 3,
    risk: 'Low',
    conditionGroups: [
      {
        id: 'group-1',
        join: 'AND' as const,
        conditions: [
          {
            id: 'cond-1',
            field: 'department',
            operator: 'equals',
            value: 'Engineering',
          },
        ],
      },
    ],
    actions: [
      {
        id: 'action-1',
        type: 'assign_group',
        target: 'entra-id',
        params: { groupName: 'Engineering Team' },
      },
    ],
    tags: [],
    createdBy: 'test',
    affectedUsers: 0,
    totalExecutions: 0,
    ...overrides,
  } as Policy;
}

// ── Auth Mock Factories ────────────────────────────────────────────────

/**
 * Create a mock AdminUser document for auth tests.
 * Password defaults to bcrypt hash of 'ValidPass1!' (pre-computed for speed).
 */
export function createMockAdminUser(overrides: Partial<MockAdminUser> = {}): MockAdminUser {
  return {
    _id: { toString: () => 'admin-user-id-001' },
    email: 'admin@example.com',
    // bcrypt hash of 'ValidPass1!' with 4 rounds (fast for tests)
    passwordHash: '$2a$04$LgMBmjt3v0t.HbNn8mVzaOkZCpqFv/rJlxPkG9a7fJrTJqDZ7S5sK',
    name: 'Test Admin',
    role: 'super-admin',
    tenantId: TEST_TENANT_ID,
    isActive: true,
    tokenVersion: 0,
    passwordHistory: [],
    mfaEnabled: false,
    mfaBackupCodes: [],
    authSource: 'local',
    ...overrides,
  };
}

/** Create a mock MFA setup object (TOTP secret + backup codes). */
export function createMockMfaSetup(
  overrides: Partial<{ secret: string; backupCodes: string[] }> = {},
): {
  secret: string;
  backupCodes: string[];
} {
  return {
    secret: 'JBSWY3DPEHPK3PXP', // Well-known test TOTP secret (base32)
    backupCodes: ['ABCD1234', 'EFGH5678', 'IJKL9012', 'MNOP3456', 'QRST7890'],
    ...overrides,
  };
}

/** Create a mock SAML profile for SSO tests. */
export function createMockSamlProfile(overrides: Partial<MockSamlProfile> = {}): MockSamlProfile {
  return {
    email: 'saml.user@example.com',
    name: 'SAML User',
    role: 'viewer',
    tenantId: TEST_TENANT_ID,
    nameID: 'saml.user@example.com',
    nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    ...overrides,
  };
}

// ── Identity Mock Factories ───────────────────────────────────────────

/** Create a mock Identity document matching the Mongoose schema (onion model). */
export function createMockIdentityDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: 'identity-001',
    tenantId: TEST_TENANT_ID,
    profile: {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      departmentName: 'Engineering',
      departmentCode: 'ENG',
      jobTitle: 'Software Engineer',
      employmentType: 'FULL_TIME',
      location: 'Helsinki',
      status: 'ACTIVE',
      managerEmail: 'manager@example.com',
    },
    sources: [{ sourceName: 'TestHR', externalId: 'EMP-001' }],
    provisioning: [],
    adminTier: undefined,
    linkedAdminAccounts: [],
    createdAt: new Date('2024-01-15'),
    updatedAt: new Date('2024-06-01'),
    deletedAt: undefined,
    ...overrides,
  };
}

/** Create a mock connector config for tests. */
export function createMockConnectorConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: 'connector-config-001',
    tenantId: TEST_TENANT_ID,
    name: 'entra-id',
    type: 'entra-id',
    enabled: true,
    config: {
      tenantId: 'azure-tenant-id',
      clientId: 'client-id',
      clientSecret: '[ENCRYPTED]',
    },
    capabilities: ['ingest', 'provision', 'reconcile'],
    ...overrides,
  };
}

/** Create a mock drift result for reconciliation tests. */
export function createMockDriftResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: 'drift-001',
    tenantId: TEST_TENANT_ID,
    identityId: 'identity-001',
    system: 'entra-id',
    type: 'FIELD_MISMATCH',
    status: 'OPEN',
    expected: { displayName: 'John Doe' },
    actual: { displayName: 'J Doe' },
    detectedAt: new Date(),
    ...overrides,
  };
}

/** Create a mock access request for approval workflow tests. */
export function createMockAccessRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestId: 'req-001',
    tenantId: TEST_TENANT_ID,
    requesterId: 'user-001',
    requesterEmail: 'user@example.com',
    targetIdentityId: 'user-001',
    entitlements: [
      {
        catalogEntryId: 'cat-001',
        system: 'entra-id',
        entitlementName: 'Engineering-Group',
        nativeId: 'eng-group-id',
        entitlementType: 'Group',
        justification: 'Need access for project',
      },
    ],
    status: 'PENDING_APPROVAL',
    approvalSteps: [
      {
        stepOrder: 0,
        approverType: 'MANAGER',
        approverEmail: 'manager@example.com',
        status: 'PENDING',
      },
    ],
    workflowId: 'access-request-req-001',
    createdAt: new Date(),
    ...overrides,
  };
}

/** Create a mock role bundle for policy engine tests. */
export function createMockRoleBundle(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: 'bundle-001',
    tenantId: TEST_TENANT_ID,
    name: 'Engineering Bundle',
    description: 'Standard engineering entitlements',
    entitlements: [
      { system: 'entra-id', type: 'group', targetId: 'eng-group', targetName: 'Engineering Team' },
      {
        system: 'entra-id',
        type: 'license',
        targetId: 'e5-license',
        targetName: 'Microsoft 365 E5',
      },
    ],
    inherits: [],
    ...overrides,
  };
}
