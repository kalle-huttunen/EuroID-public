/**
 * POST /anomalies/analyze must not present a failed rule as "no finding". A rule that throws is
 * counted (which rule, for how many identities), the other rules and identities still run, and
 * the cause goes to the log with personal data masked. The answer also says how many identities
 * were analysed out of how many the tenant has: one run covers one page of identities.
 */
import { Logger } from '@nestjs/common';
import type { Model } from 'mongoose';
import { AccessAnomalyService } from './anomaly.service';
import type { AnomalyDocument } from './schemas/anomaly.schema';
import type { RiskScoreDocument } from './schemas/risk-score.schema';
import type { AuditService } from '../audit/audit.service';
import type { UserEventService } from '../identity/user-event.service';
import type { IdentityService } from '../identity/identity.service';
import type { PolicyEngineService } from '../policy/policy-engine.service';
import type { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { AnomalyConfig } from '@infrastructure/config/anomaly.config';
import type { EntraService } from '../connectors/entra-connector/entra.service';

const USERS = [
  { _id: '64b7f0c2a1b2c3d4e5f60001', email: 'ada@corp.example' },
  { _id: '64b7f0c2a1b2c3d4e5f60002', email: 'bob@corp.example' },
  { _id: '64b7f0c2a1b2c3d4e5f60003', email: 'cy@corp.example' },
];
const [ADA, BOB, CY] = USERS.map((u) => u._id);
const TENANT_IDENTITIES = 312;

/** Fifteen provisioning events within three minutes: the velocity rule flags them. */
const BURST = Array.from({ length: 15 }, (_, i) => ({
  _id: `evt-${i}`,
  timestamp: new Date(Date.UTC(2026, 10, 20, 10, 0, i * 10)),
  metadata: {},
}));

const CONFIG: AnomalyConfig = {
  businessHoursTz: 'UTC',
  businessHoursStart: 7,
  businessHoursEnd: 19,
  velocityThresholdN: 10,
  velocityWindowM: 5,
  privilegeEscalationWindowH: 24,
  peerDeviationThreshold: 0.1,
};

describe('AccessAnomalyService.runAnalysis', () => {
  /** A query that answers `value` (find().sort().limit().lean().exec(), distinct().exec()). */
  const answering = (value: unknown) => {
    const query = {
      sort: () => query,
      limit: () => query,
      lean: () => query,
      exec: () => Promise.resolve(value),
    };
    return query;
  };
  const anomalyModel = {
    findOne: jest.fn(),
    create: jest.fn(),
    // No earlier anomaly of the identity, none open
    find: jest.fn(() => answering([])),
    distinct: jest.fn(() => answering([])),
  };
  const riskScoreModel = {
    findOneAndUpdate: jest.fn(),
    deleteOne: jest.fn(() => answering({})),
  };
  const auditService = { query: jest.fn() };
  const userEventService = { getEvents: jest.fn() };
  const identityService = { findOne: jest.fn(), findAllPaginated: jest.fn() };
  const policyEngine = { evaluate: jest.fn() };
  const entitlementCatalog = { list: jest.fn() };
  const eventEmitter = { emit: jest.fn() };
  const entraService = {
    isConfiguredForTenant: jest.fn(),
    checkUserExists: jest.fn(),
    getUserGroupMemberships: jest.fn(),
  };
  let logError: jest.SpyInstance;
  let service: AccessAnomalyService;

  beforeEach(() => {
    jest.clearAllMocks();
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    anomalyModel.findOne.mockResolvedValue(null);
    anomalyModel.create.mockResolvedValue({});
    riskScoreModel.findOneAndUpdate.mockResolvedValue(null);
    auditService.query.mockResolvedValue({ data: [] });
    userEventService.getEvents.mockResolvedValue([]);
    identityService.findAllPaginated.mockResolvedValue([USERS, TENANT_IDENTITIES]);
    identityService.findOne.mockResolvedValue(USERS[0]);
    policyEngine.evaluate.mockResolvedValue({ operations: [] });
    entitlementCatalog.list.mockResolvedValue([]);
    entraService.isConfiguredForTenant.mockResolvedValue(true);
    entraService.checkUserExists.mockResolvedValue(null);
    entraService.getUserGroupMemberships.mockResolvedValue([]);

    service = new AccessAnomalyService(
      anomalyModel as unknown as Model<AnomalyDocument>,
      riskScoreModel as unknown as Model<RiskScoreDocument>,
      auditService as unknown as AuditService,
      userEventService as unknown as UserEventService,
      identityService as unknown as IdentityService,
      policyEngine as unknown as PolicyEngineService,
      entitlementCatalog as unknown as EntitlementCatalogService,
      eventEmitter as unknown as DomainEventEmitterService,
      CONFIG,
      entraService as unknown as EntraService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('reports a rule that throws and still runs the other rules and identities', async () => {
    auditService.query.mockImplementation(async (filter: { resourceId: string }) => {
      if (filter.resourceId === BOB) throw new Error('audit store unavailable');
      return { data: [] };
    });
    userEventService.getEvents.mockImplementation(async (identityId: string) =>
      identityId === BOB ? BURST : [],
    );

    const result = await service.runAnalysis();

    // Bob's velocity finding is saved although his time-based rule failed.
    expect(anomalyModel.create).toHaveBeenCalledTimes(1);
    expect(anomalyModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ identityId: BOB, type: 'VELOCITY' }),
    );
    expect(auditService.query).toHaveBeenCalledTimes(3);
    expect(entraService.checkUserExists).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      analyzed: 3,
      totalIdentities: TENANT_IDENTITIES,
      anomaliesCreated: 1,
      identityIds: [ADA, BOB, CY],
      ruleFailures: { rules: 1, identities: 1, byRule: { TIME_BASED: 1 } },
    });
  });

  it('counts distinct failed rules and the identities they failed for', async () => {
    auditService.query.mockImplementation(async (filter: { resourceId: string }) => {
      if (filter.resourceId === ADA) throw new Error('audit store unavailable');
      return { data: [] };
    });
    // The orphan-access rule no longer turns an Entra failure into "no finding".
    entraService.checkUserExists.mockImplementation(async (email: string) => {
      if (email === 'bob@corp.example') return null;
      throw new Error(`Graph 503 for ${email}`);
    });

    const result = await service.runAnalysis();

    expect(result.analyzed).toBe(3);
    expect(result.anomaliesCreated).toBe(0);
    expect(result.ruleFailures).toEqual({
      rules: 2,
      identities: 2,
      byRule: { TIME_BASED: 1, ORPHAN_ACCESS: 2 },
    });
  });

  it('logs the cause with personal data masked and answers counts only', async () => {
    entraService.checkUserExists.mockImplementation(async (email: string) => {
      if (email === 'ada@corp.example') throw new Error(`Graph 503 for ${email}`);
      return null;
    });

    const result = await service.runAnalysis();

    expect(logError).toHaveBeenCalledTimes(1);
    const logged = String(logError.mock.calls[0][0]);
    expect(logged).toContain('ORPHAN_ACCESS');
    expect(logged).toContain(ADA);
    expect(logged).toContain('Graph 503');
    expect(logged).not.toContain('ada@corp.example');
    expect(JSON.stringify(result)).not.toMatch(/corp\.example|Graph 503/);
  });

  it('does not count the orphan-access rule as failed where Entra ID is not configured', async () => {
    entraService.isConfiguredForTenant.mockResolvedValue(false);

    const result = await service.runAnalysis();

    expect(entraService.checkUserExists).not.toHaveBeenCalled();
    expect(result.ruleFailures).toEqual({ rules: 0, identities: 0, byRule: {} });
  });

  it('analyses the first page of 50 by default and says out of how many', async () => {
    const result = await service.runAnalysis();

    expect(identityService.findAllPaginated).toHaveBeenCalledWith(0, 50);
    expect(result).toMatchObject({ analyzed: 3, totalIdentities: TENANT_IDENTITIES });
  });

  it('reads page as 1-based, like the controller and GET /anomalies', async () => {
    await service.runAnalysis({ page: 1, limit: 10 });
    await service.runAnalysis({ page: 3, limit: 10 });

    expect(identityService.findAllPaginated).toHaveBeenNthCalledWith(1, 0, 10);
    expect(identityService.findAllPaginated).toHaveBeenNthCalledWith(2, 20, 30);
  });

  it('analyses one identity by id, out of one', async () => {
    const result = await service.runAnalysis({ identityId: ADA });

    expect(identityService.findOne).toHaveBeenCalledWith(ADA);
    expect(identityService.findAllPaginated).not.toHaveBeenCalled();
    expect(result).toEqual({
      analyzed: 1,
      totalIdentities: 1,
      anomaliesCreated: 0,
      identityIds: [ADA],
      ruleFailures: { rules: 0, identities: 0, byRule: {} },
    });
  });

  it('analyses nothing, out of none, for an identity it cannot find', async () => {
    identityService.findOne.mockResolvedValue(null);

    const result = await service.runAnalysis({ identityId: ADA });

    expect(result).toEqual({
      analyzed: 0,
      totalIdentities: 0,
      anomaliesCreated: 0,
      identityIds: [],
      ruleFailures: { rules: 0, identities: 0, byRule: {} },
    });
  });
});
