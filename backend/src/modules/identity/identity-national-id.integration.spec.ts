/**
 * National ID correlation (in-memory MongoDB, real correlation, rule engine and hash service).
 *
 * FOLLOWUPS 2026-11-25 (correlation-hash.service.ts:37-45, identity-correlation.service.ts:125,
 * :141-150): without CORRELATION_HMAC_SECRET the national ID was hashed with a fixed key from the
 * source code, the raw value (a DTO field or customAttributes.<field>) was stored as given in
 * sources[].rawData and the profile's customAttributes, and a hashedNationalId rule without a
 * source field never matched (the engine hashed `hetu`, the service hashed nothing). The value is
 * now hashed only with the secret, in one place, and removed from the record before anything
 * holds it, whether or not it was hashed.
 */
import { createHmac } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Logger } from '@nestjs/common';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { RowHeldForConflictReview } from './conflict-held-rows';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import {
  BLUEPRINTS_PROVIDER_KEY,
  CorrelationConfigRegistry,
} from '../correlation-config/correlation-config.registry';
import type { IBlueprintConfigProvider } from '../correlation-config/correlation-config.interface';
import { CorrelationConfigUnavailableError } from '../correlation-config/correlation-config.errors';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import type { CorrelationConfig } from './correlation/correlation-rule.interface';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import { createMockLoggerFactory, createMockEventEmitter, closeTestDb, testDbUri } from '@testing';

mongoose.plugin(tenantPlugin);

const HR = 'csv-hr';
const SECOND_HR = 'json-api-hr';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const SECRET = 'national-id-secret-for-tests-0123456789';
/** The same HETU in two spellings, and a custom field name a tenant can configure. */
const HETU = '131085-999X';
const HETU_OTHER_SPELLING = '131085999x';
const CUSTOM_FIELD = 'henkilotunnus';

/** HMAC(HMAC(secret, tenantId), normalized HETU), computed here apart from the service. */
function expectedHash(tenantId: string): string {
  const tenantKey = createHmac('sha256', SECRET).update(tenantId).digest();
  return createHmac('sha256', tenantKey).update('131085999X').digest('hex');
}

function record(overrides: Partial<StandardUserDto> & Record<string, unknown>): StandardUserDto {
  return {
    sourceSystem: HR,
    sourceUserId: `${HR}-1`,
    firstName: 'Matti',
    lastName: 'Virtanen',
    email: 'matti.virtanen@corp.example',
    status: UserStatus.ACTIVE,
    ...overrides,
  } as StandardUserDto;
}

