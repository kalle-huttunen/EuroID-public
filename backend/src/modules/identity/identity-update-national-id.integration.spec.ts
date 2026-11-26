/**
 * National IDs in identity updates (in-memory MongoDB, real mutation, correlation and hash
 * services, the real SCIM inbound controller and mapper).
 *
 * FOLLOWUPS 2026-11-25 (identity-mutation.service.ts:367 with :357-363): PATCH /identity/:id and
 * SCIM inbound updates wrote customAttributes into the profile without the national ID removal
 * ingest makes, and a changed custom attribute's previous value went into identity.updated (audit
 * log, analytics index, websocket). An update now loses the tenant's Hashed National ID field and
 * `hetu` before the write and before the event; with the rule and the secret their hash becomes
 * the correlationId, as at ingest.
 */
import { createHmac } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { ConflictException, Logger } from '@nestjs/common';
import type { Request } from 'express';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { SCIM_SCHEMAS } from '@shared/scim';
import { createMockLoggerFactory, createMockEventEmitter, closeTestDb, testDbUri } from '@testing';
import { IdentityMutationService } from './identity-mutation.service';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityQueryService } from './identity-query.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { IdentityService } from './identity.service';
import { IdentityController } from './identity.controller';
import type { UserEventService } from './user-event.service';
import type { IdentityEntitlementsService } from './identity-entitlements.service';
import type { AuditService } from '../audit/audit.service';
import { UpdateUserSchema } from './dtos/update-user.dto';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import type { CorrelationConfig } from './correlation/correlation-rule.interface';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { ScimUsersController } from '../scim-inbound/scim-users.controller';
import { ScimInboundMapper } from '../scim-inbound/scim-inbound.mapper';
import { ScimFilterService } from '../scim-inbound/scim-filter.service';

mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-a';
const SECRET = 'national-id-secret-for-tests-0123456789';
const HETU = '131085-999X';
const OTHER_HETU = '010190-123A';
const CUSTOM_FIELD = 'henkilotunnus';

/** HMAC(HMAC(secret, tenantId), normalized value), computed here apart from the service. */
function expectedHash(value: string): string {
  const tenantKey = createHmac('sha256', SECRET).update(TENANT).digest();
  return createHmac('sha256', tenantKey)
    .update(value.toUpperCase().replace(/[- ]/g, ''))
    .digest('hex');
}

