import { RegoCompilerService } from './rego-compiler.service';
import type { Policy } from '../schemas/policy.schema';
import { PolicyStatus, RiskLevel } from '../schemas/policy.schema';

describe('RegoCompilerService', () => {
  let compiler: RegoCompilerService;

  beforeEach(() => {
    compiler = new RegoCompilerService();
  });

  const makePolicy = (overrides: Partial<Policy> = {}): Policy =>
    ({
      _id: 'policy-1',
      tenantId: 'test-tenant',
      name: 'Test Policy',
      description: 'A test policy',
      status: PolicyStatus.ACTIVE,
      priority: 3,
      risk: RiskLevel.LOW,
      conditionGroups: [],
      actions: [],
      tags: [],
      createdBy: 'system',
      affectedUsers: 0,
      totalExecutions: 0,
      ...overrides,
    }) as Policy;

  describe('compile', () => {
    it('generates valid Rego package header', () => {
      const result = compiler.compile([], 'test-tenant');
      expect(result).toContain('package euroid.policy.evaluate');
      expect(result).toContain('Tenant: test-tenant');
      expect(result).toContain('default operations := []');
    });

    it('skips non-active policies', () => {
      const policies = [
        makePolicy({ name: 'Active', status: PolicyStatus.ACTIVE }),
        makePolicy({ name: 'Disabled', status: PolicyStatus.DISABLED }),
        makePolicy({ name: 'Draft', status: PolicyStatus.DRAFT }),
      ];

      const result = compiler.compile(policies, 'test-tenant');
      expect(result).toContain('Policy: Active');
      expect(result).not.toContain('Policy: Disabled');
      expect(result).not.toContain('Policy: Draft');
    });

    it('compiles policy with equals condition', () => {
      const policy = makePolicy({
        name: 'Sales Policy',
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
            params: { targetId: 'Sales-Team' },
            label: 'Sales Team',
          },
        ],
      });

      const result = compiler.compile([policy], 'test-tenant');

      expect(result).toContain('input.user.department == "Sales"');
      expect(result).toContain('"type":"group"');
      expect(result).toContain('"target":"entra-id"');
    });

    it('compiles contains operator', () => {
      const policy = makePolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'jobTitle', operator: 'contains', value: 'Engineer' }],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_license', target: 'entra-id', params: { targetId: 'E3' } },
        ],
      });

      const result = compiler.compile([policy], 'test-tenant');
      expect(result).toContain('contains(input.user.jobTitle, "Engineer")');
    });

    it('compiles in operator with comma-separated values', () => {
      const policy = makePolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'country', operator: 'in', value: 'US,UK,DE' }],
          },
        ],
        actions: [{ id: 'a1', type: 'assign_group', target: 'ad', params: {} }],
      });

      const result = compiler.compile([policy], 'test-tenant');
      expect(result).toContain('"US"');
      expect(result).toContain('"UK"');
      expect(result).toContain('"DE"');
    });

    it('compiles regex operator', () => {
      const policy = makePolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'email', operator: 'regex', value: '.*@acme\\.com$' }],
          },
        ],
        actions: [{ id: 'a1', type: 'assign_group', target: 'entra-id', params: {} }],
      });

      const result = compiler.compile([policy], 'test-tenant');
      expect(result).toContain('regex.match');
    });

    it('compiles customAttributes fields', () => {
      const policy = makePolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'customAttributes.region', operator: 'equals', value: 'EMEA' },
            ],
          },
        ],
        actions: [{ id: 'a1', type: 'assign_group', target: 'ad', params: {} }],
      });

      const result = compiler.compile([policy], 'test-tenant');
      expect(result).toContain('input.user.customAttributes["region"]');
    });

    it('handles policy with no conditions (always matches)', () => {
      const policy = makePolicy({
        name: 'Default Policy',
        conditionGroups: [],
        actions: [
          { id: 'a1', type: 'assign_license', target: 'entra-id', params: { targetId: 'E1' } },
        ],
      });

      const result = compiler.compile([policy], 'test-tenant');
      expect(result).toContain('no conditions');
    });

    it('compiles OR group with any() function', () => {
      const policy = makePolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'OR',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Sales' },
              { id: 'c2', field: 'department', operator: 'equals', value: 'Marketing' },
            ],
          },
        ],
        actions: [{ id: 'a1', type: 'assign_group', target: 'entra-id', params: {} }],
      });

      const result = compiler.compile([policy], 'test-tenant');
      expect(result).toContain('(OR)');
      expect(result).toContain('any(');
    });

    it('compiles is_empty and is_not_empty operators', () => {
      const policy = makePolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'managerEmail', operator: 'is_not_empty', value: '' },
              { id: 'c2', field: 'endDate', operator: 'is_empty', value: '' },
            ],
          },
        ],
        actions: [{ id: 'a1', type: 'assign_group', target: 'ad', params: {} }],
      });

      const result = compiler.compile([policy], 'test-tenant');
      expect(result).toContain('input.user.managerEmail != ""');
      expect(result).toContain('input.user.endDate == ""');
    });

    it('maps frontend action types to canonical types', () => {
      const policy = makePolicy({
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { targetId: 'Group-A' } },
          { id: 'a2', type: 'assign_license', target: 'entra-id', params: { targetId: 'E3' } },
          { id: 'a3', type: 'enable_mfa', target: 'entra-id', params: {} },
        ],
      });

      const result = compiler.compile([policy], 'test-tenant');
      expect(result).toContain('"type":"group"');
      expect(result).toContain('"type":"license"');
      expect(result).toContain('"type":"mfa"');
    });

    it('handles array value (string[]) in conditions', () => {
      const policy = makePolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'country', operator: 'in', value: ['US', 'UK', 'DE'] }],
          },
        ],
        actions: [{ id: 'a1', type: 'assign_group', target: 'ad', params: {} }],
      });

      const result = compiler.compile([policy], 'test-tenant');
      expect(result).toContain('"US"');
      expect(result).toContain('"UK"');
    });
  });
});
