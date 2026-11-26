/**
 * Predictive Analytics Service Unit Tests
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { PredictiveAnalyticsService } from './analytics.service';
import { UpcomingOffboarding } from './schemas/upcoming-offboarding.schema';
import { EntitlementCatalog } from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { AuditEvent } from '../audit/schemas/audit-event.schema';
import { Identity } from '../identity/schemas/identity.schema';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { IdentityService } from '../identity/identity.service';
import { PolicyEngineService } from '../policy/policy-engine.service';

describe('PredictiveAnalyticsService', () => {
  let service: PredictiveAnalyticsService;

  const mockOffboardingModel = {
    find: jest.fn().mockReturnThis(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateMany: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
  };

  const mockCatalogModel = {
    find: jest.fn().mockReturnThis(),
    findOne: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn(),
  };

  const mockAuditModel = {
    find: jest.fn().mockReturnThis(),
    aggregate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn(),
  };

  const mockIdentityModel = {
    find: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn(),
  };

  const mockIdentityService = {
    findById: jest.fn(),
  };

  const mockPolicyEngine = {
    evaluate: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PredictiveAnalyticsService,
        { provide: getModelToken(UpcomingOffboarding.name), useValue: mockOffboardingModel },
        { provide: getModelToken(EntitlementCatalog.name), useValue: mockCatalogModel },
        { provide: getModelToken(AuditEvent.name), useValue: mockAuditModel },
        { provide: getModelToken(Identity.name), useValue: mockIdentityModel },
        { provide: IdentityService, useValue: mockIdentityService },
        { provide: PolicyEngineService, useValue: mockPolicyEngine },
        { provide: ConfigService, useValue: mockConfigService },
        {
          provide: LoggerFactoryService,
          useValue: { create: () => ({ log: jest.fn(), warn: jest.fn(), debug: jest.fn() }) },
        },
      ],
    }).compile();

    service = module.get<PredictiveAnalyticsService>(PredictiveAnalyticsService);
  });

  describe('preComputeUpcomingOffboardings', () => {
    it('should pre-compute offboardings for users with endDate within daysAhead', async () => {
      const now = new Date();
      const endDate1 = new Date(now);
      endDate1.setDate(endDate1.getDate() + 10);
      const endDate2 = new Date(now);
      endDate2.setDate(endDate2.getDate() + 60);

      mockIdentityModel.exec.mockResolvedValue([
        {
          _id: 'id1',
          profile: {
            email: 'user1@test.com',
            firstName: 'User',
            lastName: 'One',
            endDate: endDate1,
            sourceSystem: 'hr',
            sourceUserId: 'u1',
            tenantId: 'default',
          },
        },
        {
          _id: 'id2',
          profile: {
            email: 'user2@test.com',
            firstName: 'User',
            lastName: 'Two',
            endDate: endDate2,
            sourceSystem: 'hr',
            sourceUserId: 'u2',
            tenantId: 'default',
          },
        },
      ]);

      mockPolicyEngine.evaluate.mockResolvedValue({
        operations: [
          { type: 'group', target: 'entra-id', targetId: 'Team-A' },
          { type: 'license', target: 'entra-id', targetId: 'E3' },
        ],
      });

      mockOffboardingModel.findOneAndUpdate.mockResolvedValue({});

      const results = await service.preComputeUpcomingOffboardings(30);

      expect(results).toHaveLength(2);
      expect(results[0].email).toBe('user1@test.com');
      expect(results[0].daysRemaining).toBe(10);
      expect(results[0].blastRadius.totalEntitlements).toBe(2);
      expect(results[0].blastRadius.affectedSystems).toContain('entra-id');
    });

    it('should skip users without endDate: asks only for live identities ending in the window', async () => {
      const now = new Date('2026-06-01T12:00:00Z');
      jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        mockIdentityModel.exec.mockResolvedValue([]);

        const results = await service.preComputeUpcomingOffboardings(30);

        expect(mockIdentityModel.find).toHaveBeenCalledWith({
          tenantId: 'default',
          deletedAt: null,
          'profile.endDate': {
            $exists: true,
            $ne: null,
            $gte: now,
            $lte: new Date('2026-07-01T12:00:00Z'),
          },
        });
        expect(results).toHaveLength(0);
        expect(mockPolicyEngine.evaluate).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  /**
   * GET /analytics/upcoming-offboardings returned the cached entries whenever any existed, and
   * nothing recomputed them: a leaver whose endDate was added after the first compute never
   * appeared, one whose endDate changed (cache marked stale) dropped out, and daysRemaining
   * stayed as computed (hunt 05 F8).
   */
  describe('getUpcomingOffboardings', () => {
    const NOW = new Date('2026-06-01T12:00:00Z');
    const inDays = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
    const identity = (id: string, endDate: Date) => ({
      _id: { toString: () => id },
      profile: { email: `${id}@corp.example`, firstName: 'A', lastName: id, endDate },
    });
    const cachedEntry = (id: string, endDate: Date, daysRemaining: number) => ({
      identityId: id,
      email: `${id}@corp.example`,
      displayName: `A ${id}`,
      endDate,
      daysRemaining,
      blastRadius: { affectedSystems: ['entra-id'], entitlements: [], totalEntitlements: 0 },
      computedAt: inDays(-20),
      stale: false,
    });

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      mockPolicyEngine.evaluate.mockResolvedValue({ operations: [] });
      mockOffboardingModel.findOneAndUpdate.mockResolvedValue({});
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('lists every live identity ending in the window, computing what is not cached', async () => {
      mockIdentityModel.exec.mockResolvedValueOnce([
        identity('id1', inDays(5)),
        identity('id2', inDays(12)),
      ]);
      // id1 was computed 20 days ago; id2's endDate was added since
      mockOffboardingModel.exec.mockResolvedValueOnce([cachedEntry('id1', inDays(5), 25)]);

      const results = await service.getUpcomingOffboardings(30);

      expect(results.map((r) => [r.identityId, r.daysRemaining])).toEqual([
        ['id1', 5],
        ['id2', 12],
      ]);
      expect(mockPolicyEngine.evaluate).toHaveBeenCalledTimes(1);
      expect(mockOffboardingModel.findOneAndUpdate).toHaveBeenCalledWith(
        { identityId: 'id2', tenantId: 'default' },
        expect.anything(),
        expect.anything(),
      );
    });

    it('recomputes an entry whose endDate changed since it was cached', async () => {
      mockIdentityModel.exec.mockResolvedValueOnce([identity('id1', inDays(3))]);
      mockOffboardingModel.exec.mockResolvedValueOnce([cachedEntry('id1', inDays(9), 9)]);

      const [entry] = await service.getUpcomingOffboardings(30);

      expect(entry.endDate).toEqual(inDays(3));
      expect(entry.daysRemaining).toBe(3);
      expect(mockPolicyEngine.evaluate).toHaveBeenCalledTimes(1);
    });

    it('lists nobody when no live identity ends in the window, whatever the cache holds', async () => {
      mockIdentityModel.exec.mockResolvedValueOnce([]);

      await expect(service.getUpcomingOffboardings(30)).resolves.toEqual([]);
      expect(mockPolicyEngine.evaluate).not.toHaveBeenCalled();
    });
  });

  describe('forecastLicenseConsumption', () => {
    it('should return insufficient_data when history has fewer than 3 months', async () => {
      const emptyEvents: any[] = [];
      mockAuditModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue(emptyEvents),
          }),
        }),
      });

      const result = await service.forecastLicenseConsumption('entra-id', 'E3', 90);
      expect(result.insufficientData).toBe(true);
      expect(result.trend).toBe('stable');
    });

    it('should project linear trend when sufficient history exists', async () => {
      const events = [
        {
          timestamp: new Date('2025-01-15'),
          payload: {
            metadata: {
              connector: 'entra-id',
              operations: [{ type: 'license', targetId: 'E3', action: 'add' }],
            },
          },
        },
        {
          timestamp: new Date('2025-01-20'),
          payload: {
            metadata: {
              connector: 'entra-id',
              operations: [{ type: 'license', targetId: 'E3', action: 'add' }],
            },
          },
        },
        {
          timestamp: new Date('2025-02-10'),
          payload: {
            metadata: {
              connector: 'entra-id',
              operations: [{ type: 'license', targetId: 'E3', action: 'add' }],
            },
          },
        },
        {
          timestamp: new Date('2025-03-05'),
          payload: {
            metadata: {
              connector: 'entra-id',
              operations: [{ type: 'license', targetId: 'E3', action: 'add' }],
            },
          },
        },
        {
          timestamp: new Date('2025-03-20'),
          payload: {
            metadata: {
              connector: 'entra-id',
              operations: [{ type: 'license', targetId: 'E3', action: 'add' }],
            },
          },
        },
      ];
      mockAuditModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue(events),
          }),
        }),
      });

      // The events are of the six months before this date
      jest.useFakeTimers({
        now: new Date('2025-03-25T12:00:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      // Entra ID reported 40 units in use at the last discovery
      mockCatalogModel.exec.mockResolvedValueOnce({
        name: 'E3',
        licenseUnits: { consumed: 40, enabled: 100, observedAt: new Date('2025-03-24') },
      });
      try {
        const result = await service.forecastLicenseConsumption('entra-id', 'E3', 90);

        expect(result.insufficientData).toBeFalsy();
        expect(result.currentCount).toBe(40);
        expect(result.trend).toBe('growing');
        expect(result.projectedCount).toBeGreaterThanOrEqual(40);
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * monthlyRate divided by the months that had events, not by the calendar months of the
     * window, and daysToCapacity was (remaining / (rate / 30)) * 30, 30 times too large, so the
     * capacity warning almost never appeared (hunt 05 F13, r2-05 N3).
     */
    describe('rate and days to capacity', () => {
      const add = (iso: string) => ({
        timestamp: new Date(iso),
        payload: {
          metadata: {
            connector: 'entra-id',
            operations: [{ type: 'license', targetId: 'E3', action: 'add' }],
          },
        },
      });
      // Six adds in three of the six months before 2025-03-25
      const events = [
        add('2024-10-05'),
        add('2024-10-06'),
        add('2025-01-10'),
        add('2025-01-11'),
        add('2025-03-01'),
        add('2025-03-02'),
      ];

      beforeEach(() => {
        jest.useFakeTimers({
          now: new Date('2025-03-25T12:00:00Z'),
          doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
        });
        mockAuditModel.find.mockReturnValue({
          sort: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(events) }) }),
        });
        // 6 of 12 units in use at the last discovery
        mockCatalogModel.exec.mockResolvedValue({
          name: 'E3',
          licenseUnits: { consumed: 6, enabled: 12, observedAt: new Date('2025-03-24') },
        });
      });

      afterEach(() => {
        jest.useRealTimers();
        mockConfigService.get.mockReset();
        mockCatalogModel.exec.mockReset();
      });

      it('counts the net change per calendar month of the window', async () => {
        const result = await service.forecastLicenseConsumption('entra-id', 'E3', 90);

        expect(result.monthlyRate).toBe(1);
        expect(result.projectedCount).toBe(9);
      });

      it('gives the days until the cap at that rate', async () => {
        const result = await service.forecastLicenseConsumption('entra-id', 'E3', 90);

        // 12 - 6 = 6 left at 1 a month: 6 months
        expect(result.daysToCapacity).toBe(180);
      });
    });

    /**
     * currentCount was EuroID's net adds minus removes in the 6-month window, starting at 0, so
     * a license assigned before the window or outside EuroID counted as free and daysToCapacity
     * was wrong (HX-F report, follow-up). It is now the consumption Entra ID reported at the
     * last discovery (subscribedSkus consumedUnits, prepaidUnits.enabled on the catalog entry).
     */
    describe('consumption as discovery read it', () => {
      // Two adds in each of three months: EuroID itself assigned 6 units in the window
      const events = [
        '2025-01-10',
        '2025-01-11',
        '2025-02-10',
        '2025-02-11',
        '2025-03-10',
        '2025-03-11',
      ].map((iso) => ({
        timestamp: new Date(iso),
        payload: {
          metadata: {
            connector: 'entra-id',
            operations: [{ type: 'license', targetId: 'E3', action: 'add' }],
          },
        },
      }));

      beforeEach(() => {
        jest.useFakeTimers({
          now: new Date('2025-03-25T12:00:00Z'),
          doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
        });
        mockAuditModel.find.mockReturnValue({
          sort: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(events) }) }),
        });
      });

      afterEach(() => {
        jest.useRealTimers();
        mockCatalogModel.exec.mockReset();
        mockConfigService.get.mockReset();
      });

      it('starts from the units in use and forecasts against the units the tenant has', async () => {
        // 95 of 100 units in use, most of them assigned before the window or outside EuroID
        mockCatalogModel.exec.mockResolvedValue({
          name: 'E3',
          licenseUnits: { consumed: 95, enabled: 100, observedAt: new Date('2025-03-24') },
        });

        const result = await service.forecastLicenseConsumption('entra-id', 'E3', 90);

        expect(result.currentCount).toBe(95);
        expect(result.capacity).toBe(100);
        expect(result.monthlyRate).toBe(1);
        // 5 left at 1 a month: 5 months
        expect(result.daysToCapacity).toBe(150);
        expect(mockCatalogModel.findOne).toHaveBeenCalledWith(
          expect.objectContaining({ system: 'entra-id', type: 'License' }),
        );
      });

      it('says the consumption is unknown while discovery has not read it', async () => {
        mockCatalogModel.exec.mockResolvedValue({ name: 'E3' });
        mockConfigService.get.mockReturnValue({ 'entra-id': { E3: 12 } });

        const result = await service.forecastLicenseConsumption('entra-id', 'E3', 90);

        expect(result.currentCount).toBeNull();
        expect(result.projectedCount).toBeNull();
        expect(result.daysToCapacity).toBeUndefined();
      });

      it('forecasts every license of the summary from its own catalog entry', async () => {
        mockCatalogModel.exec.mockResolvedValueOnce([
          {
            system: 'entra-id',
            name: 'E3',
            licenseUnits: { consumed: 95, enabled: 100, observedAt: new Date('2025-03-24') },
          },
          { system: 'entra-id', name: 'E5' },
        ]);

        const summary = await service.getLicenseSummary(90);

        expect(summary.map((f) => [f.license, f.currentCount, f.daysToCapacity])).toEqual([
          ['E3', 95, 150],
          ['E5', null, undefined],
        ]);
        expect(mockCatalogModel.findOne).not.toHaveBeenCalled();
      });
    });
  });

  describe('detectSeasonalPatterns', () => {
    it('should identify anomalous months with high onboarding volume', async () => {
      // avg = (2+2+25)/3 = 9.67, threshold = 19.34, so 25 >= 19.34 is anomalous
      mockAuditModel.aggregate.mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          { _id: { year: 2025, month: 1 }, count: 2 },
          { _id: { year: 2025, month: 6 }, count: 25 },
          { _id: { year: 2025, month: 7 }, count: 2 },
        ]),
      });

      const results = await service.detectSeasonalPatterns();

      expect(results.length).toBe(3);
      const june = results.find((r) => r.month === 6);
      const july = results.find((r) => r.month === 7);
      expect(june?.label).toBe('Intern wave');
      expect(july?.label).toBe('Intern wave');
      expect(june?.isAnomalous).toBe(true);
    });
  });

  describe('markOffboardingStale', () => {
    it('should mark cache entries stale for identity', async () => {
      mockOffboardingModel.updateMany.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
      });
      await service.markOffboardingStale('identity-123');
      expect(mockOffboardingModel.updateMany).toHaveBeenCalledWith(
        { identityId: 'identity-123', tenantId: 'default' },
        { $set: { stale: true } },
      );
    });
  });
});
