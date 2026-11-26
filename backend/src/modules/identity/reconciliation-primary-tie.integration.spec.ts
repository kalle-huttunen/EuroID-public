/**
 * Two HR sources that both claim the primary contract (in-memory MongoDB, real correlation and
 * reconciliation). Both Design studio source nodes keep the default contract tag PRIMARY, so
 * every record of either source carries contractType 'primary'. The primary was the first such
 * source in the identity's sources, i.e. the source that minted it, so it differed from person to
 * person, and since the primary wins every field no source masters (MULTI_HR_INGESTION.md,
 * Survivorship Rules) so did the values. The tie is broken by the configured source priority:
 * the connector's ingest priority, then the Recon Config source priority order, then the name.
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

const CSV = 'csv-hr';
const JSON_API = 'json-api-hr';

/** Each source's record of one person, matched across sources by the employee number. */
function hrRow(source: string, person: string): StandardUserDto {
  const fromCsv = source === CSV;
  return {
    sourceSystem: source,
    sourceUserId: `${source}-${person}`,
    employeeNumber: person,
    firstName: 'Ada',
    lastName: person,
    email: `${person.toLowerCase()}@corp.example`,
    status: UserStatus.ACTIVE,
    departmentName: fromCsv ? 'R&D' : 'Sales', // contract-critical
    location: fromCsv ? 'Helsinki' : 'Espoo', // neither contract-critical nor mastered
  } as StandardUserDto;
}

describe('Golden Record merge: two HR sources both tagged PRIMARY (MongoDB)', () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let identityModel: Model<IdentityDocument>;

  const reconConfig = {
    getConfig: jest.fn(),
    getHrSourceTags: jest.fn().mockResolvedValue([CSV, JSON_API]),
  };
  const priorities: Record<string, number> = {};
  const correlationConfig = {
    getCorrelationConfig: jest.fn().mockResolvedValue({
      rules: [{ strategy: 'employeeNumber' }],
      conflictAction: 'review',
      confidenceThreshold: 0.7,
    }),
    // Canvas only: no installed connector config names a primary
    getPrimaryHrSourceName: jest.fn().mockResolvedValue(null),
    getHrPriorityConfig: jest.fn().mockResolvedValue(null),
    // Both source nodes keep the Design studio default contract tag
    getHrPriorityFromBlueprint: jest.fn(async (name: string) => ({
      ingestPriority: priorities[name],
      contractTag: 'PRIMARY',
    })),
    getHrConnectorsWithPriorityFromBlueprint: jest.fn(async () =>
      [CSV, JSON_API]
        .map((name) => ({ name, ingestPriority: priorities[name], contractTag: 'PRIMARY' }))
        .sort((a, b) => a.ingestPriority - b.ingestPriority),
    ),
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

  it.each([
    ['the lower ingest priority', { [CSV]: 1, [JSON_API]: 2 }, [], CSV],
    [
      'the Recon Config source priority order when the ingest priorities are equal',
      { [CSV]: 1, [JSON_API]: 1 },
      [JSON_API, CSV],
      JSON_API,
    ],
    ['the source name when nothing else orders them', { [CSV]: 1, [JSON_API]: 1 }, [], CSV],
  ])(
    'gives every identity the same primary, by %s, whichever source minted it',
    async (_label, ingestPriorities, sourcePriorityOrder, expected) =>
      await withTestTenant(async () => {
        Object.assign(priorities, ingestPriorities);
        reconConfig.getConfig.mockResolvedValue({
          hrSourceTags: [CSV, JSON_API],
          sourcePriorityOrder,
          contractCriticalFields: ['departmentName'],
          defaultMastery: {},
          targetIdKeys: [],
        });
        // E-1 is minted by the JSON API feed, E-2 by the CSV feed
        await correlation.ensureIdentityFromUser(hrRow(JSON_API, 'E-1'));
        await correlation.ensureIdentityFromUser(hrRow(CSV, 'E-1'));
        await correlation.ensureIdentityFromUser(hrRow(CSV, 'E-2'));
        await correlation.ensureIdentityFromUser(hrRow(JSON_API, 'E-2'));

        const identities = (await identityModel.find({}).lean().exec()) as unknown as Identity[];
        expect(identities).toHaveLength(2);
        const expectedValues = hrRow(expected, 'any');
        for (const identity of identities) {
          expect(identity.sources.map((s) => s.contractType)).toEqual(['primary', 'primary']);
          expect(identity.metadata?.primaryHrSource).toBe(expected);
          // The primary wins the contract-critical field and every field no source masters
          expect(identity.profile.departmentName).toBe(expectedValues.departmentName);
          expect(identity.profile.location).toBe(expectedValues.location);
        }
      }),
  );
});
