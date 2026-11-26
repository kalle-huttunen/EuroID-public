/**
 * IdentityProvisioningService.recordTargetAccountId (HX-E3): records an account id found or
 * created outside onboarding (an access request's read-only lookup, a bulk CREATE) as the
 * identity's target account, where liveTargetAccountId reads it. It writes that and nothing else:
 * no profile, no provisioning entry, no new identity. It never replaces a recorded id, never
 * records an account another identity has, and never records one for a system whose entry says
 * the account was removed. In-memory MongoDB with the real Identity schema and tenant plugin.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { closeTestDb, createMockLoggerFactory, testDbUri } from '@testing';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { IdentityProvisioningService, liveTargetAccountId } from './identity-provisioning.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const OBJECT_ID = '11111111-2222-3333-4444-555555555555';
const PROFILE = { firstName: 'Ada', lastName: 'Test', email: 'ada@a.example', jobTitle: 'Analyst' };

describe('IdentityProvisioningService.recordTargetAccountId (MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: IdentityProvisioningService;
  let identities: Model<IdentityDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
      ],
      providers: [
        IdentityProvisioningService,
        { provide: LoggerFactoryService, useValue: createMockLoggerFactory().factory },
      ],
    }).compile();
    service = moduleRef.get(IdentityProvisioningService);
    identities = moduleRef.get(getModelToken(Identity.name));
  });

  beforeEach(async () => {
    await identities.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const seed = async (fields: Record<string, unknown> = {}, tenantId = A) => {
    const doc = await withTenantContext(tenantId, () =>
      identities.create({ tenantId, profile: PROFILE, ...fields }),
    );
    return String(doc._id);
  };

  const stored = (id: string) =>
    identities.findById(id).setOptions({ skipTenantScope: true }).lean().exec();

  const record = (id: string, accountId = OBJECT_ID, tenantId = A) =>
    withTenantContext(tenantId, () => service.recordTargetAccountId(id, 'entra-id', accountId));

  it('records the account as the identity target source, and nothing else', async () => {
    const hr = { sourceName: 'csv-hr', externalId: 'E-1', sourceRole: 'primary-hr', rawData: {} };
    const id = await seed({ sources: [hr] });
    const before = await stored(id);

    expect(await record(id)).toBe('recorded');

    const after = await stored(id);
    expect(liveTargetAccountId(after!, 'entra-id')).toBe(OBJECT_ID);
    expect(after!.sources).toHaveLength(2);
    expect(after!.sources[1]).toMatchObject({
      sourceName: 'entra-id',
      externalId: OBJECT_ID,
      sourceRole: 'target',
    });
    // No profile write and no provisioning entry
    expect(after!.profile).toEqual(before!.profile);
    expect(after!.provisioning).toEqual(before!.provisioning);
  });

  it('keeps the provisioning entry it has as it is', async () => {
    const entry = { targetSystem: 'entra-id', status: 'SYNCED', writebackComplete: true };
    const id = await seed({ provisioning: [entry] });

    expect(await record(id)).toBe('recorded');

    const after = await stored(id);
    expect(after!.provisioning).toHaveLength(1);
    expect(after!.provisioning[0]).toMatchObject(entry);
    expect(liveTargetAccountId(after!, 'entra-id')).toBe(OBJECT_ID);
  });

  it('never replaces a recorded account id', async () => {
    const recorded = { sourceName: 'entra-id', externalId: 'obj-old', sourceRole: 'target' };
    const id = await seed({ sources: [recorded] });

    expect(await record(id)).toBe('other-recorded');
    expect(await record(id, 'obj-old')).toBe('already');
    expect((await stored(id))!.sources.map((s) => s.externalId)).toEqual(['obj-old']);
  });

  it('records none when the entry says the account was removed', async () => {
    const id = await seed({
      provisioning: [{ targetSystem: 'entra-id', status: 'DEPROVISIONED' }],
    });

    expect(await record(id)).toBe('removed');
    expect((await stored(id))!.sources).toEqual([]);
  });

  it('records none when another identity of the tenant has the account', async () => {
    await seed({
      profile: { ...PROFILE, email: 'other@a.example' },
      sources: [{ sourceName: 'entra-id', externalId: OBJECT_ID, sourceRole: 'target' }],
    });
    const id = await seed();

    expect(await record(id)).toBe('taken');
    expect((await stored(id))!.sources).toEqual([]);
  });

  it('records nothing for an identity of another tenant, or a deleted one', async () => {
    const other = await seed({}, B);
    expect(await record(other)).toBe('not-found');
    expect((await stored(other))!.sources).toEqual([]);

    const deleted = await seed({ deletedAt: new Date() });
    expect(await record(deleted)).toBe('not-found');
    expect((await stored(deleted))!.sources).toEqual([]);
  });
});
