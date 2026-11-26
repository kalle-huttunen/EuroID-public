/**
 * IdentityQueryService.countByStatusInAllTenants (in-memory MongoDB, tenant plugin): the
 * euroid_identities_total gauge, counted when Prometheus scrapes, outside any tenant context.
 * Every tenant counts; a soft-deleted identity counts as DELETED whatever its profile status, one
 * without a status as UNKNOWN.
 */
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { connectTestDb, clearTestDb, closeTestDb, createMockLoggerFactory } from '@testing';
import { IdentitySchema, type IdentityDocument } from './schemas/identity.schema';
import { IdentityQueryService } from './identity-query.service';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

describe('Identities per status in every tenant (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  let query: IdentityQueryService;

  beforeAll(async () => {
    await connectTestDb();
    // Indexes are irrelevant here (and the correlationId partial index is rejected in memory)
    mongoose.set('autoIndex', false);
    identityModel = mongoose.model(
      'Identity',
      IdentitySchema,
    ) as unknown as Model<IdentityDocument>;
    query = new IdentityQueryService(
      identityModel,
      createMockLoggerFactory().factory as unknown as LoggerFactoryService,
    );
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const seed = (tenantId: string, name: string, status?: string, deletedAt?: Date) =>
    withTenantContext(tenantId, () =>
      identityModel.create({
        tenantId,
        profile: {
          firstName: name,
          lastName: 'Test',
          email: `${name}@${tenantId}.example`,
          ...(status ? { status } : {}),
        },
        ...(deletedAt ? { deletedAt } : {}),
      }),
    );

  it('counts each status across tenants, soft-deleted as DELETED, none as UNKNOWN', async () => {
    await seed('tenant-a', 'ada', 'ACTIVE');
    await seed('tenant-a', 'bob', 'ACTIVE');
    await seed('tenant-b', 'cy', 'ACTIVE');
    await seed('tenant-b', 'dan', 'TERMINATED');
    // Offboarded: the Golden Record is soft-deleted, its profile still says TERMINATED
    await seed('tenant-a', 'eve', 'TERMINATED', new Date());
    // The schema's default status
    await seed('tenant-b', 'fay');
    // A record stored without a status at all (written around Mongoose)
    await identityModel.collection.insertOne({
      tenantId: 'tenant-b',
      profile: { email: 'gil@tenant-b.example' },
    });

    expect(await query.countByStatusInAllTenants()).toEqual({
      ACTIVE: 3,
      TERMINATED: 1,
      DELETED: 1,
      PENDING: 1,
      UNKNOWN: 1,
    });
  });
});
