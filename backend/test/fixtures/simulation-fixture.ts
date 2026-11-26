/**
 * Policy Simulation Fixture
 *
 * Sample users (5–10) with varied attributes and policies (2–3) with different conditions.
 * Used by policy-simulation.spec.ts for regression testing.
 *
 * When policies change (new operators, condition structure), update expected outputs here.
 *
 * @see docs/tasks/CURRENT_TASK_23.md
 */
import { StandardUserDto, UserStatus, EmploymentType } from '../../src/shared/dtos/standard-user.dto';

export interface FixtureUser extends Partial<StandardUserDto> {
  _id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  sourceSystem: string;
  sourceUserId: string;
  tenantId: string;
}

export interface FixturePolicy {
  _id: string;
  name: string;
  status: string;
  conditionGroups: Array<{
    id: string;
    join: 'AND' | 'OR';
    conditions: Array<{ id: string; field: string; operator: string; value: any }>;
  }>;
  actions: Array<{
    id: string;
    type: string;
    target: string;
    params: Record<string, any>;
  }>;
}

/** Expected operations per user email when all policies are evaluated */
export interface ExpectedOperations {
  [userEmail: string]: Array<{ type: string; targetId: string; sourcePolicy: string }>;
}

export const fixtureUsers: FixtureUser[] = [
  {
    _id: 'fixture-user-1',
    email: 'eng.alice@test.com',
    firstName: 'Alice',
    lastName: 'Engineer',
    status: UserStatus.ACTIVE,
    sourceSystem: 'TestHR',
    sourceUserId: 'EMP-001',
    tenantId: 'tenant-001',
    departmentName: 'Engineering',
    departmentCode: 'ENG',
    jobTitle: 'Software Engineer',
    employmentType: EmploymentType.FULL_TIME,
    countryCode: 'FI',
    location: 'Helsinki',
  },
  {
    _id: 'fixture-user-2',
    email: 'sales.bob@test.com',
    firstName: 'Bob',
    lastName: 'Sales',
    status: UserStatus.ACTIVE,
    sourceSystem: 'TestHR',
    sourceUserId: 'EMP-002',
    tenantId: 'tenant-001',
    departmentName: 'Sales',
    departmentCode: 'SAL',
    jobTitle: 'Account Manager',
    employmentType: EmploymentType.FULL_TIME,
    countryCode: 'US',
    location: 'New York',
  },
  {
    _id: 'fixture-user-3',
    email: 'hr.carol@test.com',
    firstName: 'Carol',
    lastName: 'HR',
    status: UserStatus.ACTIVE,
    sourceSystem: 'TestHR',
    sourceUserId: 'EMP-003',
    tenantId: 'tenant-001',
    departmentName: 'HR',
    departmentCode: 'HR',
    jobTitle: 'HR Manager',
    employmentType: EmploymentType.FULL_TIME,
    countryCode: 'FI',
    location: 'Helsinki',
  },
  {
    _id: 'fixture-user-4',
    email: 'eng.dave@test.com',
    firstName: 'Dave',
    lastName: 'Contractor',
    status: UserStatus.ACTIVE,
    sourceSystem: 'TestHR',
    sourceUserId: 'EMP-004',
    tenantId: 'tenant-001',
    departmentName: 'Engineering',
    departmentCode: 'ENG',
    jobTitle: 'Senior Developer',
    employmentType: EmploymentType.CONTRACTOR,
    countryCode: 'SE',
    location: 'Stockholm',
  },
  {
    _id: 'fixture-user-5',
    email: 'admin.eve@test.com',
    firstName: 'Eve',
    lastName: 'Admin',
    status: UserStatus.ACTIVE,
    sourceSystem: 'TestHR',
    sourceUserId: 'EMP-005',
    tenantId: 'tenant-001',
    departmentName: 'IT',
    departmentCode: 'IT',
    jobTitle: 'System Administrator',
    employmentType: EmploymentType.FULL_TIME,
    countryCode: 'FI',
    location: 'Helsinki',
  },
  {
    _id: 'fixture-user-6',
    email: 'marketing.frank@test.com',
    firstName: 'Frank',
    lastName: 'Marketing',
    status: UserStatus.PENDING,
    sourceSystem: 'TestHR',
    sourceUserId: 'EMP-006',
    tenantId: 'tenant-001',
    departmentName: 'Marketing',
    departmentCode: 'MKT',
    jobTitle: 'Marketing Lead',
    employmentType: EmploymentType.FULL_TIME,
    countryCode: 'NO',
    location: 'Oslo',
  },
];

export const fixturePolicies: FixturePolicy[] = [
  {
    _id: 'fixture-policy-1',
    name: 'Engineering Team',
    status: 'active',
    conditionGroups: [
      {
        id: 'g1',
        join: 'AND',
        conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' }],
      },
    ],
    actions: [
      {
        id: 'a1',
        type: 'assign_group',
        target: 'entra-id',
        params: { groupName: 'Engineering Team' },
      },
    ],
  },
  {
    _id: 'fixture-policy-2',
    name: 'Nordic FTE',
    status: 'active',
    conditionGroups: [
      {
        id: 'g1',
        join: 'AND',
        conditions: [
          { id: 'c1', field: 'country', operator: 'in', value: ['FI', 'SE', 'NO'] },
          { id: 'c2', field: 'employmentType', operator: 'equals', value: 'FULL_TIME' },
        ],
      },
    ],
    actions: [
      {
        id: 'a1',
        type: 'assign_license',
        target: 'entra-id',
        params: { licenseSku: 'E3' },
      },
    ],
  },
  {
    _id: 'fixture-policy-3',
    name: 'Sales Only',
    status: 'active',
    conditionGroups: [
      {
        id: 'g1',
        join: 'AND',
        conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'Sales' }],
      },
    ],
    actions: [
      {
        id: 'a1',
        type: 'assign_group',
        target: 'entra-id',
        params: { groupName: 'Sales Group' },
      },
    ],
  },
];

/**
 * Expected operations per user when all fixture policies are evaluated.
 * Update this when adding policies or changing condition logic.
 */
export const expectedOperationsPerUser: ExpectedOperations = {
  'eng.alice@test.com': [
    { type: 'group', targetId: 'Engineering Team', sourcePolicy: 'Engineering Team' },
    { type: 'license', targetId: 'E3', sourcePolicy: 'Nordic FTE' },
  ],
  'sales.bob@test.com': [
    { type: 'group', targetId: 'Sales Group', sourcePolicy: 'Sales Only' },
  ],
  'hr.carol@test.com': [
    { type: 'license', targetId: 'E3', sourcePolicy: 'Nordic FTE' },
  ],
  'eng.dave@test.com': [
    { type: 'group', targetId: 'Engineering Team', sourcePolicy: 'Engineering Team' },
  ],
  'admin.eve@test.com': [
    { type: 'license', targetId: 'E3', sourcePolicy: 'Nordic FTE' },
  ],
  'marketing.frank@test.com': [
    { type: 'license', targetId: 'E3', sourcePolicy: 'Nordic FTE' },
  ],
};
