/**
 * Golden Record ownership (in-memory MongoDB, real correlation and reconciliation): a target
 * (Entra writeback) only fills empty profile fields, also in a tenant without a reconciliation
 * config, where HR sources are recognised from their connector; HR updates keep landing.
 * Reconcile also stores its metadata (version, primary HR source) on an existing identity.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
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
  closeTestDb,
  testDbUri,
} from '@testing';

mongoose.plugin(tenantPlugin);

const HR = 'csv-hr';
const SECOND_HR = 'json-api-hr';
const EMAIL = 'ada@corp.example';

function hrRow(source: string, extra: Partial<StandardUserDto> = {}): StandardUserDto {
  return {
    sourceSystem: source,
    sourceUserId: `${source}-1`,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: EMAIL,
    status: UserStatus.ACTIVE,
    ...extra,
  } as StandardUserDto;
}

describe('Golden Record ownership: targets cannot overwrite HR fields (MongoDB)', () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let reconciliation: ReconciliationService;
  let identityModel: Model<IdentityDocument>;
  const reconConfig = { getConfig: jest.fn(), getHrSourceTags: jest.fn() };
  const correlationConfig = {
    getCorrelationConfig: jest.fn().mockResolvedValue({
      rules: [{ strategy: 'email' }],
      conflictAction: 'review',
      confidenceThreshold: 0.7,
    }),
    getPrimaryHrSourceName: jest.fn().mockResolvedValue(null),
    getHrPriorityConfig: jest.fn().mockResolvedValue(null),
    getHrPriorityFromBlueprint: jest.fn().mockResolvedValue(null),
    getHrConnectorsWithPriorityFromBlueprint: jest.fn().mockResolvedValue([]),
    getInstalledHrConnectorsWithPriority: jest.fn().mockResolvedValue([]),
    // The registered HR connectors (manifest capability `ingest`): csv-hr and json-api-hr
    isHrSourceName: jest.fn(async (name: string) => name === HR || name === SECOND_HR),
  };

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
        CorrelationRuleEngine,
        { provide: ReconciliationConfigService, useValue: reconConfig },
        { provide: CorrelationConfigService, useValue: correlationConfig },
        { provide: CorrelationHashService, useValue: { hash: (v: string) => `hash-${v}` } },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
      ],
    }).compile();
    correlation = moduleRef.get(IdentityCorrelationService);
    reconciliation = moduleRef.get(ReconciliationService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  function withConfig(hrSourceTags: string[]) {
    const config = {
      hrSourceTags,
      sourcePriorityOrder: hrSourceTags,
      contractCriticalFields: [],
      defaultMastery: {},
      targetIdKeys: ['objectId'],
    };
    reconConfig.getConfig.mockResolvedValue(config);
    reconConfig.getHrSourceTags.mockResolvedValue(hrSourceTags);
  }

  function withoutConfig() {
    reconConfig.getConfig.mockResolvedValue(null);
    reconConfig.getHrSourceTags.mockResolvedValue([]);
  }

  const stored = async () => (await identityModel.findOne({}).lean().exec()) as unknown as Identity;
  const storedProfile = async () => (await stored()).profile as unknown as Record<string, unknown>;

  /** What the Entra writeback (writeback.activities.ts) pushes after provisioning. */
  async function entraWriteback(rawData: Record<string, unknown>) {
    const identity = await identityModel.findOne({}).exec();
    await correlation.pushSourceAndReconcile(String(identity!._id), 'entra-id', 'obj-1', rawData, {
      sourceRole: 'target',
    });
  }

  describe.each([
    ['with a reconciliation config naming the HR source', () => withConfig([HR])],
    ['without a reconciliation config', withoutConfig],
  ])('%s', (_label, setUp) => {
    beforeEach(() => setUp());

    it('keeps the HR values when a target writes back other values', async () =>
      await withTestTenant(async () => {
        await correlation.ensureIdentityFromUser(hrRow(HR, { jobTitle: 'Engineer' }));

        await entraWriteback({
          email: 'ada.lovelace@corp.onmicrosoft.example',
          jobTitle: 'Stale title',
          officeLocation: 'Espoo',
          objectId: 'obj-1',
        });

        const profile = await storedProfile();
        expect(profile.email).toBe(EMAIL);
        expect(profile.jobTitle).toBe('Engineer');
        expect(profile.officeLocation).toBe('Espoo'); // a target still fills an empty field
      }));

    it('keeps a profile value no source carries when a target writes back another', async () =>
      await withTestTenant(async () => {
        await correlation.ensureIdentityFromUser(hrRow(HR));
        // An admin edit (PATCH /identity/:id writes the profile directly, no source carries it)
        await identityModel.updateOne({}, { $set: { 'profile.costCenter': 'CC-1' } }).exec();

        await entraWriteback({ costCenter: 'CC-9', objectId: 'obj-1' });

        expect((await storedProfile()).costCenter).toBe('CC-1');
      }));

    it('lets the HR source change its fields after a target wrote back', async () =>
      await withTestTenant(async () => {
        await correlation.ensureIdentityFromUser(hrRow(HR, { jobTitle: 'Engineer' }));
        await entraWriteback({ jobTitle: 'Engineer', objectId: 'obj-1' });

        await correlation.ensureIdentityFromUser(
          hrRow(HR, { jobTitle: 'Lead', departmentName: 'R&D' }),
        );

        const profile = await storedProfile();
        expect(profile.jobTitle).toBe('Lead');
        expect(profile.departmentName).toBe('R&D');
      }));
  });

  describe('without a reconciliation config', () => {
    beforeEach(() => withoutConfig());

    it('stores the HR source as HR and a non-HR inbound source as a target', async () =>
      await withTestTenant(async () => {
        await correlation.ensureIdentityFromUser(hrRow(HR));
        await correlation.ensureIdentityFromUser(hrRow('manual-ui'));

        const roles = Object.fromEntries(
          (await stored()).sources.map((s) => [s.sourceName, s.sourceRole]),
        );
        expect(roles).toEqual({ [HR]: 'primary-hr', 'manual-ui': 'target' });
        expect(correlationConfig.isHrSourceName).toHaveBeenCalledWith('manual-ui');
      }));

    it('takes the HR values over an earlier non-HR inbound record of the same person', async () =>
      await withTestTenant(async () => {
        await correlation.ensureIdentityFromUser(hrRow('manual-ui', { jobTitle: 'Trainee' }));

        await correlation.ensureIdentityFromUser(hrRow(HR, { jobTitle: 'Engineer' }));

        expect((await storedProfile()).jobTitle).toBe('Engineer');
      }));
  });

  it('stores the metadata reconcile computes, also for an existing identity', async () =>
    await withTestTenant(async () => {
      withConfig([HR, SECOND_HR]);
      await correlation.ensureIdentityFromUser(hrRow(SECOND_HR));
      const minted = (await stored()).metadata;
      expect(minted?.primaryHrSource).toBe(SECOND_HR);
      expect(minted?.version).toBe(1);

      // The person gets a primary contract in the other HR source: it becomes the primary one
      await correlation.ensureIdentityFromUser(hrRow(HR, { contractType: 'primary' }));

      const after = (await stored()).metadata;
      expect(after?.primaryHrSource).toBe(HR);
      expect(after?.primaryContractExternalId).toBe(`${HR}-1`);
      expect(after?.version).toBe(2);
      expect(after?.correlationStatus).toBe('correlated');

      await reconciliation.reconcile((await identityModel.findOne({}).exec())!);
      expect((await stored()).metadata?.version).toBe(3);
    }));
});
