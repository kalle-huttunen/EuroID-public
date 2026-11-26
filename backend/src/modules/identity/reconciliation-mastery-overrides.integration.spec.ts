/**
 * Field mastery overrides (in-memory MongoDB, real correlation, reconciliation and correlation
 * config service): the Brain's `correlationConfig.fieldMasteryOverrides`, read from the blueprint
 * the Design studio saved, replaces the tenant's default mastery for the fields it names. An
 * override used to make every reconcile of a record carrying such a field throw
 * ("Cannot read properties of undefined (reading 'toLowerCase')"), and its source list was
 * never consulted. A field's master writes it, a target included: a target the override or the
 * default mastery named used to only fill an empty field, so once the HR record had set it
 * nobody could change it.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import type { CorrelationConfig } from '@shared/types/correlation-config';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationConfigUnavailableError } from '../correlation-config/correlation-config.errors';
import {
  BLUEPRINTS_PROVIDER_KEY,
  CONNECTOR_CONFIG_PROVIDER_KEY,
  CorrelationConfigRegistry,
} from '../correlation-config/correlation-config.registry';
import type {
  IBlueprintConfigProvider,
  IConnectorConfigProvider,
} from '../correlation-config/correlation-config.interface';
import { CorrelationConfigSchema } from '../blueprints/dtos/blueprint-validation';
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
const TARGET = 'entra-id';

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

/**
 * The blueprint's `connectorConfigs['euroid-core']` with the Brain's correlation settings, in the
 * shape the Design studio saves (one owner per field, as a list) and POST /blueprints/save
 * validates (CorrelationConfigSchema).
 */
function euroidCore(fieldMasteryOverrides: Record<string, string[]>) {
  const correlationConfig = CorrelationConfigSchema.parse({
    rules: [{ strategy: 'email' }],
    conflictAction: 'review',
    confidenceThreshold: 0.7,
    fieldMasteryOverrides,
  }) as CorrelationConfig;
  return { correlationConfig };
}

