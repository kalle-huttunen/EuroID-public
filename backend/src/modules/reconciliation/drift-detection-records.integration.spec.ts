/**
 * Drift records written by the scheduled reconciliation, on in-memory MongoDB (drift_records).
 * Before, detectUserDrift stored nothing: the drift dashboard and the identity Drift tab only
 * showed orphan or hand-made drifts.
 *
 * Proves: a run's drifts are stored under the identity id, once (repeated runs update the open
 * drift and keep its detectedAt); a drift the admin ignored stays ignored while its values hold;
 * an open drift of a system the run read and no longer finds is closed as corrected
 * (drift.resolved no_longer_detected), while systems the run could not read, orphan drifts and
 * other identities are left alone; an auto-correction closes its drift; the identity hub's
 * summary counts open drifts per identity.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import { createMockEventEmitter, closeTestDb, testDbUri } from '@testing';
import { DriftService, type DetectedDrift, type DetectionScope } from './drift.service';
import { DriftCorrectionService } from './drift-correction.service';
import { OrphanCleanupService } from './orphan-cleanup.service';
import { Drift, DriftDocument, DriftSchema } from './schemas/drift.schema';

mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-a';
const IDENTITY = '64b7f0c2a1b2c3d4e5f60001';
const OTHER_IDENTITY = '64b7f0c2a1b2c3d4e5f60002';

const scope = (checkedSystems: string[]): DetectionScope => ({
  identityId: IDENTITY,
  displayName: 'Ada Lovelace',
  email: 'ada.lovelace@corp.example',
  checkedSystems,
});

const titleDrift = (targetValue: string): DetectedDrift => ({
  targetSystem: 'entra-id',
  type: 'FIELD_MISMATCH',
  field: 'jobTitle',
  severity: 'medium',
  hubValue: 'Engineer',
  targetValue,
  autoCorrectEligible: true,
});

const missingInAd: DetectedDrift = {
  targetSystem: 'ad',
  type: 'MISSING_USER',
  severity: 'high',
  autoCorrectEligible: true,
};

describe('DriftService drift records of the scheduled reconciliation (in-memory MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: DriftService;
  let driftModel: Model<DriftDocument>;
  const events = createMockEventEmitter();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Drift.name, schema: DriftSchema }]),
      ],
      providers: [
        DriftService,
        { provide: DriftCorrectionService, useValue: {} },
        { provide: DomainEventEmitterService, useValue: events },
        { provide: OrphanCleanupService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(DriftService);
    driftModel = moduleRef.get(getModelToken(Drift.name));
  });

  afterEach(async () => {
    await driftModel.deleteMany({}, { skipTenantScope: true });
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const run = (checkedSystems: string[], drifts: DetectedDrift[]) =>
    withTenantContext(TENANT, () => service.recordDetection(scope(checkedSystems), drifts));

  const stored = () =>
    driftModel
      .find({}, null, { skipTenantScope: true })
      .sort({ targetSystem: 1, createdAt: 1 })
      .lean();

  const resolvedEvents = () =>
    events.emit.mock.calls.filter(([type]) => type === DomainEventType.DRIFT_RESOLVED);

  it("stores a run's drifts open under the identity id", async () => {
    await run(['entra-id', 'ad'], [titleDrift('Developer'), missingInAd]);

    const records = await stored();
    expect(records).toHaveLength(2);
    expect(records).toEqual([
      expect.objectContaining({
        tenantId: TENANT,
        userId: IDENTITY,
        targetSystem: 'ad',
        type: 'MISSING_USER',
        field: null,
        severity: 'high',
        status: 'open',
        autoCorrectEligible: true,
        userDisplayName: 'Ada Lovelace',
        userEmail: 'ada.lovelace@corp.example',
      }),
      expect.objectContaining({
        userId: IDENTITY,
        targetSystem: 'entra-id',
        type: 'FIELD_MISMATCH',
        field: 'jobTitle',
        hubValue: 'Engineer',
        targetValue: 'Developer',
        status: 'open',
      }),
    ]);
    // The identity page lists them: GET /reconciliation/drifts?userId=<_id>&status=open
    const listed = await withTenantContext(TENANT, () =>
      service.getDrifts({ userId: IDENTITY, status: 'open' }, 1, 50),
    );
    expect(listed.total).toBe(2);
  });

  it('keeps one open drift over repeated runs, with the latest values and the first detectedAt', async () => {
    await run(['entra-id'], [titleDrift('Developer')]);
    const [first] = await stored();

    await run(['entra-id'], [titleDrift('Senior Developer')]);
    await run(['entra-id'], [titleDrift('Senior Developer')]);

    const records = await stored();
    expect(records).toHaveLength(1);
    expect(records[0]._id).toEqual(first._id);
    expect(records[0].targetValue).toBe('Senior Developer');
    expect(records[0].detectedAt).toEqual(first.detectedAt);
    expect(resolvedEvents()).toHaveLength(0);
  });

  it('closes an open drift the run no longer detects in a system it read', async () => {
    await run(['entra-id', 'ad'], [titleDrift('Developer'), missingInAd]);

    await run(['entra-id', 'ad'], [missingInAd]);

    const [ad, entra] = await stored();
    expect(ad.status).toBe('open');
    expect(entra.status).toBe('corrected');
    expect(entra.correctedAt).toBeInstanceOf(Date);
    const [[, aggregateId, payload]] = resolvedEvents();
    expect(aggregateId).toBe(IDENTITY);
    expect(payload).toEqual({
      driftId: String(entra._id),
      identityId: IDENTITY,
      system: 'entra-id',
      resolutionAction: 'no_longer_detected',
    });
    expect(EVENT_SCHEMAS[DomainEventType.DRIFT_RESOLVED]!.parse(payload)).toEqual(payload);
  });

  it('leaves the drifts of a system the run could not read open', async () => {
    await run(['entra-id', 'ad'], [titleDrift('Developer'), missingInAd]);

    // AD's config was incomplete in this run: only Entra ID was read, and it had no drift
    await run(['entra-id'], []);

    const [ad, entra] = await stored();
    expect(ad.status).toBe('open');
    expect(entra.status).toBe('corrected');
  });

  it("leaves orphan drifts, other identities' drifts and other tenants' drifts alone", async () => {
    const base = {
      severity: 'high',
      userDisplayName: 'x',
      userEmail: 'x@corp.example',
      targetSystem: 'entra-id',
    };
    await driftModel.create([
      { ...base, tenantId: TENANT, type: 'ORPHAN_ACCOUNT', userId: IDENTITY, status: 'open' },
      { ...base, tenantId: TENANT, type: 'MISSING_USER', userId: OTHER_IDENTITY, status: 'open' },
      { ...base, tenantId: 'tenant-b', type: 'MISSING_USER', userId: IDENTITY, status: 'open' },
    ]);

    await run(['entra-id'], []);

    const records = await stored();
    expect(records.map((r) => r.status)).toEqual(['open', 'open', 'open']);
    expect(resolvedEvents()).toHaveLength(0);
  });

  it('keeps a drift the admin ignored ignored while its values hold, and opens a changed one', async () => {
    await run(['entra-id'], [titleDrift('Developer')]);
    await driftModel.collection.updateMany({}, { $set: { status: 'ignored' } });

    await run(['entra-id'], [titleDrift('Developer')]);
    expect((await stored()).map((r) => r.status)).toEqual(['ignored']);

    await run(['entra-id'], [titleDrift('Architect')]);
    const records = await stored();
    expect(records.map((r) => [r.status, r.targetValue])).toEqual([
      ['ignored', 'Developer'],
      ['open', 'Architect'],
    ]);
  });

  it('closes the open drift an auto-correction fixed', async () => {
    await run(['entra-id', 'ad'], [titleDrift('Developer'), missingInAd]);

    await withTenantContext(TENANT, () =>
      service.closeCorrectedDrift(IDENTITY, 'entra-id', 'FIELD_MISMATCH', 'jobTitle'),
    );
    await withTenantContext(TENANT, () =>
      service.closeCorrectedDrift(IDENTITY, 'ad', 'MISSING_USER', undefined),
    );

    expect((await stored()).map((r) => r.status)).toEqual(['corrected', 'corrected']);
    expect(resolvedEvents().map(([, , payload]) => payload.resolutionAction)).toEqual([
      'reconciliation_auto_correct',
      'reconciliation_auto_correct',
    ]);
  });

  it('counts open drifts per identity for the identities asked', async () => {
    await run(['entra-id', 'ad'], [titleDrift('Developer'), missingInAd]);
    const base = {
      tenantId: TENANT,
      severity: 'low',
      userDisplayName: 'x',
      userEmail: 'x@corp.example',
      targetSystem: 'entra-id',
      type: 'FIELD_MISMATCH',
    };
    await driftModel.create([
      { ...base, userId: OTHER_IDENTITY, status: 'corrected' },
      { ...base, userId: OTHER_IDENTITY, status: 'ignored' },
      { ...base, userId: '64b7f0c2a1b2c3d4e5f60003', status: 'open' },
      { ...base, tenantId: 'tenant-b', userId: OTHER_IDENTITY, status: 'open' },
    ]);

    const counts = await withTenantContext(TENANT, () =>
      service.countOpenByUser([IDENTITY, OTHER_IDENTITY]),
    );

    expect(counts).toEqual({ [IDENTITY]: 2 });
  });
});
