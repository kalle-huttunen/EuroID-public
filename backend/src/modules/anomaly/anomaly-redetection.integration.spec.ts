/**
 * What a later analysis does with anomalies already decided, on in-memory MongoDB (hunt 05 F4,
 * F5). It de-duplicated only against an open anomaly with the same (constant) pattern, so the
 * next provisioning or drift event re-created a dismissed, resolved or acknowledged anomaly, with
 * an anomaly.detected event, and the duplicates inflated risk scores. The per-identity risk score
 * (`risk_scores`, GET /anomalies/risk-scores) was written only when a rule found something, so
 * it never went down.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { anomalyConfig } from '@infrastructure/config/anomaly.config';
import { createMockEventEmitter, closeTestDb, testDbUri } from '@testing';
import { AccessAnomalyService } from './anomaly.service';
import { IdentityService } from '../identity/identity.service';
import { Anomaly, AnomalyDocument, AnomalySchema } from './schemas/anomaly.schema';
import { RiskScore, RiskScoreDocument, RiskScoreSchema } from './schemas/risk-score.schema';
import type { AnomalyCandidate } from './anomaly-rules';

mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-a';
const IDENTITY_ID = '64b7f0c2a1b2c3d4e5f60001';

const timeBased = (events: string[]): AnomalyCandidate => ({
  type: 'TIME_BASED',
  severity: 'medium',
  title: 'Access changes outside business hours',
  description: `${events.length} change(s) outside business hours`,
  evidence: { events, pattern: 'time_based_outside_hours', details: {} },
});

describe('AccessAnomalyService: decided anomalies and the risk score (in-memory MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: AccessAnomalyService;
  let anomalyModel: Model<AnomalyDocument>;
  let riskModel: Model<RiskScoreDocument>;
  const events = createMockEventEmitter();
  /** What the rules find on the next analysis. */
  let found: AnomalyCandidate[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Anomaly.name, schema: AnomalySchema },
          { name: RiskScore.name, schema: RiskScoreSchema },
        ]),
      ],
      providers: [
        AccessAnomalyService,
        { provide: DomainEventEmitterService, useValue: events },
        { provide: anomalyConfig.KEY, useValue: { businessHoursTz: 'UTC' } },
        {
          provide: IdentityService,
          useValue: { findOne: jest.fn().mockResolvedValue({ _id: IDENTITY_ID }) },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(AccessAnomalyService);
    // The rules' findings stand in for the audit, timeline and policy reads they make
    (service as unknown as { rules: unknown }).rules = [
      ['TIME_BASED', async () => found.find((c) => c.type === 'TIME_BASED') ?? null],
      ['VELOCITY', async () => found.find((c) => c.type === 'VELOCITY') ?? null],
    ];
    anomalyModel = moduleRef.get(getModelToken(Anomaly.name));
    riskModel = moduleRef.get(getModelToken(RiskScore.name));
  });

  afterEach(async () => {
    await anomalyModel.deleteMany({}, { skipTenantScope: true });
    await riskModel.deleteMany({}, { skipTenantScope: true });
    found = [];
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const analyze = () =>
    withTenantContext(TENANT, () => service.runAnalysis({ identityId: IDENTITY_ID }));
  const inTenant = <T>(fn: () => Promise<T>) => withTenantContext(TENANT, fn);
  const anomalies = () =>
    anomalyModel.find({}, null, { skipTenantScope: true }).sort({ detectedAt: 1 }).lean();
  const riskScore = async () =>
    (await riskModel.findOne({ identityId: IDENTITY_ID }, null, { skipTenantScope: true }).lean())
      ?.riskScore;

  it.each(['dismiss', 'resolve'] as const)(
    'does not re-create an anomaly after %s while its evidence is the same',
    async (decide) => {
      found = [timeBased(['e1', 'e2'])];
      await analyze();
      const [first] = await anomalies();
      await inTenant(() =>
        decide === 'dismiss' ? service.dismiss(first.anomalyId) : service.resolve(first.anomalyId),
      );
      jest.clearAllMocks();

      // The 7-day window moved on: one event dropped out, nothing new came in
      found = [timeBased(['e2'])];
      const result = await analyze();

      expect(result.anomaliesCreated).toBe(0);
      expect(await anomalies()).toHaveLength(1);
      expect(events.emit).not.toHaveBeenCalledWith(
        'anomaly.detected',
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it('records a new anomaly when new evidence came in after the decision', async () => {
    found = [timeBased(['e1'])];
    await analyze();
    const [first] = await anomalies();
    await inTenant(() => service.dismiss(first.anomalyId));

    found = [timeBased(['e1', 'e3'])];
    const result = await analyze();

    expect(result.anomaliesCreated).toBe(1);
    expect((await anomalies()).map((a) => a.status)).toEqual(['dismissed', 'open']);
  });

  // Final review RC4: `every` over no items is true, so after one decision a candidate whose
  // evidence names no events or entitlements was never raised again
  it('raises again a candidate whose evidence names nothing, after a decision', async () => {
    found = [timeBased([])];
    await analyze();
    const [first] = await anomalies();
    await inTenant(() => service.dismiss(first.anomalyId));

    const result = await analyze();

    expect(result.anomaliesCreated).toBe(1);
    expect((await anomalies()).map((a) => a.status)).toEqual(['dismissed', 'open']);
  });

  it('adds no copy while one is acknowledged (being handled)', async () => {
    found = [timeBased(['e1'])];
    await analyze();
    const [first] = await anomalies();
    await inTenant(() => service.acknowledge(first.anomalyId, 'ops@corp.example'));

    found = [timeBased(['e1', 'e3'])];
    const result = await analyze();

    expect(result.anomaliesCreated).toBe(0);
    expect(await anomalies()).toHaveLength(1);
  });

  it("scores the identity's open anomalies, and drops the score once none is open", async () => {
    found = [timeBased(['e1']), { ...timeBased(['v1']), type: 'VELOCITY' }];
    await analyze();
    expect(await riskScore()).toBe(15 + 25);

    const timeAnomaly = (await anomalies()).find((a) => a.type === 'TIME_BASED')!;
    await inTenant(() => service.resolve(timeAnomaly.anomalyId));
    expect(await riskScore()).toBe(25);

    // Nothing found any more, and the last open one dismissed
    found = [];
    await analyze();
    expect(await riskScore()).toBe(25);
    const velocity = (await anomalies()).find((a) => a.type === 'VELOCITY')!;
    await inTenant(() => service.dismiss(velocity.anomalyId));
    expect(await riskScore()).toBeUndefined();
  });

  // Hunt 05 F17: dismiss took the signed-in user and recorded nobody
  it('records who dismissed or resolved an anomaly', async () => {
    found = [timeBased(['e1']), { ...timeBased(['v1']), type: 'VELOCITY' }];
    await analyze();
    const [first, second] = await anomalies();

    await inTenant(() => service.dismiss(first.anomalyId, 'false alarm', 'ops@corp.example'));
    await inTenant(() => service.resolve(second.anomalyId, 'sec@corp.example'));

    expect((await anomalies()).map((a) => [a.status, a.resolvedBy])).toEqual([
      ['dismissed', 'ops@corp.example'],
      ['resolved', 'sec@corp.example'],
    ]);
  });
});