describe('Golden Record merge: field mastery overrides of the Brain config (MongoDB)', () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let identityModel: Model<IdentityDocument>;

  /** The saved blueprint the correlation config is read from. */
  let canvas: Awaited<ReturnType<IBlueprintConfigProvider['getLatestBlueprint']>> = {};
  /** HR source -> the Golden Record fields its Design Studio source node masters. */
  let masteryFields: Record<string, string[]> = {};

  const blueprints: IBlueprintConfigProvider = {
    getLatestBlueprint: async () => canvas,
    getHrPriorityFromBlueprint: async (sourceName) =>
      masteryFields[sourceName] ? { masteryFields: masteryFields[sourceName] } : null,
    getHrConnectorsWithPriorityFromBlueprint: async () => [],
  };
  const connectors: IConnectorConfigProvider = {
    getPrimaryHrSourceName: async () => null,
    getHrPriorityConfig: async () => null,
    getInstalledHrConnectorsWithPriority: async () => [],
    isHrSourceName: async (name) => name === HR || name === SECOND_HR,
    getConfig: async () => null,
  };
  /** The tenant's reconciliation config: csv-hr is the default master of the job fields. */
  const baseConfig = {
    hrSourceTags: [HR, SECOND_HR],
    sourcePriorityOrder: [HR, SECOND_HR],
    contractCriticalFields: [],
    defaultMastery: { jobTitle: [HR], departmentName: [HR] } as Record<string, string[]>,
    targetIdKeys: ['objectId'],
  };
  const reconConfig = {
    getConfig: jest.fn(),
    getHrSourceTags: jest.fn().mockResolvedValue([HR, SECOND_HR]),
  };

  beforeAll(async () => {
    const { factory: loggerFactory } = createMockLoggerFactory();
    const registry = new CorrelationConfigRegistry();
    registry.register(BLUEPRINTS_PROVIDER_KEY, blueprints);
    registry.register(CONNECTOR_CONFIG_PROVIDER_KEY, connectors);
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
        CorrelationConfigService,
        { provide: CorrelationConfigRegistry, useValue: registry },
        { provide: ReconciliationConfigService, useValue: reconConfig },
        { provide: CorrelationHashService, useValue: { hash: (v: string) => `hash-${v}` } },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
      ],
    }).compile();
    correlation = moduleRef.get(IdentityCorrelationService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
  });

  beforeEach(() => {
    masteryFields = {};
    reconConfig.getConfig.mockResolvedValue(baseConfig);
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  function withOverrides(fieldMasteryOverrides: Record<string, string[]>) {
    canvas = { connectorConfigs: { 'euroid-core': euroidCore(fieldMasteryOverrides) } };
  }

  const storedProfile = async () =>
    ((await identityModel.findOne({}).lean().exec()) as unknown as Identity)
      .profile as unknown as Record<string, unknown>;

  /** Both HR sources deliver the same person, each with its own job data. */
  async function ingestBothHrSources() {
    await correlation.ensureIdentityFromUser(
      hrRow(HR, { jobTitle: 'Engineer', departmentName: 'R&D' }),
    );
    await correlation.ensureIdentityFromUser(
      hrRow(SECOND_HR, { jobTitle: 'Lead', departmentName: 'Sales' }),
    );
  }

  it('takes an overridden field from the source the override names, not the default master', async () =>
    await withTestTenant(async () => {
      withOverrides({ departmentName: [SECOND_HR] });

      // The first ingest used to throw: the identity has no metadata.mastery entry for the field
      await ingestBothHrSources();

      const profile = await storedProfile();
      expect(profile.departmentName).toBe('Sales'); // the override replaced the default [csv-hr]
      expect(profile.jobTitle).toBe('Engineer'); // not overridden: the default master still wins

      // The default master's later value does not replace it either
      await correlation.ensureIdentityFromUser(
        hrRow(HR, { jobTitle: 'Engineer', departmentName: 'Finance' }),
      );
      expect((await storedProfile()).departmentName).toBe('Sales');
    }));

  // Hunt 2026-11-25 r2-02 N2: an unreadable blueprint fell back to settings without the
  // overrides, and the profile was stored as the default mastery merges it
  it('stores nothing from a pushed source record when the correlation settings cannot be read', async () =>
    await withTestTenant(async () => {
      withOverrides({ departmentName: [SECOND_HR] });
      await ingestBothHrSources();
      const before = await identityModel.findOne({}).lean().exec();
      const id = String(before!._id);
      const read = jest
        .spyOn(blueprints, 'getLatestBlueprint')
        .mockRejectedValueOnce(new Error('connection reset'));

      await expect(
        correlation.pushSourceAndReconcile(id, TARGET, 'obj-1', { objectId: 'obj-1' }),
      ).rejects.toBeInstanceOf(CorrelationConfigUnavailableError);

      const after = await identityModel.findOne({}).lean().exec();
      expect(after!.profile.departmentName).toBe('Sales');
      expect(after!.sources.map((s) => s.sourceName)).toEqual([HR, SECOND_HR]);
      read.mockRestore();
    }));

  it('answers the HR owners of a field only from settings it could read', async () =>
    await withTestTenant(async () => {
      withOverrides({ departmentName: [SECOND_HR] });
      await ingestBothHrSources();
      const identity = (await identityModel.findOne({}).exec())!;
      const read = jest
        .spyOn(blueprints, 'getLatestBlueprint')
        .mockRejectedValueOnce(new Error('connection reset'));

      await expect(
        moduleRef.get(ReconciliationService).hrOwnersOf(identity, ['departmentName']),
      ).rejects.toBeInstanceOf(CorrelationConfigUnavailableError);
      read.mockRestore();
    }));

  it('keeps the explicit master of a field (its HR source node mastery) over the override', async () =>
    await withTestTenant(async () => {
      masteryFields = { [HR]: ['departmentName'] };
      withOverrides({ departmentName: [SECOND_HR] });

      await ingestBothHrSources();

      expect((await storedProfile()).departmentName).toBe('R&D');
    }));

  it('treats an empty override list as no override', async () =>
    await withTestTenant(async () => {
      withOverrides({ departmentName: [] });

      await ingestBothHrSources();

      expect((await storedProfile()).departmentName).toBe('R&D');
    }));

  /** The Entra writeback (writeback.activities.ts) after provisioning. */
  async function entraWriteback(rawData: Record<string, unknown>) {
    const identity = await identityModel.findOne({}).exec();
    await correlation.pushSourceAndReconcile(String(identity!._id), TARGET, 'obj-1', {
      ...rawData,
      objectId: 'obj-1',
    });
  }

  it('lets a target the override names set the field, and no other source change it', async () =>
    await withTestTenant(async () => {
      withOverrides({ officeLocation: [TARGET] });
      await correlation.ensureIdentityFromUser(hrRow(HR));

      await entraWriteback({ officeLocation: 'Espoo' });
      expect((await storedProfile()).officeLocation).toBe('Espoo');

      // The HR source is not among the field's sources, so its value does not land
      await correlation.ensureIdentityFromUser(hrRow(HR, { officeLocation: 'Helsinki' }));
      expect((await storedProfile()).officeLocation).toBe('Espoo');
    }));

  it('replaces the HR value with the value of a target the override names', async () =>
    await withTestTenant(async () => {
      withOverrides({ email: [TARGET] }); // IT controls the email (HUB_AND_SPOKE.md)
      await correlation.ensureIdentityFromUser(hrRow(HR)); // the HR record set the email

      await entraWriteback({ email: 'ada.lovelace@corp.onmicrosoft.example' });
      expect((await storedProfile()).email).toBe('ada.lovelace@corp.onmicrosoft.example');

      await correlation.ensureIdentityFromUser(hrRow(HR, { email: 'ada.l@corp.example' }));
      expect((await storedProfile()).email).toBe('ada.lovelace@corp.onmicrosoft.example');
    }));

  it('lets another source fill the field until the master the override names sends a value', async () =>
    await withTestTenant(async () => {
      withOverrides({ officeLocation: [TARGET] });
      await correlation.ensureIdentityFromUser(hrRow(HR));

      // No Entra account yet: the HR value fills the empty field
      await correlation.ensureIdentityFromUser(hrRow(HR, { officeLocation: 'Helsinki' }));
      expect((await storedProfile()).officeLocation).toBe('Helsinki');

      await entraWriteback({ officeLocation: 'Espoo' });
      expect((await storedProfile()).officeLocation).toBe('Espoo');
    }));

  it('takes a field of the default mastery from the first listed source that has a value', async () =>
    await withTestTenant(async () => {
      reconConfig.getConfig.mockResolvedValue({
        ...baseConfig,
        defaultMastery: { ...baseConfig.defaultMastery, email: [TARGET, HR] },
      });
      await correlation.ensureIdentityFromUser(hrRow(HR));

      // Entra ID has no value yet: the HR source, listed second, writes the email
      await correlation.ensureIdentityFromUser(hrRow(HR, { email: 'ada.l@corp.example' }));
      expect((await storedProfile()).email).toBe('ada.l@corp.example');

      // Entra ID, listed first, replaces it; the HR source no longer changes it
      await entraWriteback({ email: 'ada.lovelace@corp.onmicrosoft.example' });
      expect((await storedProfile()).email).toBe('ada.lovelace@corp.onmicrosoft.example');
      await correlation.ensureIdentityFromUser(hrRow(HR, { email: 'ada.x@corp.example' }));
      expect((await storedProfile()).email).toBe('ada.lovelace@corp.onmicrosoft.example');
    }));
});
