/**
 * Golden Record merge of several HR sources (in-memory MongoDB, real correlation and
 * reconciliation): a secondary HR source supplements. For a field that is neither
 * contract-critical nor mastered it writes only where the primary HR source carries no value, so
 * the primary's value wins whatever the order of ingestion (MULTI_HR_INGESTION.md, Survivorship
 * Rules). The merge used to let every HR source overwrite and ran the primary first, so the
 * lowest-priority HR source won names, email, location and custom attributes.
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

const PRIMARY = 'csv-hr';
const SECONDARY = 'json-api-hr';
const THIRD = 'workday';

/** The person's record in an HR source, matched across sources by the employee number. */
function hrRow(source: string, extra: Partial<StandardUserDto> = {}): StandardUserDto {
  return {
    sourceSystem: source,
    sourceUserId: `${source}-1`,
    employeeNumber: 'E-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@corp.example',
    status: UserStatus.ACTIVE,
    ...extra,
  } as StandardUserDto;
}

describe('Golden Record merge: a secondary HR source supplements the primary (MongoDB)', () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let identityModel: Model<IdentityDocument>;

  /** csv-hr is the primary HR source (contract tag PRIMARY); the others follow by priority. */
  const CONFIG = {
    hrSourceTags: [PRIMARY, SECONDARY, THIRD],
    sourcePriorityOrder: [PRIMARY, SECONDARY, THIRD],
    contractCriticalFields: ['departmentName'],
    defaultMastery: {} as Record<string, string[]>,
    targetIdKeys: ['objectId'],
  };
  const reconConfig = {
    getConfig: jest.fn().mockResolvedValue(CONFIG),
    getHrSourceTags: jest.fn().mockResolvedValue([PRIMARY, SECONDARY, THIRD]),
  };
  const correlationConfig = {
    getCorrelationConfig: jest.fn().mockResolvedValue({
      rules: [{ strategy: 'employeeNumber' }],
      conflictAction: 'review',
      confidenceThreshold: 0.7,
    }),
    getPrimaryHrSourceName: jest.fn().mockResolvedValue(PRIMARY),
    getHrPriorityConfig: jest.fn().mockResolvedValue(null),
    getHrPriorityFromBlueprint: jest.fn().mockResolvedValue(null),
    getHrConnectorsWithPriorityFromBlueprint: jest.fn().mockResolvedValue([
      { name: PRIMARY, ingestPriority: 1, contractTag: 'PRIMARY' },
      { name: SECONDARY, ingestPriority: 2 },
      { name: THIRD, ingestPriority: 3 },
    ]),
    getInstalledHrConnectorsWithPriority: jest.fn().mockResolvedValue([]),
    isHrSourceName: jest.fn().mockResolvedValue(true),
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
    identityModel = moduleRef.get(getModelToken(Identity.name));
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const storedProfile = async () => {
    expect(await identityModel.countDocuments({})).toBe(1); // both records are the same person
    return ((await identityModel.findOne({}).lean().exec()) as unknown as Identity)
      .profile as unknown as Record<string, unknown>;
  };

  const primaryRow = hrRow(PRIMARY, {
    location: 'Helsinki',
    customAttributes: { costCenter: 'CC1' },
  });
  const secondaryRow = hrRow(SECONDARY, {
    firstName: 'Adeline',
    email: 'ada.lovelace@subsidiary.example',
    location: 'Espoo',
    customAttributes: { costCenter: 'CC9', badge: 'B-7' },
  });

  it.each([
    ['the primary syncs first', [primaryRow, secondaryRow]],
    ['the secondary syncs first', [secondaryRow, primaryRow]],
  ])(
    'keeps the primary HR values when %s',
    async (_label, rows) =>
      await withTestTenant(async () => {
        for (const row of rows) await correlation.ensureIdentityFromUser({ ...row });

        const profile = await storedProfile();
        expect(profile.firstName).toBe('Ada');
        expect(profile.email).toBe('ada@corp.example');
        expect(profile.location).toBe('Helsinki');
        // Custom attributes key by key: the secondary adds only the key the primary has not
        expect(profile.customAttributes).toEqual({ costCenter: 'CC1', badge: 'B-7' });

        // A later change in the secondary source does not replace them either
        await correlation.ensureIdentityFromUser({ ...secondaryRow, location: 'Tampere' });
        expect((await storedProfile()).location).toBe('Helsinki');
      }),
  );

  it('takes a field from the secondary while the primary carries none, until the primary sends one', async () =>
    await withTestTenant(async () => {
      await correlation.ensureIdentityFromUser(hrRow(PRIMARY));
      await correlation.ensureIdentityFromUser(hrRow(SECONDARY, { location: 'Espoo' }));
      expect((await storedProfile()).location).toBe('Espoo');

      // The secondary's own change lands while the primary has no value
      await correlation.ensureIdentityFromUser(hrRow(SECONDARY, { location: 'Tampere' }));
      expect((await storedProfile()).location).toBe('Tampere');

      // The primary's value wins as soon as it has one
      await correlation.ensureIdentityFromUser(hrRow(PRIMARY, { location: 'Helsinki' }));
      expect((await storedProfile()).location).toBe('Helsinki');
    }));

  it('lets a higher-priority secondary HR source win over a lower one', async () =>
    await withTestTenant(async () => {
      await correlation.ensureIdentityFromUser(hrRow(PRIMARY));
      await correlation.ensureIdentityFromUser(hrRow(SECONDARY, { location: 'Espoo' }));
      await correlation.ensureIdentityFromUser(hrRow(THIRD, { location: 'Oulu' }));

      expect((await storedProfile()).location).toBe('Espoo');
    }));

  // Owner decision 2026-11-24: the primary HR contract always drives a contract-critical field.
  // A default mastery naming the secondary froze the field (the primary was not its master, the
  // secondary not the primary), and the secondary's source node mastery let the secondary win.
  // The config saves now refuse both (contract-critical-mastery.ts); one saved before is ignored.
  it.each([
    [
      'a default mastery naming the secondary',
      { defaultMastery: { departmentName: [SECONDARY] } },
      null,
    ],
    ["the secondary's source node mastery", {}, { masteryFields: ['departmentName'] }],
  ])(
    'takes a contract-critical field from the primary whatever %s says',
    async (_label, config, secondaryNode) =>
      await withTestTenant(async () => {
        reconConfig.getConfig.mockResolvedValue({ ...CONFIG, ...config });
        correlationConfig.getHrPriorityFromBlueprint.mockImplementation(async (name: string) =>
          name === SECONDARY ? secondaryNode : null,
        );
        try {
          await correlation.ensureIdentityFromUser(hrRow(PRIMARY, { departmentName: 'R&D' }));
          await correlation.ensureIdentityFromUser(hrRow(SECONDARY, { departmentName: 'Sales' }));
          expect((await storedProfile()).departmentName).toBe('R&D');

          await correlation.ensureIdentityFromUser(hrRow(PRIMARY, { departmentName: 'Finance' }));
          expect((await storedProfile()).departmentName).toBe('Finance');
        } finally {
          reconConfig.getConfig.mockResolvedValue(CONFIG);
          correlationConfig.getHrPriorityFromBlueprint.mockResolvedValue(null);
        }
      }),
  );
});