describe('National ID correlation (MongoDB)', () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let identityModel: Model<IdentityDocument>;
  const originalSecret = process.env.CORRELATION_HMAC_SECRET;
  const events = createMockEventEmitter();
  const reconConfig = {
    getConfig: jest.fn().mockResolvedValue(null),
    getHrSourceTags: jest.fn().mockResolvedValue([]),
  };
  const correlationConfig = {
    getCorrelationConfig: jest.fn(),
    getPrimaryHrSourceName: jest.fn().mockResolvedValue(null),
    getHrPriorityConfig: jest.fn().mockResolvedValue(null),
    getHrPriorityFromBlueprint: jest.fn().mockResolvedValue(null),
    getHrConnectorsWithPriorityFromBlueprint: jest.fn().mockResolvedValue([]),
    getInstalledHrConnectorsWithPriority: jest.fn().mockResolvedValue([]),
    isHrSourceName: jest.fn(async (name: string) => name === HR || name === SECOND_HR),
  };

  const useRules = (rules: CorrelationConfig['rules'], confidenceThreshold = 0.7) =>
    correlationConfig.getCorrelationConfig.mockResolvedValue({
      rules,
      conflictAction: 'review',
      confidenceThreshold,
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
        IdentityCorrelationService,
        IdentityOnionService,
        IdentityDeletedMatchService,
        ReconciliationService,
        CorrelationRuleEngine,
        CorrelationHashService,
        { provide: ReconciliationConfigService, useValue: reconConfig },
        { provide: CorrelationConfigService, useValue: correlationConfig },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    correlation = moduleRef.get(IdentityCorrelationService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
    await identityModel.syncIndexes(); // the unique correlationId and email indexes
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    process.env.CORRELATION_HMAC_SECRET = SECRET;
    useRules([
      { strategy: 'hashedNationalId', nationalIdSourceField: 'hetu' },
      { strategy: 'email' },
    ]);
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
  });

  afterAll(async () => {
    if (originalSecret === undefined) delete process.env.CORRELATION_HMAC_SECRET;
    else process.env.CORRELATION_HMAC_SECRET = originalSecret;
    jest.restoreAllMocks();
    await moduleRef.close();
    await closeTestDb();
  });

  const ingest = (dto: StandardUserDto, tenantId = TENANT_A) =>
    withTenantContext(tenantId, () => correlation.ensureIdentityFromUser(dto));
  const stored = async (id: unknown) =>
    (await identityModel
      .findById(String(id))
      .setOptions({ skipTenantScope: true })
      .lean()
      .exec()) as unknown as Identity & { profile: Record<string, unknown> };
  /** No spelling of the HETU anywhere in the stored document. */
  const expectNoNationalId = (doc: unknown) => {
    const json = JSON.stringify(doc).toUpperCase();
    expect(json).not.toContain('131085');
    expect(json).not.toContain('999X');
  };

  it('without a secret: no hash, the other rules still create and match, nothing raw is stored', async () => {
    delete process.env.CORRELATION_HMAC_SECRET;
    useRules([
      { strategy: 'hashedNationalId', nationalIdSourceField: 'hetu' },
      { strategy: 'employeeNumber' },
    ]);

    const first = await ingest(
      record({ employeeNumber: 'E-1', customAttributes: { hetu: HETU, costCenter: 'CC-1' } }),
    );
    const second = await ingest(
      record({
        sourceSystem: SECOND_HR,
        sourceUserId: `${SECOND_HR}-1`,
        email: 'matti.consultant@corp.example',
        employeeNumber: 'E-1',
        hetu: HETU_OTHER_SPELLING,
      }),
    );

    expect(String(second?._id)).toBe(String(first?._id)); // matched by the employee number
    const doc = await stored(first?._id);
    expect(doc.profile.correlationId).toBeUndefined();
    expect(doc.sources).toHaveLength(2);
    const hrSource = doc.sources.find((s) => s.sourceName === HR);
    expect(hrSource?.rawData.customAttributes).toEqual({ costCenter: 'CC-1' });
    expect(doc.sources.find((s) => s.sourceName === SECOND_HR)?.rawData).not.toHaveProperty('hetu');
    expect(doc.profile.customAttributes).toEqual({ costCenter: 'CC-1' });
    expectNoNationalId(doc);
  });

  it('with a secret: stores the HMAC under the tenant key, no raw value, and correlates other spellings', async () => {
    const first = await ingest(record({ customAttributes: { hetu: HETU } }));
    const second = await ingest(
      record({
        sourceSystem: SECOND_HR,
        sourceUserId: `${SECOND_HR}-7`,
        email: 'matti.consultant@corp.example',
        hetu: HETU_OTHER_SPELLING,
      }),
    );

    expect(String(second?._id)).toBe(String(first?._id));
    const doc = await stored(first?._id);
    expect(doc.profile.correlationId).toBe(expectedHash(TENANT_A));
    expect(doc.sources.map((s) => s.sourceName).sort()).toEqual([SECOND_HR, HR].sort());
    for (const source of doc.sources) expect(source.rawData).not.toHaveProperty('correlationId');
    expectNoNationalId(doc);
  });

  it('a rule without a source field reads hetu and correlates on the second ingest', async () => {
    useRules([{ strategy: 'hashedNationalId' }]);

    const first = await ingest(record({ customAttributes: { hetu: HETU } }));
    const second = await ingest(
      record({
        sourceSystem: SECOND_HR,
        sourceUserId: `${SECOND_HR}-2`,
        email: 'm.virtanen@corp.example',
        customAttributes: { hetu: HETU_OTHER_SPELLING },
      }),
    );

    expect(String(second?._id)).toBe(String(first?._id));
    const doc = await stored(first?._id);
    expect(doc.profile.correlationId).toBe(expectedHash(TENANT_A));
    expectNoNationalId(doc);
  });

  it('removes the configured field and hetu from a held conflict row', async () => {
    delete process.env.CORRELATION_HMAC_SECRET;
    // An employee number match (0.9) is below this threshold, and the email is taken: held
    useRules(
      [
        { strategy: 'hashedNationalId', nationalIdSourceField: CUSTOM_FIELD },
        { strategy: 'employeeNumber' },
      ],
      0.95,
    );
    const existing = await ingest(record({ employeeNumber: 'E-9' }));

    await expect(
      ingest(
        record({
          sourceSystem: SECOND_HR,
          sourceUserId: `${SECOND_HR}-9`,
          employeeNumber: 'E-9',
          customAttributes: { [CUSTOM_FIELD]: HETU, hetu: HETU_OTHER_SPELLING, site: 'HQ' },
        }),
      ),
    ).rejects.toBeInstanceOf(RowHeldForConflictReview);

    const doc = await stored(existing?._id);
    const held = (doc.metadata?.conflictDetails as { incomingSource?: { rawData?: unknown } })
      ?.incomingSource;
    expect(held?.rawData).toMatchObject({ customAttributes: { site: 'HQ' } });
    expectNoNationalId(doc);
  });

  // The settings name the field to remove: falling back to the default rule would store a custom
  // national ID field raw. The ingest fails instead, and the activity retries it.
  it('stores nothing when the correlation settings cannot be read', async () => {
    const registry = new CorrelationConfigRegistry();
    registry.register(BLUEPRINTS_PROVIDER_KEY, {
      getLatestBlueprint: async () => {
        throw new Error('MongoServerSelectionError: connection refused');
      },
    } as unknown as IBlueprintConfigProvider);
    const real = new CorrelationConfigService(registry);
    correlationConfig.getCorrelationConfig.mockImplementation(
      (...args: Parameters<CorrelationConfigService['getCorrelationConfig']>) =>
        real.getCorrelationConfig(...args),
    );

    await expect(
      ingest(record({ customAttributes: { [CUSTOM_FIELD]: HETU, costCenter: 'CC-1' } })),
    ).rejects.toBeInstanceOf(CorrelationConfigUnavailableError);

    expect(await identityModel.countDocuments({}, { skipTenantScope: true })).toBe(0);
  });

  it('gives two tenants different hashes for the same HETU', async () => {
    const a = await ingest(record({ customAttributes: { hetu: HETU } }), TENANT_A);
    const b = await ingest(record({ customAttributes: { hetu: HETU } }), TENANT_B);

    const hashA = (await stored(a?._id)).profile.correlationId;
    const hashB = (await stored(b?._id)).profile.correlationId;
    expect(hashA).toBe(expectedHash(TENANT_A));
    expect(hashB).toBe(expectedHash(TENANT_B));
    expect(hashA).not.toBe(hashB);
  });

  it('ignores a correlationId the record brings and matches by the hash it computes', async () => {
    const first = await ingest(record({ customAttributes: { hetu: HETU } }));
    const hash = (await stored(first?._id)).profile.correlationId as string;

    // Another person's record naming the first identity's hash, without a national ID
    const other = await ingest(
      record({
        sourceSystem: SECOND_HR,
        sourceUserId: `${SECOND_HR}-3`,
        firstName: 'Liisa',
        email: 'liisa@corp.example',
        correlationId: hash,
      }),
    );

    expect(String(other?._id)).not.toBe(String(first?._id));
    expect((await stored(other?._id)).profile.correlationId).toBeUndefined();
  });

  // Bulk provisioning hashes the national ID when the batch starts and passes only the hash
  // (BulkProvisioningService), so the workflow input holds no raw value
  it('matches on the hash bulk provisioning computed when the record carries no national ID', async () => {
    const first = await ingest(record({ customAttributes: { hetu: HETU } }));

    const bulk = await withTenantContext(TENANT_A, () =>
      correlation.ensureIdentityFromUser(
        record({
          sourceSystem: 'bulk',
          sourceUserId: 'bulk-1',
          email: 'matti.v@corp.example',
          correlationId: expectedHash(TENANT_A),
        }),
        undefined,
        undefined,
        undefined,
        { nationalIdHash: expectedHash(TENANT_A) },
      ),
    );

    expect(String(bulk?._id)).toBe(String(first?._id));
    expectNoNationalId(await stored(first?._id));
  });

  it('ignores a passed hash for a tenant without the rule', async () => {
    useRules([{ strategy: 'email' }]);

    const created = await withTenantContext(TENANT_A, () =>
      correlation.ensureIdentityFromUser(record({}), undefined, undefined, undefined, {
        nationalIdHash: 'hash-from-elsewhere',
      }),
    );

    expect((await stored(created?._id)).profile.correlationId).toBeUndefined();
  });
});
