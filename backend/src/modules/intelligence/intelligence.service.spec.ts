/**
 * Intelligence Service Unit Tests
 *
 * Tests for F-12 (rubber-stamp detection), F-13 (peer group deviation),
 * and F-14 (smart recommendations).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { IntelligenceService } from './intelligence.service';
import { ReviewerQualityScore } from './schemas/reviewer-quality-score.schema';
import { PeerGroup } from './schemas/peer-group.schema';
import { ReviewItem } from '../access-review/schemas/review-item.schema';
import { ReviewCampaign } from '../access-review/schemas/review-campaign.schema';
import { Identity } from '../identity/schemas/identity.schema';
import { EntitlementCatalog } from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { HeldAccessService, type HeldGrant } from './held-access.service';
import { intelligenceConfig } from '@infrastructure/config/intelligence.config';

describe('IntelligenceService', () => {
  let service: IntelligenceService;

  // Helper: create a chainable mock for Mongoose queries
  const createExecChain = (result: unknown) => ({
    exec: jest.fn().mockResolvedValue(result),
  });

  /** A query whose result is read with lean(); sort() may come first. */
  const createLeanExecChain = (result: unknown) => {
    const chain = {
      lean: jest.fn().mockReturnValue(createExecChain(result)),
      sort: jest.fn(),
    };
    chain.sort.mockReturnValue(chain);
    return chain;
  };

  const mockQualityModel: Record<string, jest.Mock> = {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue(createLeanExecChain([])),
        }),
      }),
    }),
    findOne: jest.fn().mockReturnValue(createLeanExecChain(null)),
    findOneAndUpdate: jest.fn().mockResolvedValue({}),
    countDocuments: jest.fn().mockReturnValue(createExecChain(0)),
    exists: jest.fn().mockResolvedValue(null),
  };

  const mockPeerGroupModel: Record<string, jest.Mock> = {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue(createLeanExecChain([])),
        }),
      }),
      lean: jest.fn().mockReturnValue(createExecChain([])),
    }),
    findOne: jest.fn().mockReturnValue(createLeanExecChain(null)),
    findOneAndUpdate: jest.fn().mockResolvedValue({}),
    countDocuments: jest.fn().mockReturnValue(createExecChain(0)),
  };

  const mockReviewItemModel: Record<string, jest.Mock> = {
    find: jest.fn().mockReturnValue(createLeanExecChain([])),
  };

  const mockCampaignModel: Record<string, jest.Mock> = {
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue(createLeanExecChain([])),
    }),
  };

  const mockIdentityModel: Record<string, jest.Mock> = {
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue(createLeanExecChain([])),
    }),
  };

  const mockCatalogModel: Record<string, jest.Mock> = {
    findOne: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue(createLeanExecChain(null)),
    }),
  };

  const mockHeldAccess = {
    grantsByIdentity: jest.fn().mockResolvedValue(new Map()),
  };

  const defaultConfig = {
    rubberStampThresholdMs: 30000,
    bulkApproveWindowCount: 10,
    peerGroupMinSize: 3,
    outlierHoldRate: 0.2,
    missingBaselineRate: 0.8,
    recommendationHoldRate: 0.7,
    unusualRequestThreshold: 0.05,
    recommendationMax: 10,
  };

  /** Every provider but the config. */
  const providers = [
    IntelligenceService,
    { provide: getModelToken(ReviewerQualityScore.name), useValue: mockQualityModel },
    { provide: getModelToken(PeerGroup.name), useValue: mockPeerGroupModel },
    { provide: getModelToken(ReviewItem.name), useValue: mockReviewItemModel },
    { provide: getModelToken(ReviewCampaign.name), useValue: mockCampaignModel },
    { provide: getModelToken(Identity.name), useValue: mockIdentityModel },
    { provide: getModelToken(EntitlementCatalog.name), useValue: mockCatalogModel },
    { provide: HeldAccessService, useValue: mockHeldAccess },
  ];

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [...providers, { provide: intelligenceConfig.KEY, useValue: defaultConfig }],
    }).compile();

    service = module.get<IntelligenceService>(IntelligenceService);
  });

  // ── F-12: Rubber-Stamp Detection ────────────────────────────────────

  describe('F-12: scoreCampaign', () => {
    it('should return empty array when no decided items', async () => {
      mockReviewItemModel.find.mockReturnValue(createLeanExecChain([]));
      const result = await service.scoreCampaign('t1', 'c1');
      expect(result).toEqual([]);
    });

    it('should score a fast approver with worst quality (0)', async () => {
      const now = new Date();
      const items = Array.from({ length: 20 }, (_, i) => ({
        itemId: `item-${i}`,
        campaignId: 'c1',
        reviewerId: 'reviewer1',
        decidedBy: 'reviewer1',
        decision: 'approved',
        justification: '',
        decidedAt: new Date(now.getTime() + i * 1000), // 1s apart
        createdAt: new Date(now.getTime() + i * 1000 - 5000), // 5s decision time
      }));

      mockReviewItemModel.find.mockReturnValue(createLeanExecChain(items));
      mockQualityModel.findOneAndUpdate.mockResolvedValue({
        qualityScore: 0,
        signals: {
          approvalRate: 1,
          avgDecisionTimeSeconds: 5,
          bulkApproveCount: 1,
          noJustificationRate: 1,
        },
        flaggedDecisions: items.map((i) => i.itemId),
      });

      const result = await service.scoreCampaign('t1', 'c1');
      expect(result).toHaveLength(1);

      // Verify the upsert was called with correct quality score
      const upsertCall = mockQualityModel.findOneAndUpdate.mock.calls[0];
      expect(upsertCall[0]).toEqual({ tenantId: 't1', reviewerId: 'reviewer1', campaignId: 'c1' });
      const setData = upsertCall[1].$set;
      // 100% approval (>0.95: -30), 5s avg (<30s: -25), bulk (>0: -20), 100% no justification (>0.5: -25) = 0
      expect(setData.qualityScore).toBe(0);
    });

    it('should score a deliberate reviewer with best quality (100)', async () => {
      const now = new Date();
      const items = [
        {
          itemId: 'item-1',
          campaignId: 'c1',
          reviewerId: 'reviewer1',
          decidedBy: 'reviewer1',
          decision: 'approved',
          justification: 'Verified role requirements match',
          decidedAt: new Date(now.getTime() + 120000), // 2 min decision
          createdAt: now,
        },
        {
          itemId: 'item-2',
          campaignId: 'c1',
          reviewerId: 'reviewer1',
          decidedBy: 'reviewer1',
          decision: 'revoked',
          justification: 'Access no longer needed',
          decidedAt: new Date(now.getTime() + 180000),
          createdAt: now,
        },
        {
          itemId: 'item-3',
          campaignId: 'c1',
          reviewerId: 'reviewer1',
          decidedBy: 'reviewer1',
          decision: 'approved',
          justification: 'Confirmed with manager',
          decidedAt: new Date(now.getTime() + 300000),
          createdAt: now,
        },
      ];

      mockReviewItemModel.find.mockReturnValue(createLeanExecChain(items));
      mockQualityModel.findOneAndUpdate.mockResolvedValue({ qualityScore: 100 });

      await service.scoreCampaign('t1', 'c1');

      const setData = mockQualityModel.findOneAndUpdate.mock.calls[0][1].$set;
      // 66% approval (not >0.95), avg 200s (not <30s), no bulk, 0% no-justification
      expect(setData.qualityScore).toBe(100);
      expect(setData.signals.approvalRate).toBeCloseTo(0.667, 2);
      expect(setData.flaggedDecisions).toEqual([]);
    });

    it('should flag decisions with no justification and fast decision time', async () => {
      const now = new Date();
      const items = [
        {
          itemId: 'item-flagged',
          campaignId: 'c1',
          reviewerId: 'r1',
          decidedBy: 'r1',
          decision: 'approved',
          justification: '',
          decidedAt: new Date(now.getTime() + 10000), // 10s
          createdAt: now,
        },
        {
          itemId: 'item-ok',
          campaignId: 'c1',
          reviewerId: 'r1',
          decidedBy: 'r1',
          decision: 'approved',
          justification: 'Checked',
          decidedAt: new Date(now.getTime() + 60000), // 60s
          createdAt: now,
        },
      ];

      mockReviewItemModel.find.mockReturnValue(createLeanExecChain(items));
      mockQualityModel.findOneAndUpdate.mockResolvedValue({});

      await service.scoreCampaign('t1', 'c1');

      const setData = mockQualityModel.findOneAndUpdate.mock.calls[0][1].$set;
      expect(setData.flaggedDecisions).toContain('item-flagged');
      expect(setData.flaggedDecisions).not.toContain('item-ok');
    });

    describe('decision time threshold (INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS)', () => {
      /** Two justified decisions (one approval, one revoke), 45 s each: only speed can cost points. */
      const scoreAt45s = async (rubberStampThresholdMs: number) => {
        const now = new Date();
        const decided = (itemId: string, decision: string) => ({
          itemId,
          campaignId: 'c1',
          reviewerId: 'r1',
          decidedBy: 'r1',
          decision,
          justification: 'Checked with the manager',
          decidedAt: new Date(now.getTime() + 45_000),
          createdAt: now,
        });
        mockReviewItemModel.find.mockReturnValue(
          createLeanExecChain([decided('i1', 'approved'), decided('i2', 'revoked')]),
        );
        const moduleRef = await Test.createTestingModule({
          providers: [
            ...providers,
            {
              provide: intelligenceConfig.KEY,
              useValue: { ...defaultConfig, rubberStampThresholdMs },
            },
          ],
        }).compile();
        await moduleRef.get(IntelligenceService).scoreCampaign('t1', 'c1');
        const calls = mockQualityModel.findOneAndUpdate.mock.calls;
        return calls[calls.length - 1][1].$set;
      };

      it('costs 25 points when the average is under the configured threshold', async () => {
        const set = await scoreAt45s(60_000);
        expect(set.qualityScore).toBe(75);
        expect(set.decisionTimeThresholdSeconds).toBe(60);
      });

      it('costs nothing at the default 30 s', async () => {
        const set = await scoreAt45s(30_000);
        expect(set.qualityScore).toBe(100);
        expect(set.decisionTimeThresholdSeconds).toBe(30);
      });
    });

    describe('bulk approval window (INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT)', () => {
      /**
       * Four justified approvals 10 s apart and one revoke, each decided in 45 s: only bulk
       * approving can cost points.
       */
      const scoreFourApprovals = async (bulkApproveWindowCount: number) => {
        const start = new Date('2026-11-25T08:00:00Z').getTime();
        const decided = (itemId: string, decision: string, at: number) => ({
          itemId,
          campaignId: 'c1',
          reviewerId: 'r1',
          decidedBy: 'r1',
          decision,
          justification: 'Checked with the manager',
          decidedAt: new Date(at),
          createdAt: new Date(at - 45_000),
        });
        mockReviewItemModel.find.mockReturnValue(
          createLeanExecChain([
            ...[0, 1, 2, 3].map((i) => decided(`a${i}`, 'approved', start + i * 10_000)),
            decided('r1', 'revoked', start + 3_600_000),
          ]),
        );
        const moduleRef = await Test.createTestingModule({
          providers: [
            ...providers,
            {
              provide: intelligenceConfig.KEY,
              useValue: { ...defaultConfig, bulkApproveWindowCount },
            },
          ],
        }).compile();
        await moduleRef.get(IntelligenceService).scoreCampaign('t1', 'c1');
        const calls = mockQualityModel.findOneAndUpdate.mock.calls;
        return calls[calls.length - 1][1].$set;
      };

      it('counts the configured number of approvals within 5 minutes and stores that rule', async () => {
        const set = await scoreFourApprovals(4);
        expect(set.signals.bulkApproveCount).toBe(1);
        expect(set.qualityScore).toBe(80);
        expect(set.bulkApproveWindowCount).toBe(4);
        expect(set.bulkApproveWindowMinutes).toBe(5);
      });

      it('stores the default rule, 10 approvals within 5 minutes, with the score', async () => {
        const set = await scoreFourApprovals(10);
        expect(set.signals.bulkApproveCount).toBe(0);
        expect(set.qualityScore).toBe(100);
        expect(set.bulkApproveWindowCount).toBe(10);
        expect(set.bulkApproveWindowMinutes).toBe(5);
      });
    });
  });

  // ── F-13: Peer Group Deviation Scoring ──────────────────────────────

  describe('F-13: getPeerDeviationScore', () => {
    it('should return 0 when no peer group found', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(createLeanExecChain(null));
      const score = await service.getPeerDeviationScore('t1', 'identity1');
      expect(score).toBe(0);
    });

    it('should return 0 when identity is not an outlier', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(
        createLeanExecChain({
          groupKey: 'g1',
          outliers: [{ identityId: 'other', deviationScore: 50 }],
        }),
      );

      const score = await service.getPeerDeviationScore('t1', 'identity1');
      expect(score).toBe(0);
    });

    it('should return deviation score when identity is an outlier', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(
        createLeanExecChain({
          groupKey: 'g1',
          outliers: [{ identityId: 'identity1', deviationScore: 75 }],
        }),
      );

      const score = await service.getPeerDeviationScore('t1', 'identity1');
      expect(score).toBe(75);
    });
  });

  describe('F-13: getGroupOutliers', () => {
    it('should return empty when no group found', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(createLeanExecChain(null));
      const result = await service.getGroupOutliers('t1', 'nonexistent');
      expect(result).toEqual([]);
    });

    it('should return outliers sorted by deviation score', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(
        createLeanExecChain({
          groupKey: 'g1',
          outliers: [
            { identityId: 'a', deviationScore: 30, uniqueEntitlements: [], missingBaseline: [] },
            {
              identityId: 'b',
              deviationScore: 80,
              uniqueEntitlements: ['ent1'],
              missingBaseline: [],
            },
          ],
        }),
      );

      const result = await service.getGroupOutliers('t1', 'g1');
      expect(result).toHaveLength(2);
    });
  });

  // ── F-14: Smart Recommendations ─────────────────────────────────────

  describe('F-14: getUnusualRequestWarning', () => {
    it('should return null when no peer group', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(createLeanExecChain(null));
      const result = await service.getUnusualRequestWarning('t1', 'id1', 'ent1');
      expect(result).toBeNull();
    });

    it('should return CRITICAL when entitlement not in group distribution', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(
        createLeanExecChain({
          entitlementBaseline: [{ entitlementId: 'other', holdRate: 0.9 }],
        }),
      );

      const result = await service.getUnusualRequestWarning('t1', 'id1', 'unknown-ent');
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('CRITICAL');
    });

    it('should return CRITICAL when entitlement held by < 5% of peers', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(
        createLeanExecChain({
          entitlementBaseline: [{ entitlementId: 'rare-ent', holdRate: 0.02 }],
        }),
      );

      const result = await service.getUnusualRequestWarning('t1', 'id1', 'rare-ent');
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('CRITICAL');
    });

    it('should return WARNING when entitlement held by < 20% of peers', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(
        createLeanExecChain({
          entitlementBaseline: [{ entitlementId: 'uncommon-ent', holdRate: 0.12 }],
        }),
      );

      const result = await service.getUnusualRequestWarning('t1', 'id1', 'uncommon-ent');
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('WARNING');
    });

    it('should return null when entitlement is common (> 20%)', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(
        createLeanExecChain({
          entitlementBaseline: [{ entitlementId: 'common-ent', holdRate: 0.85 }],
        }),
      );

      const result = await service.getUnusualRequestWarning('t1', 'id1', 'common-ent');
      expect(result).toBeNull();
    });
  });

  describe('F-14: getRecommendations', () => {
    it('should return empty when no peer group', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(createLeanExecChain(null));
      const result = await service.getRecommendations('t1', 'id1');
      expect(result).toEqual([]);
    });

    it('recommends what most peers hold and the identity does not, most held first', async () => {
      const entitlement = (name: string, holdRate: number) => ({
        entitlementId: `entra-id::${name}`,
        system: 'entra-id',
        name,
        holdRate,
        grantedBy: ['policy'],
      });
      mockPeerGroupModel.findOne.mockReturnValue(
        createLeanExecChain({
          entitlementBaseline: [
            entitlement('VPN', 0.8),
            entitlement('E3', 0.9), // held already
            entitlement('Finance-Read', 0.95),
            entitlement('Rare', 0.3), // below the 0.7 hold rate
          ],
        }),
      );
      const held: HeldGrant = {
        entitlementId: 'entra-id::E3',
        system: 'entra-id',
        name: 'E3',
        grantedBy: 'policy',
        status: 'Active',
      };
      // VPN was revoked from the identity: it does not have it.
      const revoked: HeldGrant = { ...held, entitlementId: 'entra-id::VPN', status: 'Revoked' };
      mockHeldAccess.grantsByIdentity.mockResolvedValueOnce(new Map([['id1', [held, revoked]]]));
      mockCatalogModel.findOne.mockImplementation((filter: { $or: Array<{ name?: string }> }) => ({
        select: jest
          .fn()
          .mockReturnValue(
            createLeanExecChain(
              filter.$or.some((c) => c.name === 'Finance-Read')
                ? { riskLevel: 'HIGH', requestable: true }
                : null,
            ),
          ),
      }));

      const result = await service.getRecommendations('t1', 'id1');

      expect(result).toEqual([
        { ...entitlement('Finance-Read', 0.95), riskLevel: 'HIGH', requestable: true },
        { ...entitlement('VPN', 0.8), riskLevel: undefined, requestable: false },
      ]);
      expect(mockPeerGroupModel.findOne).toHaveBeenCalledWith({ tenantId: 't1', memberIds: 'id1' });
      expect(mockHeldAccess.grantsByIdentity).toHaveBeenCalledWith('t1', ['id1']);
    });

    it('recommends nothing when the identity’s access cannot be resolved', async () => {
      mockPeerGroupModel.findOne.mockReturnValue(
        createLeanExecChain({
          entitlementBaseline: [
            { entitlementId: 'entra-id::VPN', system: 'entra-id', holdRate: 1 },
          ],
        }),
      );
      mockHeldAccess.grantsByIdentity.mockResolvedValueOnce(new Map());

      expect(await service.getRecommendations('t1', 'id1')).toEqual([]);
    });
  });

  // ── Unscored campaigns ─────────────────────────────────────────────

  describe('getUnscoredCampaigns', () => {
    it('should return campaigns with no quality scores', async () => {
      mockCampaignModel.find.mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue(
            createLeanExecChain([{ campaignId: 'scored' }, { campaignId: 'unscored' }]),
          ),
      });

      // First call (scored) → exists, second (unscored) → null
      mockQualityModel.exists
        .mockResolvedValueOnce({ _id: 'something' })
        .mockResolvedValueOnce(null);

      const result = await service.getUnscoredCampaigns('t1');
      expect(result).toEqual(['unscored']);
    });
  });
});
