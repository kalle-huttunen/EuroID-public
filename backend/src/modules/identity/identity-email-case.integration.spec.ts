/**
 * Email case (in-memory MongoDB, real correlation, rule engine, reconcile and mutation services).
 *
 * Hunt 2026-11-25 r2-02 N1: identity email matching was case-sensitive everywhere. HR sends
 * `jane.doe@x.fi` while the IdP sends `Jane.Doe@x.fi`; the email rule found nothing, the unique
 * email index treated the two as different, and a second identity was minted for the same person.
 * Every write now stores the email trimmed and lower-cased (shared/utils/email.ts), and every
 * lookup asks for that form. Two live identities whose stored emails differ only in case (from
 * before this release) keep their casing at a sync: the migration raises them for a merge.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import {
  createMockLoggerFactory,
  createMockEventEmitter,
  withTestTenant,
  closeTestDb,
  testDbUri,
  TEST_TENANT_ID,
} from '@testing';
import { IdentityMutationService } from './identity-mutation.service';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityQueryService } from './identity-query.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { RowHeldForConflictReview } from './conflict-held-rows';
import { EMAIL_CONFLICT_INDEX, emailCaseConflictFilter } from './identity-email-case-conflict';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import type { CorrelationConfig } from './correlation/correlation-rule.interface';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { CreateUserSchema } from './dtos/create-user.dto';
import { UpdateUserSchema } from './dtos/update-user.dto';

mongoose.plugin(tenantPlugin);

const HR = 'csv-hr';
const IDP = 'okta';

const hrRow = {
  sourceSystem: HR,
  sourceUserId: 'E-1',
  employeeNumber: 'E-1',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane.doe@corp.example',
  status: UserStatus.ACTIVE,
} as StandardUserDto;

describe('Identity email case (MongoDB)', () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let mutation: IdentityMutationService;
  let onion: IdentityOnionService;
  let identityModel: Model<IdentityDocument>;
  const events = createMockEventEmitter();
  const correlationConfig = {
    getCorrelationConfig: jest.fn(),
    getPrimaryHrSourceName: jest.fn().mockResolvedValue(null),
    getHrPriorityConfig: jest.fn().mockResolvedValue(null),
    getHrPriorityFromBlueprint: jest.fn().mockResolvedValue(null),
    getHrConnectorsWithPriorityFromBlueprint: jest.fn().mockResolvedValue([]),
    getInstalledHrConnectorsWithPriority: jest.fn().mockResolvedValue([]),
    isHrSourceName: jest.fn(async (name: string) => name === HR),
  };
  const useRules = (rules: CorrelationConfig['rules']) =>
    correlationConfig.getCorrelationConfig.mockResolvedValue({
      rules,
      conflictAction: 'review',
      confidenceThreshold: 0.7,
    });

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
        IdentityMutationService,
        IdentityCorrelationService,
        IdentityQueryService,
        IdentityOnionService,
        IdentityDeletedMatchService,
        ReconciliationService,
        CorrelationRuleEngine,
        { provide: CorrelationHashService, useValue: { hash: (v: string) => `hash-${v}` } },
        {
          provide: ReconciliationConfigService,
          useValue: {
            getConfig: jest.fn().mockResolvedValue(null),
            getHrSourceTags: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: CorrelationConfigService, useValue: correlationConfig },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    correlation = moduleRef.get(IdentityCorrelationService);
    mutation = moduleRef.get(IdentityMutationService);
    onion = moduleRef.get(IdentityOnionService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
    await identityModel.syncIndexes(); // the unique email index
  });

  beforeEach(() => {
    events.emit.mockClear();
    useRules([{ strategy: 'email' }]);
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const storedEmails = async () =>
    (await identityModel.find({}).sort({ _id: 1 }).lean().exec()).map((i) => i.profile.email);

  it('correlates an IdP record whose email differs only in case into the HR identity', async () =>
    await withTestTenant(async () => {
      const hr = await correlation.ensureIdentityFromUser({ ...hrRow });
      const idp = await correlation.ensureIdentityFromUser({
        ...hrRow,
        sourceSystem: IDP,
        sourceUserId: 'okta-1',
        email: 'Jane.Doe@Corp.Example',
      });

      expect(String(idp!._id)).toBe(String(hr!._id));
      expect(await storedEmails()).toEqual(['jane.doe@corp.example']);
      const sources = (await identityModel.findById(hr!._id).lean().exec())!.sources;
      expect(sources.map((s) => s.sourceName)).toEqual([HR, IDP]);
    }));

  it('stores a minted identity email trimmed and lower-cased', async () =>
    await withTestTenant(async () => {
      await correlation.ensureIdentityFromUser({ ...hrRow, email: '  Jane.Doe@Corp.Example ' });

      expect(await storedEmails()).toEqual(['jane.doe@corp.example']);
    }));

  it('holds a record no rule matches when a live identity has its email in another case', async () =>
    await withTestTenant(async () => {
      useRules([{ strategy: 'employeeNumber' }]);
      const hr = await correlation.ensureIdentityFromUser({ ...hrRow });

      await expect(
        correlation.ensureIdentityFromUser({
          ...hrRow,
          sourceSystem: IDP,
          sourceUserId: 'okta-1',
          employeeNumber: 'X-9',
          email: 'JANE.DOE@corp.example',
        }),
      ).rejects.toBeInstanceOf(RowHeldForConflictReview);
      expect(await storedEmails()).toEqual(['jane.doe@corp.example']);
      const flagged = await identityModel.findById(hr!._id).lean().exec();
      expect(flagged?.metadata?.conflictDetails?.incomingSource?.externalId).toBe('okta-1');
    }));

  it('finds an identity by email in any case', async () =>
    await withTestTenant(async () => {
      const hr = await correlation.ensureIdentityFromUser({ ...hrRow });

      const found = await onion.findIdentityByEmail('Jane.DOE@corp.example ');
      expect(String(found?._id)).toBe(String(hr!._id));
    }));

  it('stores an email a PATCH changes lower-cased', async () =>
    await withTestTenant(async () => {
      const hr = await correlation.ensureIdentityFromUser({ ...hrRow });

      await mutation.update(String(hr!._id), { email: 'Jane.Smith@Corp.Example' });
      expect(await storedEmails()).toEqual(['jane.smith@corp.example']);
    }));

  /** An identity stored before this release, with its email in the case its source sent. */
  const legacy = (email: string, sourceName: string, externalId: string) => ({
    tenantId: TEST_TENANT_ID,
    profile: { ...hrRow, email, sourceSystem: sourceName, sourceUserId: externalId },
    sources: [{ sourceName, externalId, rawData: { ...hrRow, email }, sourceRole: 'target' }],
    controls: { isLoginDisabled: false },
    metadata: { version: 1, correlationStatus: 'correlated' },
  });
  const syncOf = (sourceSystem: string, sourceUserId: string, email: string) =>
    correlation.ensureIdentityFromUser({
      ...hrRow,
      sourceSystem,
      sourceUserId,
      email,
      jobTitle: 'Engineer',
    });

  it('answers 409 when a PATCH gives an identity the email another live identity has', async () =>
    await withTestTenant(async () => {
      await correlation.ensureIdentityFromUser({ ...hrRow });
      const other = await correlation.ensureIdentityFromUser({
        ...hrRow,
        sourceUserId: 'E-2',
        employeeNumber: 'E-2',
        email: 'john.roe@corp.example',
      });

      await expect(
        mutation.update(String(other!._id), { email: 'Jane.Doe@corp.example' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await storedEmails()).toEqual(['jane.doe@corp.example', 'john.roe@corp.example']);
    }));

  it('lower-cases a stored email at the next sync when no other identity has that form', async () =>
    await withTestTenant(async () => {
      await identityModel.collection.insertOne(legacy('Jane.Doe@corp.example', IDP, 'okta-1'));

      await syncOf(IDP, 'okta-1', 'Jane.Doe@corp.example');
      expect(await storedEmails()).toEqual(['jane.doe@corp.example']);
    }));

  it('keeps the casing of a stored email while another live identity has it lower-cased', async () =>
    await withTestTenant(async () => {
      // Two identities stored before this release: the unique index treats them as different
      await identityModel.collection.insertMany([
        legacy('jane.doe@corp.example', IDP, 'okta-1'),
        legacy('JANE.DOE@corp.example', 'github', 'gh-1'),
      ]);

      // A sync of the second one's record must not fail on the unique email index
      await syncOf('github', 'gh-1', 'JANE.DOE@corp.example');
      expect(await storedEmails()).toEqual(['jane.doe@corp.example', 'JANE.DOE@corp.example']);
    }));

  /**
   * A pair stored before this release with one address in two cases and no lower-case member,
   * raised by migration 20261125000003 as a correlation conflict on the first one.
   */
  const raisedPair = async () => {
    const first = legacy('Jane.Doe@corp.example', IDP, 'okta-1');
    const second = legacy('JANE.DOE@corp.example', 'github', 'gh-1');
    const { insertedIds } = await identityModel.collection.insertMany([first, second]);
    await identityModel.collection.updateOne(
      { _id: insertedIds[0] },
      {
        $set: {
          'metadata.correlationConflict': true,
          'metadata.requiresReview': true,
          'metadata.conflictDetails': {
            matchedBy: 'email',
            matchedValue: 'Jane.Doe@corp.example',
            confidence: 0,
            incomingIdentityId: String(insertedIds[1]),
          },
        },
      },
    );
    return String(insertedIds[0]);
  };

  // Hunt 2026-11-25 follow-up of r2-02 N1: the exact lookups missed such a pair, so a new record
  // of that person minted a third identity
  it('holds a new record of a raised mixed-case pair on its conflict instead of minting', async () =>
    await withTestTenant(async () => {
      const holder = await raisedPair();

      await expect(
        correlation.ensureIdentityFromUser({
          ...hrRow,
          sourceUserId: 'E-9',
          email: 'jane.doe@corp.example',
        }),
      ).rejects.toBeInstanceOf(RowHeldForConflictReview);
      expect(await storedEmails()).toEqual(['Jane.Doe@corp.example', 'JANE.DOE@corp.example']);
      // The migration's conflict stays as it was, for the merge
      const flagged = await identityModel.findById(holder).lean().exec();
      expect(flagged?.metadata?.conflictDetails?.matchedValue).toBe('Jane.Doe@corp.example');
    }));

  it('looks the raised pair up through the open-conflict index, not a scan of the identities', async () =>
    await withTestTenant(async () => {
      await raisedPair();
      const plan = JSON.stringify(
        await identityModel.collection
          .find(emailCaseConflictFilter(TEST_TENANT_ID, 'jane.doe@corp.example'))
          .explain('queryPlanner'),
      );

      expect(plan).toContain(EMAIL_CONFLICT_INDEX);
      expect(plan).not.toContain('COLLSCAN');
    }));

  it('normalizes the email of the POST and PATCH /identity bodies', () => {
    const body = { ...hrRow, email: ' Jane.Doe@Corp.Example' };
    expect(CreateUserSchema.parse(body).email).toBe('jane.doe@corp.example');
    expect(UpdateUserSchema.parse({ email: 'Jane.Doe@Corp.Example ' }).email).toBe(
      'jane.doe@corp.example',
    );
  });
});
