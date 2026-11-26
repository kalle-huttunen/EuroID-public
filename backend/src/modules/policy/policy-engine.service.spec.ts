import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { PolicyEngineService } from './policy-engine.service';
import { SodPolicy } from './schemas/sod-policy.schema';
import { PamFilterService } from './pam-filter.service';
import { PolicyService } from './policy.service';
import { SodService } from './sod.service';
import { ReviewExclusionService } from './review-exclusion.service';
import type { ReviewExclusionMatch } from './review-exclusion-match';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { ROLE_BUNDLE_RESOLVER_PORT } from '@shared/interfaces/role-bundle-resolver.port';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import { createMockUser, createMockPolicy } from '@testing/mock-factories';
import { EmploymentType, StandardUserDto } from '@shared/dtos/standard-user.dto';
import { createMockLoggerFactory, createMockEventEmitter } from '@testing/test-helpers';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import { Policy, PolicyDocument } from './schemas/policy.schema';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { authConfig } from '@infrastructure/config/auth.config';

describe('PolicyEngineService', () => {
  let engine: PolicyEngineService;
  let policyService: jest.Mocked<Partial<PolicyService>>;
  let sodService: jest.Mocked<Partial<SodService>>;
  let roleBundlesService: { resolveWithInheritance: jest.Mock };
  let reviewExclusions: { activeForProfile: jest.Mock };

  beforeEach(async () => {
    const { factory: loggerFactory } = createMockLoggerFactory();

    policyService = {
      findActive: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };

    sodService = {
      validate: jest.fn().mockResolvedValue([]),
    };

    roleBundlesService = {
      resolveWithInheritance: jest.fn().mockResolvedValue([]),
    };

    reviewExclusions = { activeForProfile: jest.fn().mockResolvedValue([]) };

    const identityService = {
      findAllPaginated: jest.fn().mockResolvedValue([[], 0]),
    };

    const module = await Test.createTestingModule({
      providers: [
        PolicyEngineService,
        PamFilterService,
        { provide: PolicyService, useValue: policyService },
        { provide: SodService, useValue: sodService },
        { provide: ReviewExclusionService, useValue: reviewExclusions },
        { provide: ROLE_BUNDLE_RESOLVER_PORT, useValue: roleBundlesService },
        { provide: IDENTITY_QUERY_PORT, useValue: identityService },
        {
          provide: EntitlementCatalogService,
          useValue: { findForAdminRedirect: jest.fn().mockResolvedValue(null) },
        },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
        { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: 'test-tenant' } },
      ],
    }).compile();

    engine = module.get(PolicyEngineService);
  });

  // --- evaluateWithPolicies (pure logic) ---

  describe('evaluateWithPolicies', () => {
    it('should return empty operations when no policies provided', async () => {
      const user = createMockUser();
      const result = await engine.evaluateWithPolicies(user, []);
      expect(result.operations).toEqual([]);
    });

    it('should match user by department equals condition', async () => {
      const user = createMockUser({ departmentName: 'Engineering' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Eng Team' } },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].targetId).toBe('Eng Team');
      expect(result.operations[0].sourcePolicy).toBe('Test Policy');
    });

    it('should NOT match when department condition fails', async () => {
      const user = createMockUser({ departmentName: 'Sales' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(0);
    });

    it('should support OR within a condition group', async () => {
      const user = createMockUser({ departmentName: 'Sales' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'OR',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
              { id: 'c2', field: 'department', operator: 'equals', value: 'Sales' },
            ],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'All Staff' },
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should require ALL condition groups to pass (AND between groups)', async () => {
      const user = createMockUser({ departmentName: 'Engineering', countryCode: 'US' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
          {
            id: 'g2',
            join: 'AND',
            conditions: [{ id: 'c2', field: 'country', operator: 'equals', value: 'FI' }],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'FI Eng' } },
        ],
      });

      // Group 1 passes (Engineering), Group 2 fails (US ≠ FI)
      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(0);
    });

    it('should return empty when policy has no condition groups', async () => {
      const user = createMockUser();
      const policy = createMockPolicy({ conditionGroups: [] });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(0);
    });

    it('should skip SERVICE_ACCOUNT when policy has no targetEmploymentTypes', async () => {
      const user = createMockUser({
        employmentType: EmploymentType.SERVICE_ACCOUNT,
        departmentName: 'Engineering',
      });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Eng Team' } },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(0);
    });

    it('should evaluate SERVICE_ACCOUNT when policy targets it', async () => {
      const user = createMockUser({
        employmentType: EmploymentType.SERVICE_ACCOUNT,
        departmentName: 'Engineering',
      });
      const policy = createMockPolicy({
        targetEmploymentTypes: ['SERVICE_ACCOUNT'],
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Eng Team' } },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].targetId).toBe('Eng Team');
    });

    it('should map action types correctly (assign_group → group)', async () => {
      const user = createMockUser({ departmentName: 'Engineering' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'G1' } },
          { id: 'a2', type: 'assign_license', target: 'entra-id', params: { licenseSku: 'E3' } },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(2);
      expect(result.operations[0].type).toBe('group');
      expect(result.operations[1].type).toBe('license');
    });

    it('should map assign_role to role', async () => {
      const user = createMockUser({ departmentName: 'IT' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'IT' }],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_role',
            target: 'entra-id',
            params: { roleTemplateId: 'User Administrator' },
          },
        ],
      });
      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].type).toBe('role');
    });

    it('should evaluate multiple policies and merge operations', async () => {
      const user = createMockUser({
        departmentName: 'Engineering',
        employmentType: 'FTE' as EmploymentType,
      });
      const p1 = createMockPolicy({
        name: 'Dept Policy',
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Eng' } },
        ],
      });
      const p2 = createMockPolicy({
        name: 'FTE Policy',
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'employmentType', operator: 'equals', value: 'FTE' }],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_license', target: 'entra-id', params: { licenseSku: 'E3' } },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [p1, p2]);
      expect(result.operations).toHaveLength(2);
      expect(result.operations[0].sourcePolicy).toBe('Dept Policy');
      expect(result.operations[1].sourcePolicy).toBe('FTE Policy');
    });

    it('should support "contains" operator', async () => {
      const user = createMockUser({ jobTitle: 'Senior Software Engineer' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'jobTitle', operator: 'contains', value: 'Engineer' }],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'Engineers' },
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should support "in" operator with array value', async () => {
      const user = createMockUser({ countryCode: 'FI' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'country', operator: 'in', value: ['FI', 'SE', 'NO'] }],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Nordic' } },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should support "regex" operator', async () => {
      const user = createMockUser({ email: 'john.doe@example.com' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'email', operator: 'regex', value: '@example\\.com$' }],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Internal' } },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should support contracts.* field for multi-contract evaluation', async () => {
      const user = createMockUser({
        contracts: [
          {
            id: 'c1',
            department: 'Medical',
            title: 'Nurse',
            status: 'ACTIVE' as const,
            isPrimary: false,
          },
          {
            id: 'c2',
            department: 'Admin',
            title: 'Coordinator',
            status: 'ACTIVE' as const,
            isPrimary: false,
          },
        ],
      });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              {
                id: 'c1',
                field: 'contracts.department',
                operator: 'equals',
                value: 'Medical',
              },
            ],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'Medical Staff' },
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should handle is_empty operator for missing fields', async () => {
      const user = createMockUser({ jobTitle: undefined });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'jobTitle', operator: 'is_empty', value: '' }],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'Needs Job Title' },
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should support "not_equals" operator', async () => {
      const user = createMockUser({ departmentName: 'Engineering' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'department', operator: 'not_equals', value: 'Sales' }],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'Not Sales' },
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should support "starts_with" operator', async () => {
      const user = createMockUser({ jobTitle: 'Senior Engineer' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'jobTitle', operator: 'starts_with', value: 'Senior' }],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'Senior Staff' },
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should support "ends_with" operator', async () => {
      const user = createMockUser({ jobTitle: 'Software Engineer' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'jobTitle', operator: 'ends_with', value: 'Engineer' }],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'Engineers' },
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should support "is_not_empty" operator', async () => {
      const user = createMockUser({ jobTitle: 'Manager' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'jobTitle', operator: 'is_not_empty', value: '' }],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'Has Title' },
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should support "not_in" operator', async () => {
      const user = createMockUser({ countryCode: 'US' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'country', operator: 'not_in', value: ['FI', 'SE', 'NO'] },
            ],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'Non-Nordic' },
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should support "greater_than" operator for numeric values', async () => {
      const user = createMockUser({ customAttributes: { priority: 5 } });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              {
                id: 'c1',
                field: 'customAttributes.priority',
                operator: 'greater_than',
                value: '3',
              },
            ],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'High Priority' },
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should support "less_than" operator for numeric values', async () => {
      const user = createMockUser({ customAttributes: { score: 50 } });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'score', operator: 'less_than', value: '100' }],
          },
        ],
        actions: [
          {
            id: 'a1',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'Low Score' },
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should support "contracts.*" with not_in operator (array context)', async () => {
      const user = createMockUser({
        contracts: [
          {
            id: 'c1',
            department: 'Medical',
            title: 'Nurse',
            status: 'ACTIVE' as const,
            isPrimary: false,
          },
          {
            id: 'c2',
            department: 'Admin',
            title: 'Coordinator',
            status: 'ACTIVE' as const,
            isPrimary: false,
          },
        ],
      });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              {
                id: 'c1',
                field: 'contracts.department',
                operator: 'not_in',
                value: ['IT', 'Engineering'],
              },
            ],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Non-IT' } },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
    });

    it('should resolve roleBundleId and include bundle actions in operations', async () => {
      const user = createMockUser({ departmentName: 'Engineering' });
      const policy = createMockPolicy({
        roleBundleId: 'bundle-123',
        actions: [],
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
        ],
      });
      jest.mocked(roleBundlesService.resolveWithInheritance)!.mockResolvedValue([
        { id: 'b1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Eng Team' } },
        { id: 'b2', type: 'assign_license', target: 'entra-id', params: { licenseSku: 'E3' } },
        { id: 'b3', type: 'assign_group', target: 'entra-id', params: { groupName: 'All Staff' } },
      ]);

      const result = await engine.evaluateWithPolicies(user, [policy], TEST_TENANT_ID);
      expect(result.operations).toHaveLength(3);
      expect(roleBundlesService.resolveWithInheritance).toHaveBeenCalledWith(
        'bundle-123',
        TEST_TENANT_ID,
      );
      expect(result.operations[0].targetId).toBe('Eng Team');
      expect(result.operations[1].targetId).toBe('E3');
      expect(result.operations[2].targetId).toBe('All Staff');
    });

    it('should merge bundle actions with policy actions and deduplicate', async () => {
      const user = createMockUser({ departmentName: 'Engineering' });
      const policy = createMockPolicy({
        roleBundleId: 'bundle-123',
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Eng Team' } },
          { id: 'a2', type: 'assign_license', target: 'entra-id', params: { licenseSku: 'E5' } },
        ],
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
        ],
      });
      jest.mocked(roleBundlesService.resolveWithInheritance)!.mockResolvedValue([
        { id: 'b1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Eng Team' } },
        { id: 'b2', type: 'assign_license', target: 'entra-id', params: { licenseSku: 'E3' } },
      ]);

      const result = await engine.evaluateWithPolicies(user, [policy], TEST_TENANT_ID);
      expect(result.operations).toHaveLength(3);
      expect(result.operations.map((o) => o.targetId)).toContain('Eng Team');
      expect(result.operations.map((o) => o.targetId)).toContain('E3');
      expect(result.operations.map((o) => o.targetId)).toContain('E5');
    });

    // Hunt 04 F12: a failed resolution was only logged, so the intent came out without the
    // bundle's operations and a mover or reconcile run read their absence as a removal
    it('fails the evaluation when the role bundle cannot be read, never giving a partial intent', async () => {
      const user = createMockUser({ departmentName: 'Engineering' });
      const policy = createMockPolicy({
        roleBundleId: 'bundle-123',
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Eng Team' } },
        ],
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
        ],
      });
      jest
        .mocked(roleBundlesService.resolveWithInheritance)!
        .mockRejectedValue(new Error('MongoNetworkError: connection reset'));

      await expect(engine.evaluateWithPolicies(user, [policy], TEST_TENANT_ID)).rejects.toThrow(
        /Role bundle bundle-123 of policy "Test Policy" could not be resolved/,
      );
    });

    // Hunt 04 F11: [].every(Boolean) is true, so a stored AND group with no conditions matched
    // every identity
    it.each(['AND', 'OR'] as const)(
      'a stored %s group with no conditions matches nobody',
      async (join) => {
        const policy = createMockPolicy({
          actions: [
            { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Admins' } },
          ],
          conditionGroups: [{ id: 'g1', join, conditions: [] }],
        });

        const result = await engine.evaluateWithPolicies(createMockUser(), [policy]);

        expect(result.operations).toEqual([]);
      },
    );

    it('should NOT call resolveWithInheritance when roleBundleId is absent', async () => {
      const user = createMockUser({ departmentName: 'Engineering' });
      const policy = createMockPolicy({
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Eng Team' } },
        ],
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
        ],
      });

      const result = await engine.evaluateWithPolicies(user, [policy]);
      expect(result.operations).toHaveLength(1);
      expect(roleBundlesService.resolveWithInheritance).not.toHaveBeenCalled();
    });
  });

  // --- evaluate (with mocked dependencies) ---

  describe('getImpactCount', () => {
    it('should return count of users matching the policy', async () => {
      const policy = createMockPolicy();
      const users = [
        createMockUser({ departmentName: 'Engineering' }),
        createMockUser({ departmentName: 'Sales' }),
        createMockUser({ departmentName: 'Engineering' }),
      ];
      jest.mocked(policyService.findOne)!.mockResolvedValue(policy as unknown as PolicyDocument);
      const identityService = {
        findAllPaginated: jest.fn().mockResolvedValue([users, users.length]),
      };
      const entitlementCatalogService = { findForAdminRedirect: jest.fn().mockResolvedValue(null) };
      const module = await Test.createTestingModule({
        providers: [
          PolicyEngineService,
          PamFilterService,
          { provide: PolicyService, useValue: policyService },
          { provide: SodService, useValue: sodService },
          { provide: ReviewExclusionService, useValue: reviewExclusions },
          { provide: ROLE_BUNDLE_RESOLVER_PORT, useValue: roleBundlesService },
          { provide: IDENTITY_QUERY_PORT, useValue: identityService },
          { provide: EntitlementCatalogService, useValue: entitlementCatalogService },
          { provide: LoggerFactoryService, useValue: createMockLoggerFactory().factory },
          { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
          { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: 'test-tenant' } },
        ],
      }).compile();
      const engineWithIdentity = module.get(PolicyEngineService);

      const count = await engineWithIdentity.getImpactCount('policy-id');
      expect(count).toBe(2); // 2 Engineering users match
      expect(policyService.findOne).toHaveBeenCalledWith('policy-id');
    });
  });

  describe('simulate', () => {
    it('should return matched users and stats when passing policy object', async () => {
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            ],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Eng' } },
        ],
      });
      const users = [
        createMockUser({ departmentName: 'Engineering', email: 'eng1@test.com' }),
        createMockUser({ departmentName: 'Sales', email: 'sales@test.com' }),
      ];
      const identityService = {
        findAllPaginated: jest.fn().mockResolvedValue([users, users.length]),
      };
      const entitlementCatalogService = { findForAdminRedirect: jest.fn().mockResolvedValue(null) };
      const module = await Test.createTestingModule({
        providers: [
          PolicyEngineService,
          PamFilterService,
          { provide: PolicyService, useValue: policyService },
          { provide: SodService, useValue: sodService },
          { provide: ReviewExclusionService, useValue: reviewExclusions },
          { provide: ROLE_BUNDLE_RESOLVER_PORT, useValue: roleBundlesService },
          { provide: IDENTITY_QUERY_PORT, useValue: identityService },
          { provide: EntitlementCatalogService, useValue: entitlementCatalogService },
          { provide: LoggerFactoryService, useValue: createMockLoggerFactory().factory },
          { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
          { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: 'test-tenant' } },
        ],
      }).compile();
      const engineWithIdentity = module.get(PolicyEngineService);

      const result = await engineWithIdentity.simulate(policy as unknown as Policy);

      expect(result.totalUsers).toBe(2);
      expect(result.matchedCount).toBe(1);
      expect(result.matchPercentage).toBe(50);
      expect(result.matchedUsers).toHaveLength(1);
      expect(result.matchedUsers[0].email).toBe('eng1@test.com');
      expect(result.actionsBySystem['entra-id']).toBe(1);
    });
  });

  describe('evaluate: the policy.evaluated event (audit log, timeline)', () => {
    const emitted = () => {
      const emit = (engine as unknown as { eventEmitter: { emit: jest.Mock } }).eventEmitter.emit;
      const calls = emit.mock.calls.filter(([t]) => t === DomainEventType.POLICY_EVALUATED);
      expect(calls).toHaveLength(1);
      const [, aggregateId, payload] = calls[0] as [string, string, Record<string, unknown>];
      expect(EVENT_SCHEMAS[DomainEventType.POLICY_EVALUATED]!.parse(payload)).toEqual(payload);
      return { aggregateId, payload };
    };

    beforeEach(() => {
      jest
        .mocked(policyService.findActive)!
        .mockResolvedValue([createMockPolicy()] as unknown as PolicyDocument[]);
    });

    it("goes under the identity's id, marked when provisioning acts on it", async () => {
      await engine.evaluate(createMockUser({ _id: 'id-1', departmentName: 'Engineering' }), 't', {
        forProvisioning: true,
      });

      const { aggregateId, payload } = emitted();
      expect(aggregateId).toBe('id-1');
      expect(payload).toEqual({
        identityId: 'id-1',
        matchedPolicies: [expect.any(String)],
        generatedOperations: 1,
        durationMs: expect.any(Number),
        forProvisioning: true,
      });
    });

    it('is not marked for a what-if evaluation', async () => {
      await engine.evaluate(createMockUser({ _id: 'id-1' }), 't');

      expect(emitted().payload).not.toHaveProperty('forProvisioning');
    });

    it('carries no identity id and no email for a profile without one', async () => {
      // A bulk row, the mover's policy profile
      await engine.evaluate(createMockUser({ _id: undefined }), 't');

      const { aggregateId, payload } = emitted();
      expect(aggregateId).toBe('policy-engine');
      expect(payload).not.toHaveProperty('identityId');
      expect(JSON.stringify(payload)).not.toContain('@');
    });
  });

  describe('evaluate', () => {
    it('should call policyService.findActive and evaluate', async () => {
      const user = createMockUser({ departmentName: 'Engineering' });
      const policy = createMockPolicy();
      jest
        .mocked(policyService.findActive)!
        .mockResolvedValue([policy] as unknown as PolicyDocument[]);

      const result = await engine.evaluate(user);
      expect(policyService.findActive).toHaveBeenCalledTimes(1);
      expect(result.operations).toHaveLength(1);
    });

    it('should return empty operations when no active policies', async () => {
      const user = createMockUser();
      jest.mocked(policyService.findActive)!.mockResolvedValue([]);

      const result = await engine.evaluate(user);
      expect(result.operations).toEqual([]);
    });

    it('should not throw when no SoD violations (two non-conflicting ops)', async () => {
      const user = createMockUser({ departmentName: 'Engineering' });
      const policy = createMockPolicy({
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'G1' } },
          { id: 'a2', type: 'assign_license', target: 'entra-id', params: { licenseSku: 'E3' } },
        ],
      });
      jest
        .mocked(policyService.findActive)!
        .mockResolvedValue([policy] as unknown as PolicyDocument[]);
      jest.mocked(sodService.validate)!.mockResolvedValue([]);

      const result = await engine.evaluate(user, TEST_TENANT_ID);
      expect(result.operations).toHaveLength(2);
      expect(result.sodWarnings).toBeUndefined();
    });

    it('should return sodValidation with passed=false when BLOCK violations detected', async () => {
      const user = createMockUser({ departmentName: 'Finance' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'Finance' }],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Payables' } },
          {
            id: 'a2',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'Receivables' },
          },
        ],
      });
      jest
        .mocked(policyService.findActive)!
        .mockResolvedValue([policy] as unknown as PolicyDocument[]);
      jest.mocked(sodService.validate)!.mockResolvedValue([
        {
          policyName: 'No Pay & Vendor',
          severity: 'HIGH',
          action: 'BLOCK',
          conflictingEntitlements: [
            { system: 'entra-id', type: 'group', targetId: 'Payables' },
            { system: 'entra-id', type: 'group', targetId: 'Receivables' },
          ],
        },
      ]);

      const result = await engine.evaluate(user, TEST_TENANT_ID);
      expect(result.sodValidation).toBeDefined();
      expect(result.sodValidation!.passed).toBe(false);
      expect(result.sodValidation!.blockers).toHaveLength(1);
      expect(result.sodValidation!.blockers[0].policyName).toBe('No Pay & Vendor');
    });

    it('should return sodWarnings when WARN violations (no throw)', async () => {
      const user = createMockUser({ departmentName: 'Finance' });
      const policy = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'Finance' }],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Payables' } },
          {
            id: 'a2',
            type: 'assign_group',
            target: 'entra-id',
            params: { groupName: 'Receivables' },
          },
        ],
      });
      jest
        .mocked(policyService.findActive)!
        .mockResolvedValue([policy] as unknown as PolicyDocument[]);
      jest.mocked(sodService.validate)!.mockResolvedValue([
        {
          policyName: 'No Pay & Vendor (Warn)',
          severity: 'MEDIUM',
          action: 'WARN',
          conflictingEntitlements: [
            { system: 'entra-id', type: 'group', targetId: 'Payables' },
            { system: 'entra-id', type: 'group', targetId: 'Receivables' },
          ],
        },
      ]);

      const result = await engine.evaluate(user, TEST_TENANT_ID);
      expect(result.operations).toHaveLength(2);
      expect(result.sodWarnings).toHaveLength(1);
      expect(result.sodWarnings![0].policyName).toBe('No Pay & Vendor (Warn)');
      expect(result.sodWarnings![0].action).toBe('WARN');
    });
  });

  /**
   * Entitlements EuroID gives to a linked admin account (PamFilterService moves them into
   * adminOperations) are checked against SoD policies and counted in the risk score's SoD factor,
   * with the real SodService over the policies a tenant stores.
   */
  describe('SoD covers admin-account entitlements', () => {
    const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
    let engineWithSod: PolicyEngineService;
    let storedPolicies: Array<Record<string, unknown>>;

    beforeEach(async () => {
      storedPolicies = [];
      const sodPolicyModel = {
        find: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(storedPolicies) })),
      };
      const catalog = {
        findForAdminRedirect: jest.fn(async (_tenantId: string, _system: string, id: string) =>
          id === GLOBAL_ADMIN ? { requiresAdminAccount: true, adminTier: 'TIER_0' } : null,
        ),
        // SoD resolves targets through the catalog; this one knows none, so each keeps its id
        loadTargetLookup: jest.fn(async () => () => undefined),
      };
      const module = await Test.createTestingModule({
        providers: [
          PolicyEngineService,
          PamFilterService,
          SodService,
          { provide: getModelToken(SodPolicy.name), useValue: sodPolicyModel },
          { provide: ReviewExclusionService, useValue: reviewExclusions },
          { provide: PolicyService, useValue: policyService },
          { provide: ROLE_BUNDLE_RESOLVER_PORT, useValue: roleBundlesService },
          { provide: IDENTITY_QUERY_PORT, useValue: { findAllPaginated: jest.fn() } },
          { provide: EntitlementCatalogService, useValue: catalog },
          { provide: LoggerFactoryService, useValue: createMockLoggerFactory().factory },
          { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
          { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: 'test-tenant' } },
        ],
      }).compile();
      engineWithSod = module.get(PolicyEngineService);

      const finance = createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'Finance' }],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Payables' } },
          {
            id: 'a2',
            type: 'assign_role',
            target: 'entra-id',
            params: { roleName: 'Global Administrator', roleTemplateId: GLOBAL_ADMIN },
          },
        ],
      });
      jest
        .mocked(policyService.findActive)!
        .mockResolvedValue([finance] as unknown as PolicyDocument[]);
    });

    const adminVersusPayables = (action: 'BLOCK' | 'WARN') => ({
      name: 'No admin approving payments',
      severity: 'HIGH',
      action,
      conflictingEntitlements: [
        { system: 'entra-id', type: 'role', targetId: GLOBAL_ADMIN },
        { system: 'entra-id', type: 'group', targetId: 'Payables' },
      ],
    });

    it('blocks when the conflicting entitlement goes to the linked admin account', async () => {
      storedPolicies.push(adminVersusPayables('BLOCK'));
      const user = createMockUser({ departmentName: 'Finance' });

      const intent = await engineWithSod.evaluate(user, TEST_TENANT_ID);

      expect(intent.adminOperations?.map((op) => op.targetId)).toEqual([GLOBAL_ADMIN]);
      expect(intent.sodValidation?.passed).toBe(false);
      expect(intent.sodValidation?.blockers.map((v) => v.policyName)).toEqual([
        'No admin approving payments',
      ]);
    });

    it('counts it in the risk score SoD factor', async () => {
      storedPolicies.push(adminVersusPayables('WARN'));
      const user = createMockUser({ departmentName: 'Finance' });

      const { sodViolationCount } = await engineWithSod.evaluateForRiskScoring(
        user,
        TEST_TENANT_ID,
      );

      expect(sodViolationCount).toBe(1);
    });

    it('does not count a conflicting entitlement an access review revoked', async () => {
      storedPolicies.push(adminVersusPayables('BLOCK'));
      reviewExclusions.activeForProfile.mockResolvedValue([payablesRevoked]);
      const user = createMockUser({ _id: 'id-1', departmentName: 'Finance' });

      const intent = await engineWithSod.evaluate(user, TEST_TENANT_ID);
      const { sodViolationCount } = await engineWithSod.evaluateForRiskScoring(
        user,
        TEST_TENANT_ID,
      );

      expect(intent.sodValidation?.passed).toBe(true);
      expect(sodViolationCount).toBe(0);
    });
  });

  /**
   * FOLLOWUPS 2026-11-23 (mover.handler.ts:42 with the policy engine): a review revoke of
   * policy-granted access did not stick; the next onboarding, mover run or re-evaluation granted
   * it again. Every intent now leaves out what an active access review exclusion revoked.
   */
  describe('access review exclusions', () => {
    const payablesPolicy = () =>
      createMockPolicy({
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'Finance' }],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'Payables' } },
          { id: 'a2', type: 'assign_group', target: 'entra-id', params: { groupName: 'Finance' } },
        ],
      });
    const user = () => createMockUser({ _id: 'id-1', departmentName: 'Finance' });
    const groups = (ops: Array<{ targetId: string }>) => ops.map((op) => op.targetId);

    beforeEach(() => {
      jest
        .mocked(policyService.findActive)!
        .mockResolvedValue([payablesPolicy()] as unknown as PolicyDocument[]);
      reviewExclusions.activeForProfile.mockResolvedValue([payablesRevoked]);
    });

    it('evaluate (onboarding, the policy trace) leaves the revoked group out', async () => {
      const intent = await engine.evaluate(user(), TEST_TENANT_ID, { forProvisioning: true });

      expect(groups(intent.operations)).toEqual(['Finance']);
      expect(intent.suppressedOperations).toEqual([
        expect.objectContaining({
          targetId: 'Payables',
          sourcePolicy: 'Test Policy',
          suppressedBy: {
            reason: 'Suppressed by access review',
            exclusionId: 'ex-1',
            campaignId: 'camp-1',
          },
        }),
      ]);
      expect(reviewExclusions.activeForProfile).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'id-1' }),
        TEST_TENANT_ID,
        undefined,
      );
    });

    it('asks for the exclusions lifted since the baseline on a "before" side', async () => {
      const since = new Date('2026-11-20T08:00:00.000Z');
      await engine.evaluate(user(), TEST_TENANT_ID, { reviewExclusionsLiftedSince: since });
      await engine.evaluateOperationsWithoutSod(user(), TEST_TENANT_ID, {
        reviewExclusionsLiftedSince: since,
      });

      expect(reviewExclusions.activeForProfile).toHaveBeenCalledTimes(2);
      for (const call of reviewExclusions.activeForProfile.mock.calls) {
        expect(call[2]).toBe(since);
      }
    });

    it('SoD is checked without it', async () => {
      await engine.evaluate(user(), TEST_TENANT_ID);

      const [, checked] = jest.mocked(sodService.validate)!.mock.calls[0];
      expect(groups(checked)).toEqual(['Finance']);
    });

    it('the mover, re-evaluation, access preview and risk scoring leave it out', async () => {
      const ops = await engine.evaluateOperationsWithoutSod(user(), TEST_TENANT_ID, {
        includeAdminOperations: true,
      });
      const { intent } = await engine.evaluateForRiskScoring(user(), TEST_TENANT_ID);

      expect(groups(ops)).toEqual(['Finance']);
      expect(groups(intent.operations)).toEqual(['Finance']);
    });

    it('grants it again once the exclusion is lifted', async () => {
      reviewExclusions.activeForProfile.mockResolvedValue([]);

      const intent = await engine.evaluate(user(), TEST_TENANT_ID);

      expect(groups(intent.operations)).toEqual(['Payables', 'Finance']);
      expect(intent).not.toHaveProperty('suppressedOperations');
    });

    it('evaluateWithPolicies (simulation, impact) stays the policies alone', async () => {
      const intent = await engine.evaluateWithPolicies(user(), [payablesPolicy()]);

      expect(groups(intent.operations)).toEqual(['Payables', 'Finance']);
      expect(reviewExclusions.activeForProfile).not.toHaveBeenCalled();
    });
  });
});

/** An active exclusion of the Entra ID group Payables (as ReviewExclusionService returns it). */
const payablesRevoked: ReviewExclusionMatch = {
  id: 'ex-1',
  campaignId: 'camp-1',
  systemKey: 'entraid',
  scope: 'entitlement',
  entitlementType: 'group',
  entitlementName: 'Payables',
  entitlementId: '0a9c6f0e-0000-4000-8000-00000000000a',
};
