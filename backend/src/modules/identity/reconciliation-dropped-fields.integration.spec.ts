/**
 * Golden Record merge when an HR source drops a field (in-memory MongoDB, real correlation and
 * reconciliation): the source that owns the field clears it; a source that does not own it (a
 * mastered field, a contract-critical field of the primary HR source, a target) cannot.
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
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import {
  createMockLoggerFactory,
  createMockEventEmitter,
  withTestTenant,
  TEST_TENANT_ID,
} from '@testing';

mongoose.plugin(tenantPlugin);

const PRIMARY = 'csv-hr';
const SECONDARY = 'json-hr';

/** An HR row as a connector maps it; `extra` keys are the ones under test. */
function hrRow(source: string, extra: Partial<StandardUserDto> = {}): StandardUserDto {
  return {
    sourceSystem: source,
    sourceUserId: `${source}-1`,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@corp.example',
    status: UserStatus.ACTIVE,
    ...extra,
  } as StandardUserDto;
}

describe('Golden Record merge: fields an HR source drops (MongoDB)', () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let reconciliation: ReconciliationService;
  let identityModel: Model<IdentityDocument>;
  const reconConfig = { getConfig: jest.fn(), getHrSourceTags: jest.fn() };

  beforeAll(async () => {
    const { factory: loggerFactory } = createMockLoggerFactory();
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
        { provide: ReconciliationConfigService, useValue: reconConfig },
        {
          provide: CorrelationConfigService,
          useValue: {
            getCorrelationConfig: jest.fn().mockResolvedValue({
              rules: [{ strategy: 'email' }],
              conflictAction: 'review',
              confidenceThreshold: 0.7,
            }),
            getPrimaryHrSourceName: jest.fn().mockResolvedValue(PRIMARY),
            getHrPriorityConfig: jest.fn().mockResolvedValue(null),
            getHrPriorityFromBlueprint: jest.fn().mockResolvedValue(null),
            isHrSourceName: jest.fn().mockResolvedValue(false),
            getHrConnectorsWithPriorityFromBlueprint: jest.fn().mockResolvedValue([
              { name: PRIMARY, ingestPriority: 1, contractTag: 'PRIMARY' },
              { name: SECONDARY, ingestPriority: 2 },
            ]),
            getInstalledHrConnectorsWithPriority: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: CorrelationRuleEngine,
          useValue: {
            findCorrelatedIdentity: jest.fn().mockImplementation(async (dto: StandardUserDto) => {
              const identity = await identityModel.findOne({ 'profile.email': dto.email }).exec();
              return { identity, matchedBy: identity ? 'email' : null, confidence: 1 };
            }),
          },
        },
        { provide: CorrelationHashService, useValue: { hash: (v: string) => `hash-${v}` } },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
      ],
    }).compile();
    correlation = moduleRef.get(IdentityCorrelationService);
    reconciliation = moduleRef.get(ReconciliationService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
  });

  beforeEach(() => {
    const config = {
      hrSourceTags: [PRIMARY, SECONDARY],
      sourcePriorityOrder: [PRIMARY, SECONDARY],
      contractCriticalFields: ['departmentName'],
      defaultMastery: {},
      targetIdKeys: ['objectId'],
    };
    reconConfig.getConfig.mockResolvedValue(config);
    reconConfig.getHrSourceTags.mockResolvedValue(config.hrSourceTags);
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  async function ingest(row: StandardUserDto): Promise<Record<string, unknown>> {
    const identity = await correlation.ensureIdentityFromUser(row);
    const stored = await identityModel.findById(identity?._id).lean().exec();
    return (stored?.profile ?? {}) as unknown as Record<string, unknown>;
  }

  it('clears an end date, job title and HR status the owning HR source no longer sends', async () =>
    await withTestTenant(async () => {
      await ingest(
        hrRow(PRIMARY, {
          endDate: new Date('2026-11-20'),
          jobTitle: 'Engineer',
          departmentName: 'R&D',
          customAttributes: { hrStatus: 'Terminated', costCenter: 'CC1' },
        }),
      );

      const profile = await ingest(
        hrRow(PRIMARY, { departmentName: 'R&D', customAttributes: { costCenter: 'CC1' } }),
      );

      expect(profile.endDate).toBeUndefined();
      expect(profile.jobTitle).toBeUndefined();
      expect(profile.departmentName).toBe('R&D');
      expect(profile.customAttributes).toEqual({ costCenter: 'CC1' });
    }));

  it('takes a changed HR custom attribute (it used to keep the first ingest value)', async () =>
    await withTestTenant(async () => {
      await ingest(hrRow(PRIMARY, { customAttributes: { hrStatus: 'Active' } }));
      const profile = await ingest(hrRow(PRIMARY, { customAttributes: { hrStatus: 'Left' } }));
      expect(profile.customAttributes).toEqual({ hrStatus: 'Left' });
    }));

  /**
   * The profile holds `value` that no source carries any more; `dropper` reports dropping it.
   * Nothing can refill the field, so only the ownership rule keeps it.
   */
  async function dropAndReconcile(
    field: string,
    dropper: string,
    options: { sourceRole?: 'target'; mastery?: Record<string, string> } = {},
  ): Promise<unknown> {
    const identity = await identityModel.create({
      tenantId: TEST_TENANT_ID,
      profile: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@corp.example',
        status: UserStatus.ACTIVE,
        [field]: 'kept',
      },
      sources: [
        { sourceName: PRIMARY, externalId: 'p-1', rawData: {}, sourceRole: 'primary-hr' },
        {
          sourceName: dropper,
          externalId: 'd-1',
          rawData: {},
          sourceRole: options.sourceRole ?? 'secondary-hr',
        },
      ],
      metadata: { version: 1, ...(options.mastery ? { mastery: options.mastery } : {}) },
    });
    await reconciliation.reconcile(identity, { dropped: { sourceName: dropper, fields: [field] } });
    const stored = await identityModel.findById(identity._id).lean().exec();
    return (stored?.profile as unknown as Record<string, unknown>)[field];
  }

  it('keeps a contract-critical field when a secondary HR source drops it', async () =>
    await withTestTenant(async () => {
      expect(await dropAndReconcile('departmentName', SECONDARY)).toBe('kept');
    }));

  it('keeps a mastered field when a source that does not master it drops it', async () =>
    await withTestTenant(async () => {
      expect(
        await dropAndReconcile('location', SECONDARY, { mastery: { location: PRIMARY } }),
      ).toBe('kept');
    }));

  it('clears a field the dropping HR source may write', async () =>
    await withTestTenant(async () => {
      expect(await dropAndReconcile('location', SECONDARY)).toBeUndefined();
    }));

  it('never lets a target clear a field', async () =>
    await withTestTenant(async () => {
      expect(await dropAndReconcile('jobTitle', 'entra-id', { sourceRole: 'target' })).toBe('kept');
    }));

  it('never lets a target clear a field, not even one it masters', async () =>
    await withTestTenant(async () => {
      expect(
        await dropAndReconcile('officeLocation', 'entra-id', {
          sourceRole: 'target',
          mastery: { officeLocation: 'entra-id' },
        }),
      ).toBe('kept');
    }));

  it('fills a field the owner dropped from another source allowed to write it', async () =>
    await withTestTenant(async () => {
      await ingest(hrRow(PRIMARY, { jobTitle: 'Engineer' }));
      await ingest(hrRow(SECONDARY, { jobTitle: 'Contractor' }));
      const profile = await ingest(hrRow(PRIMARY));
      expect(profile.jobTitle).toBe('Contractor');
    }));

  /** A target account (e.g. Entra) still holding `rawData` from before, linked to the identity. */
  async function linkTarget(email: string, rawData: Record<string, unknown>) {
    const identity = await identityModel.findOne({ 'profile.email': email }).exec();
    await correlation.pushSourceAndReconcile(String(identity!._id), 'entra-id', 'obj-1', rawData, {
      sourceRole: 'target',
    });
  }

  const storedProfile = async (email: string) =>
    ((await identityModel.findOne({ 'profile.email': email }).lean().exec())?.profile ??
      {}) as unknown as Record<string, unknown>;

  it("does not refill a dropped field from a target's stale copy, in that merge or later ones", async () =>
    await withTestTenant(async () => {
      await ingest(
        hrRow(PRIMARY, { jobTitle: 'Engineer', customAttributes: { costCenter: 'CC1' } }),
      );
      const staleCopy = {
        jobTitle: 'Engineer',
        customAttributes: { costCenter: 'CC1' },
        objectId: 'obj-1',
      };
      await linkTarget('ada@corp.example', staleCopy);

      const profile = await ingest(hrRow(PRIMARY));
      expect(profile.jobTitle).toBeUndefined();
      expect(profile.customAttributes).toEqual({ entraObjectId: 'obj-1' });

      // A later merge without any drop (the target writing back again) still does not refill it
      await linkTarget('ada@corp.example', staleCopy);
      const later = await storedProfile('ada@corp.example');
      expect(later.jobTitle).toBeUndefined();
      expect(later.customAttributes).toEqual({ entraObjectId: 'obj-1' });

      // The owner sends a value again: it is set and no longer blocked
      const back = await ingest(hrRow(PRIMARY, { jobTitle: 'Lead' }));
      expect(back.jobTitle).toBe('Lead');
      const doc = await identityModel.findOne({ 'profile.email': 'ada@corp.example' }).lean();
      expect(
        (doc?.metadata as { ownerClearedFields?: string[] } | undefined)?.ownerClearedFields,
      ).toEqual(['customAttributes.costCenter']);
    }));

  it('still lets a target fill a field no HR source ever cleared', async () =>
    await withTestTenant(async () => {
      await ingest(hrRow(PRIMARY));
      await linkTarget('ada@corp.example', { officeLocation: 'Espoo', objectId: 'obj-1' });
      expect((await storedProfile('ada@corp.example')).officeLocation).toBe('Espoo');
    }));

  it.each(['email', 'firstName', 'lastName'])(
    'never clears the required key %s through a drop',
    async (field) =>
      await withTestTenant(async () => {
        expect(await dropAndReconcile(field, SECONDARY)).toBe('kept');
      }),
  );

  it('never clears the status through a drop', async () =>
    await withTestTenant(async () => {
      const identity = await identityModel.create({
        tenantId: TEST_TENANT_ID,
        profile: { firstName: 'Ada', lastName: 'L', email: 'ada@corp.example', status: 'ACTIVE' },
        sources: [
          { sourceName: SECONDARY, externalId: 'd-1', rawData: {}, sourceRole: 'secondary-hr' },
        ],
        metadata: { version: 1 },
      });
      await reconciliation.reconcile(identity, {
        dropped: { sourceName: SECONDARY, fields: ['status'] },
      });
      const stored = await identityModel.findById(identity._id).lean().exec();
      expect(stored?.profile.status).toBe('ACTIVE');
    }));
});
