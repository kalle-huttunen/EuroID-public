/**
 * The access baseline on the identity (in-memory MongoDB): recorded once from the policy profile
 * (the first SYNCED target), never overwritten by a later provisioning, advanced field by field
 * by a completed mover run, and only within the caller's tenant.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { IdentityOnionService } from './identity-onion.service';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { createMockLoggerFactory, TEST_TENANT_ID, closeTestDb, testDbUri } from '@testing';

mongoose.plugin(tenantPlugin);

const OTHER_TENANT = 'tenant-other';

describe('access baseline (MongoDB)', () => {
  let moduleRef: TestingModule;
  let onion: IdentityOnionService;
  let identityModel: Model<IdentityDocument>;

  beforeAll(async () => {
    const { factory: loggerFactory } = createMockLoggerFactory();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
      ],
      providers: [
        IdentityOnionService,
        {
          provide: ReconciliationConfigService,
          useValue: { getHrSourceTags: jest.fn().mockResolvedValue(['hr']) },
        },
        { provide: LoggerFactoryService, useValue: loggerFactory },
      ],
    }).compile();
    onion = moduleRef.get(IdentityOnionService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
  });

  afterAll(async () => {
    await moduleRef?.close();
    await closeTestDb();
  });

  afterEach(async () => {
    await identityModel.collection.deleteMany({});
  });

  async function seed(tenantId: string, profile: Record<string, unknown>): Promise<string> {
    return withTenantContext(tenantId, async () => {
      const doc = await identityModel.create({
        tenantId,
        profile: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@acme.test',
          mobilePhone: '+358 40 123 4567',
          status: 'ACTIVE',
          ...profile,
        },
        sources: [
          {
            sourceName: 'csv-hr',
            externalId: 'E-1',
            sourceRole: 'primary-hr',
            rawData: { jobTitle: 'Engineer', departmentName: profile.departmentName },
          },
        ],
      });
      return doc._id.toString();
    });
  }

  /** The stored baseline, read past the tenant plugin. */
  const baselineOf = async (id: string) =>
    (await identityModel.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))
      ?.accessBaseline as
      | { attributes: Record<string, unknown>; recordedBy: string; recordedAt: Date }
      | undefined;

  it('records the policy profile once, without names or contact data', async () => {
    const id = await seed(TEST_TENANT_ID, { departmentName: 'Sales', costCenter: 'CC-1' });

    await expect(
      withTenantContext(TEST_TENANT_ID, () => onion.recordInitialAccessBaseline(id)),
    ).resolves.toBe(true);
    const first = await baselineOf(id);
    expect(first?.recordedBy).toBe('provisioning');
    expect(first?.attributes).toMatchObject({
      departmentName: 'Sales',
      costCenter: 'CC-1',
      status: 'ACTIVE',
      contracts: [expect.objectContaining({ title: 'Engineer', department: 'Sales' })],
    });
    expect(JSON.stringify(first?.attributes)).not.toMatch(/Ada|Lovelace|acme\.test|4567/);

    // A later SYNCED target (an onboarding re-run that only adds) does not move it.
    await identityModel.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { 'profile.departmentName': 'Engineering' } },
    );
    await expect(
      withTenantContext(TEST_TENANT_ID, () => onion.recordInitialAccessBaseline(id)),
    ).resolves.toBe(false);
    expect((await baselineOf(id))?.attributes.departmentName).toBe('Sales');
  });

  it('a completed mover run advances only the attributes it applied', async () => {
    const id = await seed(TEST_TENANT_ID, { departmentName: 'Sales', costCenter: 'CC-1' });
    await withTenantContext(TEST_TENANT_ID, () => onion.recordInitialAccessBaseline(id));

    await withTenantContext(TEST_TENANT_ID, () =>
      onion.advanceAccessBaseline(id, { departmentName: 'Engineering', location: null }),
    );

    const baseline = await baselineOf(id);
    expect(baseline?.recordedBy).toBe('mover');
    expect(baseline?.attributes).toMatchObject({
      departmentName: 'Engineering',
      costCenter: 'CC-1', // not applied by this run: still pending for the preview
      location: null,
    });
  });

  it('a mover run on an identity without a baseline records a first one', async () => {
    const id = await seed(TEST_TENANT_ID, { departmentName: 'Engineering' });

    await withTenantContext(TEST_TENANT_ID, () =>
      onion.advanceAccessBaseline(id, { departmentName: 'Engineering' }),
    );

    expect((await baselineOf(id))?.attributes.departmentName).toBe('Engineering');
  });

  it("does not touch another tenant's identity", async () => {
    const id = await seed(OTHER_TENANT, { departmentName: 'Sales' });

    await expect(
      withTenantContext(TEST_TENANT_ID, () => onion.recordInitialAccessBaseline(id)),
    ).resolves.toBe(false);
    await withTenantContext(TEST_TENANT_ID, () =>
      onion.advanceAccessBaseline(id, { departmentName: 'Engineering' }),
    );

    expect(await baselineOf(id)).toBeUndefined();
  });
});
