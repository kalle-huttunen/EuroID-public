/**
 * Risk Scoring Service Unit Tests
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { RiskScoringService } from './risk-scoring.service';
import { IdentityService } from '../identity/identity.service';
import { PolicyEngineService } from '../policy/policy-engine.service';
import { AuditService } from '../audit/audit.service';
import { IdentityRiskScore } from './schemas/risk-score.schema';
import { Anomaly } from '../anomaly/schemas/anomaly.schema';
import { EntitlementCatalog } from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { riskScoringConfig } from '@infrastructure/config/risk-scoring.config';
import { IntelligenceService } from '../intelligence/intelligence.service';

describe('RiskScoringService', () => {
  let service: RiskScoringService;

  const createExecChain = (result: unknown) => ({
    exec: jest.fn().mockResolvedValue(result),
  });
  const mockRiskScoreModel = {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue(createExecChain([])),
        }),
      }),
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain([])),
      }),
    }),
    findOne: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue(createExecChain(null)),
    }),
    findOneAndUpdate: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({}),
    }),
    countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
  };

  const mockAnomalyModel = {
    countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
  };

  const mockCatalogModel = {
    find: jest.fn().mockReturnValue({
      countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
    }),
  };

  const mockIdentityModel = {
    findById: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    }),
  };

  const mockIdentityService = {
    findOne: jest.fn().mockResolvedValue(null),
    findUsersPageForReconciliation: jest.fn().mockResolvedValue({ users: [], total: 0 }),
  };

  const mockPolicyEngine = {
    evaluateForRiskScoring: jest.fn().mockResolvedValue({
      intent: { operations: [] },
      sodViolationCount: 0,
    }),
  };

  const mockAuditService = {
    query: jest.fn().mockResolvedValue({ total: 0 }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RiskScoringService,
        { provide: getModelToken(IdentityRiskScore.name), useValue: mockRiskScoreModel },
        { provide: getModelToken(Anomaly.name), useValue: mockAnomalyModel },
        { provide: getModelToken(EntitlementCatalog.name), useValue: mockCatalogModel },
        { provide: getModelToken('Identity'), useValue: mockIdentityModel },
        { provide: IdentityService, useValue: mockIdentityService },
        { provide: PolicyEngineService, useValue: mockPolicyEngine },
        { provide: AuditService, useValue: mockAuditService },
        {
          provide: IntelligenceService,
          useValue: { analyzeRisk: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: riskScoringConfig.KEY,
          useValue: {
            weightEntitlement: 10,
            weightHighRisk: 25,
            weightSod: 25,
            weightAnomaly: 15,
            weightAdmin: 15,
            weightDormant: 10,
            dormancyDays: 90,
            anomalyLookbackDays: 90,
          },
        },
      ],
    }).compile();

    service = module.get<RiskScoringService>(RiskScoringService);
    jest.clearAllMocks();
  });

  describe('getTopRisky', () => {
    it('should return empty array when no scores', async () => {
      const result = await service.getTopRisky('tenant-1', 10);
      expect(result).toEqual([]);
    });

    it('should filter by minScore when provided', async () => {
      const sortChain = {
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue(createExecChain([])),
        }),
      };
      mockRiskScoreModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue(sortChain),
      });
      await service.getTopRisky('tenant-1', 5, 50);
      expect(mockRiskScoreModel.find).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        score: { $gte: 50 },
      });
    });
  });

  describe('getDistribution', () => {
    it('should return buckets with zero counts when no data', async () => {
      mockRiskScoreModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });
      mockRiskScoreModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue(createExecChain([])),
        }),
      });
      const result = await service.getDistribution('tenant-1');
      expect(result.buckets).toHaveLength(5);
      expect(result.buckets.every((b) => b.range && typeof b.count === 'number')).toBe(true);
      expect(result.average).toBe(0);
      expect(result.median).toBe(0);
    });

    it('should compute average and median from scores', async () => {
      mockRiskScoreModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(1) });
      mockRiskScoreModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockReturnValue(createExecChain([{ score: 10 }, { score: 30 }, { score: 50 }])),
        }),
      });
      const result = await service.getDistribution('tenant-1');
      expect(result.average).toBe(30);
      expect(result.median).toBe(30);
    });
  });

  describe('getForIdentity', () => {
    it('should return null when no score found', async () => {
      const result = await service.getForIdentity('id-1');
      expect(result).toBeNull();
    });

    // Found, and in the request tenant only: risk-scoring.service.integration.spec.ts
  });

  describe('calculateForIdentity', () => {
    const NOW = new Date('2026-11-26T02:00:00Z');
    beforeEach(() => {
      mockIdentityService.findOne.mockResolvedValue({ _id: 'id-1', email: 'ada@corp.example' });
      mockIdentityModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockReturnValue(createExecChain({})) }),
      });
      mockAnomalyModel.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });
      mockRiskScoreModel.findOne.mockReturnValue({
        lean: jest.fn().mockReturnValue(createExecChain({ score: 80, history: [] })),
      });
    });

    // Hunt 05 F4: dismissed and resolved anomalies (and their re-created copies) raised the score
    it('counts only open and acknowledged anomalies of the lookback window', async () => {
      await service.calculateForIdentity('tenant-1', 'id-1', 1, NOW);

      expect(mockAnomalyModel.countDocuments).toHaveBeenCalledWith({
        identityId: 'id-1',
        tenantId: 'tenant-1',
        status: { $in: ['open', 'acknowledged'] },
        detectedAt: { $gte: expect.any(Date) },
      });
    });

    // Hunt 05 F18: a failed evaluation scored the identity as holding nothing, trend DECREASING
    it('writes no score when the policy evaluation fails, keeping the previous one', async () => {
      mockPolicyEngine.evaluateForRiskScoring.mockRejectedValueOnce(new Error('OPA down'));

      await expect(service.calculateForIdentity('tenant-1', 'id-1', 1, NOW)).rejects.toThrow(
        'OPA down',
      );
      expect(mockRiskScoreModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
