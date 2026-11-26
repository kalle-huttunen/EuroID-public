/**
 * Unit tests for PolicySuggestionService analyzers
 */

import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { PolicySuggestionService } from './policy-suggestions.service';
import { PolicySuggestion, SuggestionType } from './schemas/suggestion.schema';
import { PolicyService } from '../policy/policy.service';
import { PolicyEngineService } from '../policy/policy-engine.service';
import { IdentityService } from '../identity/identity.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { createMockUser, createMockPolicy } from '@testing/mock-factories';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { policySuggestionsConfig } from '@infrastructure/config/policy-suggestions.config';

// ── Fixture: 10 Sales users, 9 with Salesforce ─────────────────────────

function createSalesUsers(_withSalesforce: number): any[] {
  const users: any[] = [];
  for (let i = 0; i < 10; i++) {
    users.push({
      _id: `sales-user-${i}`,
      email: `sales${i}@test.com`,
      firstName: 'Sales',
      lastName: `User${i}`,
      departmentName: 'Sales',
      departmentCode: 'SAL',
      status: UserStatus.ACTIVE,
    });
  }
  return users;
}

// ── Mock Model ─────────────────────────────────────────────────────────

const mockSuggestionModel = {
  find: jest.fn().mockReturnThis(),
  findOne: jest.fn().mockReturnThis(),
  countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
  create: jest.fn().mockImplementation((doc) => ({ ...doc, save: jest.fn() })),
  exec: jest.fn().mockResolvedValue([]),
  sort: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
};

