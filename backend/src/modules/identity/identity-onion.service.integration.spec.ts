import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { IdentityOnionService } from './identity-onion.service';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { createMockLoggerFactory, TEST_TENANT_ID } from '@testing/test-helpers';

/**
 * buildProfileWithContractsForPolicy on a real hydrated document, as getIdentityByEmail
 * (mover, onboarding update path) passes it. Spreading a hydrated profile subdocument copies
 * Mongoose internals, so the policy engine saw a profile without email or department.
 */
describe('IdentityOnionService (Integration)', () => {
  let moduleRef: TestingModule;
  let identityModel: Model<IdentityDocument>;
  let service: IdentityOnionService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
      ],
      providers: [
        IdentityOnionService,
        {
          provide: ReconciliationConfigService,
          useValue: { getHrSourceTags: jest.fn().mockResolvedValue(['hr']) },
        },
        { provide: LoggerFactoryService, useValue: createMockLoggerFactory().factory },
      ],
    }).compile();
    service = moduleRef.get(IdentityOnionService);
    identityModel = moduleRef.get(getModelToken(Identity.name));

    await identityModel.create({
      tenantId: TEST_TENANT_ID,
      profile: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        departmentName: 'Engineering',
        jobTitle: 'Engineer',
      },
      sources: [
        {
          sourceName: 'csv-hr',
          externalId: 'EMP-1',
          sourceRole: 'primary-hr',
          rawData: { jobTitle: 'Engineer', departmentName: 'Engineering' },
        },
      ],
    });
  });

  afterAll(async () => {
    await moduleRef?.close();
    await closeTestDb();
  });

  it('keeps the profile fields of a hydrated document', async () => {
    const identity = await service.findIdentityByEmail('ada@example.com', {
      tenantId: TEST_TENANT_ID,
    });
    expect(identity).toBeInstanceOf(mongoose.Document);

    const profile = await service.buildProfileWithContractsForPolicy(identity!);

    expect(profile.email).toBe('ada@example.com');
    expect(profile.departmentName).toBe('Engineering');
    expect(profile.jobTitle).toBe('Engineer');
    expect(profile).not.toHaveProperty('$__');
    expect(profile.contracts).toEqual([
      expect.objectContaining({ id: 'EMP-1', title: 'Engineer', department: 'Engineering' }),
    ]);
  });

  it('gives the same profile for the lean object of the same identity', async () => {
    const hydrated = await identityModel.findOne({ 'profile.email': 'ada@example.com' }).exec();
    const lean = await identityModel.findOne({ 'profile.email': 'ada@example.com' }).lean().exec();

    const fromHydrated = await service.buildProfileWithContractsForPolicy(hydrated!);
    const fromLean = await service.buildProfileWithContractsForPolicy(
      lean as unknown as IdentityDocument,
    );

    expect(fromHydrated).toEqual(fromLean);
  });

  /**
   * The finders scope by the tenant they are given and leave out soft-deleted identities unless
   * asked. No tenant plugin here: the service's own filter is what keeps the tenants apart.
   */
  describe('finders (two tenants)', () => {
    const A = 'tenant-a';
    const B = 'tenant-b';
    let inA: string;
    let inB: string;
    let deletedInA: string;

    const seed = async (tenantId: string, email: string, externalId: string, deletedAt?: Date) =>
      String(
        (
          await identityModel.create({
            tenantId,
            profile: { firstName: 'Grace', lastName: 'Hopper', email },
            sources: [{ sourceName: 'workday', externalId }],
            ...(deletedAt ? { deletedAt } : {}),
          })
        )._id,
      );

    beforeAll(async () => {
      // Tenant B's identity first: a query without the tenant would find it first
      inB = await seed(B, 'grace@example.com', 'E1');
      inA = await seed(A, 'grace@example.com', 'E1');
      deletedInA = await seed(A, 'left@example.com', 'E9', new Date('2026-11-01'));
    });

    afterAll(async () => {
      await identityModel.deleteMany({ tenantId: { $in: [A, B] } });
    });

    it("findIdentityByEmail finds the asked tenant's identity, not another tenant's", async () => {
      const found = await service.findIdentityByEmail('grace@example.com', { tenantId: A });
      expect(String(found?._id)).toBe(inA);
      expect(found).toBeInstanceOf(mongoose.Document);
    });

    it('findIdentityByEmail returns null for an email no identity of the tenant has', async () => {
      expect(await service.findIdentityByEmail('nobody@example.com', { tenantId: A })).toBeNull();
    });

    it('findIdentityByEmail leaves out a soft-deleted identity unless asked to include it', async () => {
      expect(await service.findIdentityByEmail('left@example.com', { tenantId: A })).toBeNull();

      const found = await service.findIdentityByEmail('left@example.com', {
        tenantId: A,
        includeDeleted: true,
      });
      expect(String(found?._id)).toBe(deletedInA);
    });

    it('findIdentityById finds an identity only in its own tenant, and not once deleted', async () => {
      expect(String((await service.findIdentityById(inA, { tenantId: A }))?._id)).toBe(inA);
      expect(await service.findIdentityById(inB, { tenantId: A })).toBeNull();
      expect(await service.findIdentityById(deletedInA, { tenantId: A })).toBeNull();
    });

    it('findIdentityBySourceKey finds by source name and external id in the tenant given', async () => {
      expect(String((await service.findIdentityBySourceKey('workday', 'E1', A))?._id)).toBe(inA);
      expect(String((await service.findIdentityBySourceKey('workday', 'E1', B))?._id)).toBe(inB);
      expect(await service.findIdentityBySourceKey('workday', 'E9', A)).toBeNull();
      expect(await service.findIdentityBySourceKey('okta', 'E1', A)).toBeNull();
    });

    // An HR row or an account written back must not land on another person whose one source
    // has the name and another source the id
    it('findIdentityBySourceKey matches name and id within one source, not across two', async () => {
      await identityModel.create({
        tenantId: A,
        profile: { firstName: 'Ada', lastName: 'Split', email: 'split@example.com' },
        sources: [
          { sourceName: 'workday', externalId: 'E2' },
          { sourceName: 'okta', externalId: 'E3' },
        ],
      });

      expect(await service.findIdentityBySourceKey('workday', 'E3', A)).toBeNull();
    });

    it('findIdentityBySourceKey reads through the session it is given', async () => {
      // A query on an ended session is refused: proof the session reached the query
      const session = await identityModel.db.startSession();
      await session.endSession();

      await expect(
        service.findIdentityBySourceKey('workday', 'E1', A, { session }),
      ).rejects.toThrow(/session/i);
    });
  });
});
