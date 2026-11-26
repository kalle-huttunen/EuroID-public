/**
 * The privilege escalation rule ranks each group an identity was added to by keywords in its
 * name, but a provisioning event names an Entra ID group by its object id (a GUID), which ranked
 * 0: escalation through Entra ID groups was never detected (hunt 05 F16, HX-F report follow-up).
 * The group is now resolved through the entitlement catalog first: its name there, and the
 * catalog's own privilege marking (admin tier, risk level).
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
import type {
  CatalogTargetEntry,
  PolicyTarget,
} from '../entitlement-catalog/catalog-target-lookup';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { AnomalyConfig } from '@infrastructure/config/anomaly.config';
import type { EntraService } from '../connectors/entra-connector/entra.service';
import { withTestTenant } from '@testing/test-helpers';

const IDENTITY = { _id: '64b7f0c2a1b2c3d4e5f60001', email: 'ada@corp.example' };
const SALES = '0b3c1a52-1d2e-4f60-8a71-2b3c4d5e6f70';
const TIER0 = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
const UNKNOWN = '11111111-2222-4333-8444-555555555555';

const CONFIG: AnomalyConfig = {
  businessHoursTz: 'UTC',
  businessHoursStart: 0,
  businessHoursEnd: 24,
  velocityThresholdN: 10,
  velocityWindowM: 5,
  privilegeEscalationWindowH: 24,
  peerDeviationThreshold: 0.1,
};

/** The catalog as loadTargetLookup reads it. */
const CATALOG: Record<string, Partial<CatalogTargetEntry> & { name: string }> = {
  [SALES]: { name: 'Sales Members' },
  [TIER0]: { name: 'Server Operations', adminTier: 'TIER_0', requiresAdminAccount: true },
};

/** A provisioning event of the timeline adding Entra ID groups by object id. */
const added = (id: string, minute: number, groups: string[]) => ({
  _id: id,
  timestamp: new Date(Date.UTC(2026, 10, 20, 10, minute)),
  targetSystem: 'entra-id',
  metadata: {
    operations: groups.map((g) => ({ type: 'group', action: 'add', targetId: g })),
  },
});

describe('AccessAnomalyService privilege escalation through Entra ID groups', () => {
  const query = (value: unknown) => {
    const q = { sort: () => q, limit: () => q, lean: () => q, exec: () => Promise.resolve(value) };
    return q;
  };
  const anomalyModel = {
    create: jest.fn(),
    find: jest.fn(() => query([])),
    distinct: jest.fn(() => query([])),
  };
  const riskScoreModel = {
    findOneAndUpdate: jest.fn(),
    deleteOne: jest.fn(() => query({})),
  };
  const userEventService = { getEvents: jest.fn() };
  const entitlementCatalog = {
    list: jest.fn().mockResolvedValue([]),
    loadTargetLookup: jest.fn(async (_tenantId: string, _targets: PolicyTarget[]) => {
      return (t: PolicyTarget) => {
        const entry = t.system === 'entra-id' ? CATALOG[t.targetId] : undefined;
        return entry ? { system: 'entra-id', nativeId: t.targetId, ...entry } : undefined;
      };
    }),
  };
  let service: AccessAnomalyService;

  const escalations = () =>
    anomalyModel.create.mock.calls
      .map(([doc]) => doc)
      .filter((doc: { type: string }) => doc.type === 'PRIVILEGE_ESCALATION');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    anomalyModel.create.mockResolvedValue({});
    service = new AccessAnomalyService(
      anomalyModel as unknown as Model<AnomalyDocument>,
      riskScoreModel as unknown as Model<RiskScoreDocument>,
      { query: jest.fn().mockResolvedValue({ data: [] }) } as unknown as AuditService,
      userEventService as unknown as UserEventService,
      { findOne: jest.fn().mockResolvedValue(IDENTITY) } as unknown as IdentityService,
      {
        evaluate: jest.fn().mockResolvedValue({ operations: [] }),
      } as unknown as PolicyEngineService,
      entitlementCatalog as unknown as EntitlementCatalogService,
      { emit: jest.fn() } as unknown as DomainEventEmitterService,
      CONFIG,
      { isConfiguredForTenant: jest.fn().mockResolvedValue(false) } as unknown as EntraService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('detects a member group then a tier 0 group named by object id within the window', async () => {
    userEventService.getEvents.mockResolvedValue([
      added('evt-1', 0, [SALES]),
      added('evt-2', 30, [TIER0]),
    ]);

    await withTestTenant(() => service.runAnalysis({ identityId: IDENTITY._id }));

    expect(escalations()).toHaveLength(1);
    expect(escalations()[0].evidence.details).toEqual(expect.objectContaining({ count: 2 }));
    expect(entitlementCatalog.loadTargetLookup).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        { system: 'entra-id', targetId: SALES },
        { system: 'entra-id', targetId: TIER0 },
      ]),
    );
  });

  it('ranks a group the catalog does not know by its id alone, as before', async () => {
    userEventService.getEvents.mockResolvedValue([
      added('evt-1', 0, [UNKNOWN]),
      added('evt-2', 30, [UNKNOWN]),
    ]);

    await withTestTenant(() => service.runAnalysis({ identityId: IDENTITY._id }));

    expect(escalations()).toHaveLength(0);
  });
});