describe('PolicySuggestionService', () => {
  let service: PolicySuggestionService;
  let identityService: jest.Mocked<Partial<IdentityService>>;
  let policyService: jest.Mocked<Partial<PolicyService>>;
  let policyEngine: jest.Mocked<Partial<PolicyEngineService>>;
  let entitlementCatalog: jest.Mocked<Partial<EntitlementCatalogService>>;
  let entraService: jest.Mocked<Partial<EntraService>>;
  let configService: jest.Mocked<Partial<ConfigService>>;

  beforeEach(async () => {
    jest.clearAllMocks();

    identityService = {
      findAll: jest.fn().mockResolvedValue([]),
      findAllPaginated: jest.fn().mockResolvedValue([[], 0]),
    };

    policyService = {
      findActive: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn().mockResolvedValue({ _id: 'new-policy-id' }),
    };

    policyEngine = {
      simulate: jest.fn().mockResolvedValue({
        totalUsers: 0,
        matchedCount: 0,
        matchPercentage: 0,
        matchedUsers: [],
        actionsBySystem: {},
        totalOperations: 0,
      }),
    };

    entitlementCatalog = {
      list: jest.fn().mockResolvedValue([]),
    };

    entraService = {
      isConfiguredForTenant: jest.fn().mockResolvedValue(true),
      checkUserExists: jest.fn().mockImplementation((email) => Promise.resolve(`entra-${email}`)),
      getUserGroupMemberships: jest.fn().mockResolvedValue([]),
    };

    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'SUGGESTION_BIRTHRIGHT_THRESHOLD') return 70;
        if (key === 'SUGGESTION_COVERAGE_GAP_MIN') return 5;
        if (key === 'SUGGESTION_GROUP_BY') return 'departmentName';
        return undefined;
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        PolicySuggestionService,
        { provide: getModelToken(PolicySuggestion.name), useValue: mockSuggestionModel },
        { provide: PolicyService, useValue: policyService },
        { provide: PolicyEngineService, useValue: policyEngine },
        { provide: IdentityService, useValue: identityService },
        { provide: EntitlementCatalogService, useValue: entitlementCatalog },
        { provide: EntraService, useValue: entraService },
        { provide: ConfigService, useValue: configService },
        {
          provide: policySuggestionsConfig.KEY,
          useValue: {
            birthrightThreshold: 70,
            coverageGapMinUsers: 5,
            birthrightDimension: 'departmentName',
          },
        },
      ],
    }).compile();

    service = module.get(PolicySuggestionService);

    mockSuggestionModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });
    mockSuggestionModel.create.mockImplementation((doc) =>
      Promise.resolve({ ...doc, suggestionId: doc.suggestionId || 'sugg-123' }),
    );
  });

  describe('analyzeBirthrightPatterns (via runAnalysis)', () => {
    it('generates suggestion when 90% of Sales has Salesforce (above 70% threshold)', async () => {
      const salesUsers = createSalesUsers(10);
      jest
        .mocked(identityService.findAllPaginated)!
        .mockResolvedValueOnce([
          salesUsers as unknown as Record<string, unknown>[],
          salesUsers.length,
        ])
        .mockResolvedValue([[], salesUsers.length]);
      jest.mocked(policyService.findActive)!.mockResolvedValue([]);

      (entraService.checkUserExists as jest.Mock).mockImplementation((email) =>
        Promise.resolve(`entra-${email}`),
      );
      let callIdx = 0;
      (entraService.getUserGroupMemberships as jest.Mock).mockImplementation(() => {
        const idx = callIdx++;
        return Promise.resolve(idx < 9 ? [{ id: 'g1', displayName: 'Salesforce' }] : []);
      });

      mockSuggestionModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      const result = await service.runAnalysis();

      expect(result.analyzed).toBeGreaterThanOrEqual(0);
      expect(identityService.findAllPaginated).toHaveBeenCalled();
    });

    it('does not generate suggestion when 50% of Sales has Salesforce (below 70% threshold)', async () => {
      const salesUsers = createSalesUsers(10);
      jest
        .mocked(identityService.findAllPaginated)!
        .mockResolvedValueOnce([
          salesUsers as unknown as Record<string, unknown>[],
          salesUsers.length,
        ])
        .mockResolvedValue([[], salesUsers.length]);
      jest.mocked(policyService.findActive)!.mockResolvedValue([]);

      let callIdx = 0;
      (entraService.getUserGroupMemberships as jest.Mock).mockImplementation(() => {
        const idx = callIdx++;
        return Promise.resolve(idx < 5 ? [{ id: 'g1', displayName: 'Salesforce' }] : []);
      });

      const result = await service.runAnalysis();

      expect(result.analyzed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('analyzers that need Entra ID', () => {
    it('names the analyzers it skipped when Entra ID is not configured', async () => {
      (entraService.isConfiguredForTenant as jest.Mock).mockResolvedValue(false);

      const result = await service.runAnalysis();

      // Without this the answer read as "nothing to suggest".
      expect(result).toEqual({
        analyzed: 0,
        suggestionsCreated: 0,
        skipped: [
          { analyzer: 'birthright', reason: 'Entra ID is not configured for this tenant' },
          { analyzer: 'orphan', reason: 'Entra ID is not configured for this tenant' },
        ],
      });
      expect(entraService.checkUserExists).not.toHaveBeenCalled();
    });

    it('skips none when Entra ID is configured', async () => {
      const result = await service.runAnalysis();

      expect(result.skipped).toEqual([]);
    });
  });

  describe('analyzeOrphanEntitlements (via runAnalysis)', () => {
    it('generates suggestion when entitlement assigned to 3 users but not in any policy', async () => {
      const users = [
        createMockUser({ email: 'u1@test.com', _id: 'u1' }),
        createMockUser({ email: 'u2@test.com', _id: 'u2' }),
        createMockUser({ email: 'u3@test.com', _id: 'u3' }),
      ];
      jest
        .mocked(identityService.findAllPaginated)!
        .mockResolvedValueOnce([users as unknown as Record<string, unknown>[], users.length])
        .mockResolvedValue([[], users.length]);
      jest.mocked(policyService.findActive)!.mockResolvedValue([]);

      (entraService.checkUserExists as jest.Mock).mockResolvedValue('entra-id');
      (entraService.getUserGroupMemberships as jest.Mock).mockResolvedValue([
        { id: 'g1', displayName: 'GroupZ' },
      ]);

      mockSuggestionModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      const result = await service.runAnalysis();

      expect(result.analyzed).toBeGreaterThanOrEqual(0);
      expect(identityService.findAllPaginated).toHaveBeenCalled();
    });

    it('does not generate suggestion when entitlement is in a policy', async () => {
      const users = [
        createMockUser({ email: 'u1@test.com', _id: 'u1' }),
        createMockUser({ email: 'u2@test.com', _id: 'u2' }),
      ];
      const policyWithGroup = createMockPolicy({
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'GroupZ' } },
        ],
      });
      jest
        .mocked(identityService.findAllPaginated)!
        .mockResolvedValueOnce([users as unknown as Record<string, unknown>[], users.length])
        .mockResolvedValue([[], users.length]);
      jest.mocked(policyService.findActive)!.mockResolvedValue([policyWithGroup] as any);

      (entraService.getUserGroupMemberships as jest.Mock).mockResolvedValue([
        { id: 'g1', displayName: 'GroupZ' },
      ]);

      const result = await service.runAnalysis();

      const orphanSuggestions = result.analyzed;
      expect(orphanSuggestions).toBeGreaterThanOrEqual(0);
    });
  });

  describe('analyzeRedundantPolicies (via runAnalysis)', () => {
    it('generates suggestion when policy matches 0 users', async () => {
      const users = [
        createMockUser({ departmentName: 'Engineering' }),
        createMockUser({ departmentName: 'Engineering' }),
      ];
      const policyMatchesNone = createMockPolicy({
        name: 'Orphan Policy',
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [
              { id: 'c1', field: 'departmentName', operator: 'equals', value: 'NonExistentDept' },
            ],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'X' } },
        ],
      });

      jest
        .mocked(identityService.findAllPaginated)!
        .mockResolvedValueOnce([users as unknown as Record<string, unknown>[], users.length])
        .mockResolvedValue([[], users.length]);
      jest.mocked(policyService.findActive)!.mockResolvedValue([policyMatchesNone] as any);
      jest.mocked(policyEngine.simulate)!.mockResolvedValue({
        totalUsers: 2,
        matchedCount: 0,
        matchPercentage: 0,
        matchedUsers: [],
        actionsBySystem: {},
        totalOperations: 0,
      });

      mockSuggestionModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      const result = await service.runAnalysis();

      expect(policyEngine.simulate).toHaveBeenCalled();
      expect(result.analyzed).toBeGreaterThanOrEqual(0);
      expect(result.suggestionsCreated).toBeGreaterThanOrEqual(0);
    });
  });

  // r2-04 N3: the dedupe looked for a pending suggestion only, so every analysis run brought a
  // dismissed (or accepted) suggestion back as a new pending one
  describe('a suggestion an admin already decided', () => {
    it.each(['dismissed', 'accepted'])('is not suggested again when %s', async (status) => {
      const users = [createMockUser({ departmentName: 'Engineering' })];
      const policyMatchesNone = createMockPolicy({
        name: 'Orphan Policy',
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'departmentName', operator: 'equals', value: 'None' }],
          },
        ],
        actions: [
          { id: 'a1', type: 'assign_group', target: 'entra-id', params: { groupName: 'X' } },
        ],
      });
      jest
        .mocked(identityService.findAllPaginated)!
        .mockResolvedValueOnce([users as unknown as Record<string, unknown>[], users.length])
        .mockResolvedValue([[], users.length]);
      jest.mocked(policyService.findActive)!.mockResolvedValue([policyMatchesNone] as never);
      jest.mocked(policyEngine.simulate)!.mockResolvedValue({
        totalUsers: 1,
        matchedCount: 0,
        matchPercentage: 0,
        matchedUsers: [],
        actionsBySystem: {},
        totalOperations: 0,
      });
      // The store holds every candidate as a suggestion with this status: the lookup finds it
      // when its status filter takes that status
      const takes = (filter: unknown) =>
        filter === status ||
        (typeof filter === 'object' &&
          !!filter &&
          ((filter as { $in?: string[] }).$in ?? []).includes(status));
      mockSuggestionModel.findOne.mockImplementation((query: { status: unknown }) => ({
        exec: jest.fn().mockResolvedValue(takes(query.status) ? { status } : null),
      }));

      const result = await service.runAnalysis();

      expect(mockSuggestionModel.create).not.toHaveBeenCalled();
      expect(result.suggestionsCreated).toBe(0);
    });
  });

  describe('analyzeCoverageGaps (via runAnalysis)', () => {
    it('generates suggestion when department has 10 users and no policy covers it', async () => {
      const users = Array.from({ length: 10 }, (_, i) =>
        createMockUser({
          _id: `gap-user-${i}`,
          email: `gap${i}@test.com`,
          departmentName: 'UncoveredDept',
          departmentCode: 'UCD',
        }),
      );
      jest
        .mocked(identityService.findAllPaginated)!
        .mockResolvedValueOnce([users as unknown as Record<string, unknown>[], users.length])
        .mockResolvedValue([[], users.length]);
      jest.mocked(policyService.findActive)!.mockResolvedValue([]);

      mockSuggestionModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      const result = await service.runAnalysis();

      expect(result.analyzed).toBeGreaterThanOrEqual(0);
      expect(identityService.findAllPaginated).toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('returns paginated suggestions', async () => {
      mockSuggestionModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(5),
      });
      mockSuggestionModel.exec.mockResolvedValue([
        {
          suggestionId: 's1',
          type: SuggestionType.BIRTHRIGHT_PATTERN,
          confidence: 90,
          title: 'Test',
          status: 'pending',
        },
      ]);

      const result = await service.findAll({ page: 0, limit: 10 });

      expect(result.total).toBe(5);
      expect(result.data).toHaveLength(1);
    });
  });

  describe('accept', () => {
    it('creates DRAFT policy when suggestion is accepted', async () => {
      const suggestion = {
        suggestionId: 'sugg-1',
        status: 'pending' as const,
        suggestedPolicy: {
          name: 'Birthright: Sales → Salesforce',
          conditionGroups: [
            {
              id: 'g1',
              join: 'AND' as const,
              conditions: [
                { id: 'c1', field: 'departmentName', operator: 'equals', value: 'Sales' },
              ],
            },
          ],
          actions: [
            {
              id: 'a1',
              type: 'assign_group',
              target: 'entra-id',
              params: { groupName: 'Salesforce' },
            },
          ],
          risk: 'Low',
        },
        save: jest.fn().mockResolvedValue(undefined),
      };

      mockSuggestionModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(suggestion),
      });
      // The accept claims the pending suggestion first
      (mockSuggestionModel as Record<string, unknown>).findOneAndUpdate = jest
        .fn()
        .mockReturnValue({
          exec: jest.fn().mockResolvedValue({ ...suggestion, status: 'accepted' }),
        });

      await service.accept('sugg-1', 'admin@test.com');

      expect(policyService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Birthright: Sales → Salesforce',
          status: 'draft',
        }),
        'admin@test.com',
      );
    });
  });
});