describe('National IDs in identity updates (MongoDB)', () => {
  let moduleRef: TestingModule;
  let mutation: IdentityMutationService;
  let scim: ScimUsersController;
  let identityModel: Model<IdentityDocument>;
  const originalSecret = process.env.CORRELATION_HMAC_SECRET;
  const events = createMockEventEmitter();
  const correlationConfig = {
    getCorrelationConfig: jest.fn(),
    getPrimaryHrSourceName: jest.fn().mockResolvedValue(null),
    getHrPriorityConfig: jest.fn().mockResolvedValue(null),
    getHrPriorityFromBlueprint: jest.fn().mockResolvedValue(null),
    getHrConnectorsWithPriorityFromBlueprint: jest.fn().mockResolvedValue([]),
    getInstalledHrConnectorsWithPriority: jest.fn().mockResolvedValue([]),
    isHrSourceName: jest.fn().mockResolvedValue(false),
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
        CorrelationHashService,
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
    mutation = moduleRef.get(IdentityMutationService);
    const query = moduleRef.get(IdentityQueryService);
    // The controller without its guard (SCIM token), on the facade's two calls it makes
    const identityService = {
      findById: (id: string) => query.findById(id),
      update: (...args: Parameters<IdentityMutationService['update']>) => mutation.update(...args),
    } as unknown as IdentityService;
    scim = new ScimUsersController(
      identityService,
      new ScimInboundMapper(),
      new ScimFilterService(),
    );
    identityModel = moduleRef.get(getModelToken(Identity.name));
    await identityModel.syncIndexes(); // the unique correlationId index
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    process.env.CORRELATION_HMAC_SECRET = SECRET;
    events.emit.mockClear();
    events.emitAndWait.mockClear();
    useRules([
      { strategy: 'hashedNationalId', nationalIdSourceField: CUSTOM_FIELD },
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

  const seed = async (profile: Record<string, unknown> = {}, email = 'ada@corp.example') =>
    String(
      (
        await identityModel.create({
          tenantId: TENANT,
          profile: {
            email,
            firstName: 'Ada',
            lastName: 'Lovelace',
            status: 'ACTIVE',
            jobTitle: 'Analyst',
            ...profile,
          },
          sources: [],
          metadata: { version: 1 },
        })
      )._id,
    );
  /** PATCH /identity/:id as the controller makes it: the body parsed, HR-mastered fields refused. */
  const patch = (id: string, body: Record<string, unknown>) =>
    withTenantContext(TENANT, () =>
      mutation.update(id, UpdateUserSchema.parse(body), 'admin@corp.example', {
        refuseHrMastered: true,
      }),
    );
  const stored = async (id: string) =>
    (await identityModel
      .findById(id)
      .setOptions({ skipTenantScope: true })
      .lean()
      .exec()) as unknown as Identity & { profile: Record<string, unknown> };
  const updatedEvents = () =>
    events.emit.mock.calls.filter(([type]) => type === DomainEventType.IDENTITY_UPDATED);
  /** No spelling of either national ID in `value` (a stored document, the emitted events). */
  const expectNoNationalId = (value: unknown) => {
    const json = JSON.stringify(value).toUpperCase();
    for (const fragment of ['131085', '999X', '010190', '123A']) {
      expect(json).not.toContain(fragment);
    }
  };

  it('PATCH: stores no national ID, sets its hash as the correlationId, and identity.updated carries none', async () => {
    const id = await seed({ customAttributes: { site: 'HQ' } });

    await patch(id, {
      jobTitle: 'Lead',
      customAttributes: { site: 'HQ', [CUSTOM_FIELD]: HETU, hetu: OTHER_HETU },
    });

    const doc = await stored(id);
    expect(doc.profile.jobTitle).toBe('Lead');
    expect(doc.profile.customAttributes).toEqual({ site: 'HQ' });
    expect(doc.profile.correlationId).toBe(expectedHash(HETU));
    expectNoNationalId(doc);
    expect(updatedEvents()).toHaveLength(1);
    expectNoNationalId(events.emit.mock.calls);
  });

  it('PATCH without the secret: drops the national ID unhashed', async () => {
    delete process.env.CORRELATION_HMAC_SECRET;
    const id = await seed({ customAttributes: { site: 'HQ' } });

    await patch(id, { jobTitle: 'Lead', customAttributes: { site: 'HQ', [CUSTOM_FIELD]: HETU } });

    const doc = await stored(id);
    expect(doc.profile.customAttributes).toEqual({ site: 'HQ' });
    expect(doc.profile.correlationId).toBeUndefined();
    expectNoNationalId(doc);
    expectNoNationalId(events.emit.mock.calls);
  });

  it('PATCH of a national ID alone writes nothing and emits nothing', async () => {
    const id = await seed();
    useRules([{ strategy: 'email' }]); // no rule: hetu is removed all the same, nothing hashed

    await patch(id, { customAttributes: { hetu: HETU } });

    const doc = await stored(id);
    expect(doc.profile).not.toHaveProperty('customAttributes');
    expect(doc.profile.correlationId).toBeUndefined();
    expect(updatedEvents()).toHaveLength(0);
  });

  it('PATCH under the rule ignores a correlationId the body brings', async () => {
    const id = await seed();

    await patch(id, { jobTitle: 'Lead', correlationId: expectedHash(OTHER_HETU) });

    const doc = await stored(id);
    expect(doc.profile.jobTitle).toBe('Lead');
    expect(doc.profile.correlationId).toBeUndefined();
  });

  // The identity page sends every field back, the stored custom attributes included: the value
  // stored before the cleanup must not reach identity.updated as the previous value either
  it('PATCH of a profile that still holds a raw value: identity.updated carries none and the value goes', async () => {
    const id = await seed({ customAttributes: { [CUSTOM_FIELD]: HETU, site: 'HQ' } });

    await patch(id, { customAttributes: { [CUSTOM_FIELD]: HETU, site: 'Branch' } });

    const doc = await stored(id);
    expect(doc.profile.customAttributes).toEqual({ site: 'Branch' });
    const [[, , payload]] = updatedEvents();
    expect(payload.previousAttributes).toEqual({ customAttributes: { site: 'HQ' } });
    expectNoNationalId(events.emit.mock.calls);
  });

  // FOLLOWUPS 2026-11-25 (package F, identity.controller.ts:281-287): with syncToEntra the
  // controller recomputed the previous values from the stored profile without the removal, so a
  // value stored before the rule named its key reached identity.move_requested
  it('PATCH ?syncToEntra=true of a profile that still holds a raw value: identity.move_requested carries none', async () => {
    const id = await seed({ customAttributes: { [CUSTOM_FIELD]: HETU, site: 'HQ' } });
    const onion = moduleRef.get(IdentityOnionService);
    const identityService = {
      findIdentityById: (identityId: string) => onion.findIdentityById(identityId),
      updateWithChanges: (...args: Parameters<IdentityMutationService['updateWithChanges']>) =>
        mutation.updateWithChanges(...args),
    } as unknown as IdentityService;
    const controller = new IdentityController(
      identityService,
      {} as UserEventService,
      events as unknown as DomainEventEmitterService,
      {} as AuditService,
      {} as IdentityEntitlementsService,
    );

    await withTenantContext(TENANT, () =>
      controller.update(
        id,
        UpdateUserSchema.parse({ customAttributes: { [CUSTOM_FIELD]: HETU, site: 'Branch' } }),
        'true',
      ),
    );

    const moves = events.emitAndWait.mock.calls.filter(
      ([type]) => type === DomainEventType.IDENTITY_MOVE_REQUESTED,
    );
    expect(moves).toHaveLength(1);
    // The changes identity.updated reported (the hash became the correlationId)
    expect(moves[0][2]).toMatchObject({
      changedFields: ['customAttributes', 'correlationId'],
      previousAttributes: { customAttributes: { site: 'HQ' } },
    });
    expectNoNationalId(events.emitAndWait.mock.calls);
  });

  it('PATCH with the national ID of another identity: 409, nothing changed', async () => {
    await seed({ correlationId: expectedHash(HETU) }, 'grace@corp.example');
    const id = await seed();

    await expect(
      patch(id, { jobTitle: 'Lead', customAttributes: { [CUSTOM_FIELD]: HETU } }),
    ).rejects.toThrow(ConflictException);

    const doc = await stored(id);
    expect(doc.profile.jobTitle).toBe('Analyst');
    expect(doc.profile.correlationId).toBeUndefined();
    expect(updatedEvents()).toHaveLength(0);
  });

  // SCIM PATCH sent the identity's stored values back with the changed one; since hunt
  // 2026-11-25 (02 F13) it sends only the attributes its operations name, so a raw value stored
  // before the cleanup (migration 20261125000000-strip-raw-national-id removes those) is neither
  // written back nor reported
  it('SCIM PATCH: the stored raw value is not written back, and identity.updated carries none', async () => {
    const id = await seed({ customAttributes: { [CUSTOM_FIELD]: HETU, site: 'HQ' } });
    const req = { headers: {}, protocol: 'http', get: () => 'localhost' } as unknown as Request;

    await withTenantContext(TENANT, () =>
      scim.patch(
        id,
        {
          schemas: [SCIM_SCHEMAS.PATCH_OP],
          Operations: [{ op: 'replace', path: 'title', value: 'Lead' }],
        },
        req,
      ),
    );

    const doc = await stored(id);
    expect(doc.profile.jobTitle).toBe('Lead');
    // Untouched by the PATCH: the migration, not an IdP's title change, cleans stored data
    expect(doc.profile.customAttributes).toEqual({ [CUSTOM_FIELD]: HETU, site: 'HQ' });
    expect(updatedEvents()).toHaveLength(1);
    expect(updatedEvents()[0][2]).toMatchObject({ changedFields: ['jobTitle'] });
    expectNoNationalId(events.emit.mock.calls);
  });
});
