/**
 * The tenant's identity limit (`settings.maxIdentities`, identity-limit.ts) on in-memory MongoDB
 * with real correlation: a record that would mint an identity past the limit is refused (409,
 * naming the limit) and nothing is written; live identities count, deleted ones do not; an
 * update, a rehire and a correlation onto an existing identity are never refused.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { IdentityLimitReached, reportIdentityLimitOvershoot } from './identity-limit';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { ClientSession } from 'mongoose';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import {
  createMockLoggerFactory,
  createMockEventEmitter,
  withTestTenant,
  TEST_TENANT_ID,
} from '@testing';

mongoose.plugin(tenantPlugin);

const HR = 'csv-hr';
const EMAIL = 'ada@corp.example';
const DELETED_AT = new Date('2026-06-01T10:00:00Z');

function hrRow(extra: Partial<StandardUserDto> = {}): StandardUserDto {
  return {
    sourceSystem: HR,
    sourceUserId: 'E-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: EMAIL,
    status: UserStatus.ACTIVE,
    startDate: new Date('2020-01-01'),
    ...extra,
  } as StandardUserDto;
}

describe("the tenant's identity limit (MongoDB)", () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let identityModel: Model<IdentityDocument>;
  let policyModel: Model<LeaverPolicy>;
  const events = createMockEventEmitter();
  const { factory: loggerFactory } = createMockLoggerFactory();
  let rules: Array<{ strategy: string }> = [{ strategy: 'email' }];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: LeaverPolicy.name, schema: LeaverPolicySchema },
        ]),
      ],
      providers: [
        IdentityCorrelationService,
        IdentityOnionService,
        IdentityDeletedMatchService,
        ReconciliationService,
        CorrelationRuleEngine,
        {
          provide: ReconciliationConfigService,
          useValue: { getConfig: async () => null, getHrSourceTags: async () => [] },
        },
        {
          provide: CorrelationConfigService,
          useValue: {
            getCorrelationConfig: async () => ({
              rules,
              conflictAction: 'review',
              confidenceThreshold: 0.7,
            }),
            getPrimaryHrSourceName: async () => null,
            getHrPriorityConfig: async () => null,
            getHrPriorityFromBlueprint: async () => null,
            getHrConnectorsWithPriorityFromBlueprint: async () => [],
            getInstalledHrConnectorsWithPriority: async () => [],
            isHrSourceName: async (name: string) => name === HR,
          },
        },
        { provide: CorrelationHashService, useValue: { hash: (v: string) => `hash-${v}` } },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    correlation = moduleRef.get(IdentityCorrelationService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
    policyModel = moduleRef.get(getModelToken(LeaverPolicy.name));
    // The unique tenantId + profile.email index production has
    await identityModel.syncIndexes();
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
    await policyModel.deleteMany({}, { skipTenantScope: true });
    jest.clearAllMocks();
    rules = [{ strategy: 'email' }];
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const tenants = () => identityModel.db.collection('tenants');
  const setLimit = (maxIdentities: unknown) =>
    tenants().updateOne(
      { tenantId: TEST_TENANT_ID },
      { $set: { tenantId: TEST_TENANT_ID, name: 'Test', settings: { maxIdentities } } },
      { upsert: true },
    );
  const live = () => identityModel.countDocuments({ tenantId: TEST_TENANT_ID, deletedAt: null });
  const person = (n: number, extra: Partial<StandardUserDto> = {}) =>
    hrRow({ sourceUserId: `E-${n}`, email: `p${n}@corp.example`, ...extra });

  afterEach(async () => {
    await tenants().deleteMany({});
  });

  it('refuses the identity past the limit with 409 naming it, and writes nothing', async () =>
    await withTestTenant(async () => {
      await setLimit(2);
      await correlation.ensureIdentityFromUser(person(1));
      await correlation.ensureIdentityFromUser(person(2));

      const refused = await correlation.ensureIdentityFromUser(person(3)).catch((e: unknown) => e);

      expect(refused).toBeInstanceOf(IdentityLimitReached);
      expect((refused as IdentityLimitReached).getStatus()).toBe(409);
      expect((refused as Error).message).toMatch(/identity limit \(2\)/);
      expect(await live()).toBe(2);
    }));

  it('counts live identities only: a deleted one leaves room', async () =>
    await withTestTenant(async () => {
      await setLimit(2);
      const gone = await correlation.ensureIdentityFromUser(person(1));
      await correlation.ensureIdentityFromUser(person(2));
      await identityModel.updateOne({ _id: gone!._id }, { $set: { deletedAt: DELETED_AT } });

      await expect(correlation.ensureIdentityFromUser(person(3))).resolves.toBeTruthy();
    }));

  it('never refuses an update of an identity at the limit', async () =>
    await withTestTenant(async () => {
      await setLimit(1);
      await correlation.ensureIdentityFromUser(person(1));

      const updated = await correlation.ensureIdentityFromUser(person(1, { jobTitle: 'Lead' }));

      expect(updated!.profile.jobTitle).toBe('Lead');
    }));

  it('never refuses a correlation onto an existing identity at the limit', async () =>
    await withTestTenant(async () => {
      await setLimit(1);
      const first = await correlation.ensureIdentityFromUser(person(1));

      const correlated = await correlation.ensureIdentityFromUser(
        person(1, { sourceSystem: 'Manual-Test', sourceUserId: 'M-1' }),
      );

      expect(String(correlated!._id)).toBe(String(first!._id));
      expect(await live()).toBe(1);
    }));

  it('never refuses a rehire, which revives a deleted identity', async () =>
    await withTestTenant(async () => {
      const former = await correlation.ensureIdentityFromUser(person(1));
      await identityModel.updateOne({ _id: former!._id }, { $set: { deletedAt: DELETED_AT } });
      await correlation.ensureIdentityFromUser(person(2));
      await setLimit(1);

      const rehired = await correlation.ensureIdentityFromUser(
        person(1, { startDate: new Date('2026-09-01') }),
      );

      expect(String(rehired!._id)).toBe(String(former!._id));
      expect(await live()).toBe(2);
    }));

  it.each([undefined, null, 0, 'lots'])(
    'sets no limit for maxIdentities %p',
    async (value) =>
      await withTestTenant(async () => {
        await setLimit(value);
        await correlation.ensureIdentityFromUser(person(1));

        await expect(correlation.ensureIdentityFromUser(person(2))).resolves.toBeTruthy();
      }),
  );

  it('sets no limit for a tenant without a tenants document', async () =>
    await withTestTenant(async () => {
      await correlation.ensureIdentityFromUser(person(1));

      await expect(correlation.ensureIdentityFromUser(person(2))).resolves.toBeTruthy();
    }));

  // HX-A2 follow-up: the count and the insert are separate steps, so creates running at once can
  // pass the limit. Decision (HX-A3): that overshoot is accepted, but never unnoticed.
  describe('an overshoot by creates running at once', () => {
    const exceeded = () =>
      events.emit.mock.calls.filter(
        ([type]) => type === DomainEventType.TENANT_IDENTITY_LIMIT_EXCEEDED,
      );
    /** Another create committing between this one's count and its insert. */
    const concurrentCreate = (n: number) => async () => {
      await identityModel.collection.insertOne({
        tenantId: TEST_TENANT_ID,
        profile: { email: `racer${n}@corp.example`, firstName: 'R', lastName: `${n}` },
        sources: [],
      });
    };

    it('raises one alert naming the limit and the count when a create leaves the tenant above it', async () =>
      await withTestTenant(async () => {
        await setLimit(2);
        await correlation.ensureIdentityFromUser(person(1));
        expect(exceeded()).toEqual([]);

        // Both pass the count (1 of 2); the second insert takes the tenant to 3
        await correlation.ensureIdentityFromUser(person(2), undefined, concurrentCreate(1));

        expect(await live()).toBe(3);
        expect(exceeded()).toEqual([
          [DomainEventType.TENANT_IDENTITY_LIMIT_EXCEEDED, TEST_TENANT_ID, { limit: 2, count: 3 }],
        ]);
        const tenant = await tenants().findOne({ tenantId: TEST_TENANT_ID });
        expect(tenant?.identityLimitExceededAt).toBeInstanceOf(Date);
      }));

    it('alerts once per overshoot, and again after the count was back within the limit', async () =>
      await withTestTenant(async () => {
        await setLimit(1);
        const first = await correlation.ensureIdentityFromUser(person(1));
        await identityModel.collection.insertOne({
          tenantId: TEST_TENANT_ID,
          profile: { email: 'racer@corp.example' },
          sources: [],
        });

        await reportIdentityLimitOvershoot(identityModel, events, TEST_TENANT_ID);
        await reportIdentityLimitOvershoot(identityModel, events, TEST_TENANT_ID);
        expect(exceeded()).toHaveLength(1);

        // Back within the limit: the mark goes
        await identityModel.updateOne({ _id: first!._id }, { $set: { deletedAt: DELETED_AT } });
        await expect(
          reportIdentityLimitOvershoot(identityModel, events, TEST_TENANT_ID),
        ).resolves.toEqual({ limit: 1, count: 1, alerted: false });
        expect(
          (await tenants().findOne({ tenantId: TEST_TENANT_ID }))?.identityLimitExceededAt,
        ).toBe(undefined);

        // A new overshoot alerts again
        await identityModel.updateOne({ _id: first!._id }, { $unset: { deletedAt: '' } });
        await reportIdentityLimitOvershoot(identityModel, events, TEST_TENANT_ID);
        expect(exceeded()).toHaveLength(2);
      }));

    // Final review AU4: inside a transaction the check counted its own insert and set the flag and
    // emitted the event outside it, so a transaction that then aborted (a duplicate email) left an
    // alert for an identity that never existed. Such a create is left to the hourly sweep, which
    // sees only committed identities. (Before, this test expected count 2 and an alert.)
    it('leaves a create inside a transaction to the hourly sweep: no flag and no event', async () =>
      await withTestTenant(async () => {
        await setLimit(1);
        await correlation.ensureIdentityFromUser(person(1));
        await identityModel.collection.insertOne({
          tenantId: TEST_TENANT_ID,
          profile: { email: 'racer@corp.example' },
          sources: [],
        });
        const inTransaction = { inTransaction: () => true } as unknown as ClientSession;

        await expect(
          reportIdentityLimitOvershoot(identityModel, events, TEST_TENANT_ID, inTransaction),
        ).resolves.toBeUndefined();
        expect(exceeded()).toEqual([]);
        expect(
          (await tenants().findOne({ tenantId: TEST_TENANT_ID }))?.identityLimitExceededAt,
        ).toBe(undefined);

        // The sweep (no session) raises it from the committed count
        await expect(
          reportIdentityLimitOvershoot(identityModel, events, TEST_TENANT_ID),
        ).resolves.toEqual({ limit: 1, count: 2, alerted: true });
      }));

    it('raises nothing for a create within the limit, or for a tenant without one', async () =>
      await withTestTenant(async () => {
        await setLimit(2);
        await correlation.ensureIdentityFromUser(person(1));
        await correlation.ensureIdentityFromUser(person(2));
        await tenants().deleteMany({});
        await correlation.ensureIdentityFromUser(person(3));

        expect(exceeded()).toEqual([]);
        await expect(
          reportIdentityLimitOvershoot(identityModel, events, TEST_TENANT_ID),
        ).resolves.toBeUndefined();
      }));
  });
});
