/**
 * Anomaly status changes, on in-memory MongoDB. Open can be acknowledged, resolved or dismissed;
 * acknowledged can be resolved or dismissed; resolved and dismissed are final. A change the
 * current status does not allow (repeating a final one included) is a 409 naming that status:
 * it changes nothing and emits no event, so the audit trail and the dashboard counts agree.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { anomalyConfig } from '@infrastructure/config/anomaly.config';
import { createMockEventEmitter, closeTestDb, testDbUri } from '@testing';
import { AccessAnomalyService } from './anomaly.service';
import {
  Anomaly,
  AnomalyDocument,
  AnomalySchema,
  type AnomalyStatus,
} from './schemas/anomaly.schema';
import { RiskScore, RiskScoreSchema } from './schemas/risk-score.schema';

mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-a';
const ANOMALY_ID = '0b5e2c1d-7a43-4f0e-9d7a-2a1c3b4d5e6f';
const IDENTITY_ID = '64b7f0c2a1b2c3d4e5f60001';
const EARLIER = new Date('2026-11-20T08:00:00.000Z');

type Action = 'acknowledge' | 'resolve' | 'dismiss';
const TARGET: Record<Action, AnomalyStatus> = {
  acknowledge: 'acknowledged',
  resolve: 'resolved',
  dismiss: 'dismissed',
};

const ALLOWED: Array<[AnomalyStatus, Action]> = [
  ['open', 'acknowledge'],
  ['open', 'resolve'],
  ['open', 'dismiss'],
  ['acknowledged', 'resolve'],
  ['acknowledged', 'dismiss'],
];
const FORBIDDEN: Array<[AnomalyStatus, Action, string]> = [
  ['acknowledged', 'acknowledge', `Anomaly ${ANOMALY_ID} is already acknowledged.`],
  ['resolved', 'acknowledge', `Anomaly ${ANOMALY_ID} is resolved and cannot be acknowledged.`],
  ['resolved', 'resolve', `Anomaly ${ANOMALY_ID} is already resolved.`],
  ['resolved', 'dismiss', `Anomaly ${ANOMALY_ID} is resolved and cannot be dismissed.`],
  ['dismissed', 'acknowledge', `Anomaly ${ANOMALY_ID} is dismissed and cannot be acknowledged.`],
  ['dismissed', 'resolve', `Anomaly ${ANOMALY_ID} is dismissed and cannot be resolved.`],
  ['dismissed', 'dismiss', `Anomaly ${ANOMALY_ID} is already dismissed.`],
];

describe('AccessAnomalyService status changes (in-memory MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: AccessAnomalyService;
  let anomalyModel: Model<AnomalyDocument>;
  const events = createMockEventEmitter();

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
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(AccessAnomalyService);
    anomalyModel = moduleRef.get(getModelToken(Anomaly.name));
  });

  afterEach(async () => {
    await anomalyModel.deleteMany({}, { skipTenantScope: true });
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  /** An anomaly in `status`, with what the earlier changes to reach it left behind. */
  async function seed(status: AnomalyStatus): Promise<void> {
    await withTenantContext(TENANT, () =>
      anomalyModel.create({
        tenantId: TENANT,
        anomalyId: ANOMALY_ID,
        identityId: IDENTITY_ID,
        type: 'PRIVILEGE_ESCALATION',
        severity: 'high',
        riskScore: 30,
        title: 'Privilege escalation',
        description: 'Three admin groups in a day.',
        evidence: { events: [], pattern: 'privilege_escalation', details: {} },
        status,
        ...(status === 'acknowledged' ? { acknowledgedBy: 'first@corp.example' } : {}),
        ...(status === 'resolved' || status === 'dismissed' ? { resolvedAt: EARLIER } : {}),
        metadata: { source: 'test', ...(status === 'dismissed' ? { dismissReason: 'Old' } : {}) },
      }),
    );
  }

  function stored() {
    return anomalyModel.findOne({ anomalyId: ANOMALY_ID }, null, { skipTenantScope: true }).lean();
  }

  async function act(action: Action, id = ANOMALY_ID): Promise<AnomalyDocument> {
    return withTenantContext(TENANT, () =>
      action === 'acknowledge'
        ? service.acknowledge(id, 'op@corp.example')
        : action === 'dismiss'
          ? service.dismiss(id, 'False positive')
          : service.resolve(id),
    );
  }

  describe.each(ALLOWED)('%s -> %s', (from, action) => {
    it('moves to the action status and records what the change did', async () => {
      await seed(from);

      const result = await act(action);

      const after = await stored();
      expect(result.status).toBe(TARGET[action]);
      expect(after?.status).toBe(TARGET[action]);
      if (action === 'acknowledge') {
        expect(after?.acknowledgedBy).toBe('op@corp.example');
        expect(after?.resolvedAt).toBeUndefined();
        expect(events.emit).not.toHaveBeenCalled();
        return;
      }
      // Closing keeps who acknowledged it and any metadata already there.
      expect(after?.acknowledgedBy).toBe(
        from === 'acknowledged' ? 'first@corp.example' : undefined,
      );
      expect(after?.resolvedAt).toBeInstanceOf(Date);
      expect(after?.metadata).toEqual(
        action === 'dismiss'
          ? { source: 'test', dismissReason: 'False positive' }
          : { source: 'test' },
      );
      expect(events.emit).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(DomainEventType.ANOMALY_RESOLVED, IDENTITY_ID, {
        anomalyId: ANOMALY_ID,
        identityId: IDENTITY_ID,
        status: TARGET[action],
      });
    });
  });

  describe.each(FORBIDDEN)('%s -> %s', (from, action, message) => {
    it('is a 409 naming the current status; nothing changes and no event is emitted', async () => {
      await seed(from);
      const before = await stored();

      const error = await act(action).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe(message);
      expect(await stored()).toEqual(before);
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  it('lets only one of two simultaneous resolves through, with one event', async () => {
    await seed('open');

    const results = await Promise.allSettled([act('resolve'), act('resolve')]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('changes the anomaly found by its document _id too', async () => {
    await seed('open');
    const objectId = String((await stored())?._id);

    await act('acknowledge', objectId);

    expect((await stored())?.status).toBe('acknowledged');
  });

  it.each<Action>(['acknowledge', 'resolve', 'dismiss'])(
    '%s of an anomaly that does not exist is a 404',
    async (action) => {
      await expect(act(action, '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(events.emit).not.toHaveBeenCalled();
    },
  );
});
