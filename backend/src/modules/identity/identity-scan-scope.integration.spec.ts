/**
 * IdentityQueryService.findUsersPageForReconciliation with a reconciliation run's scan scope
 * (in-memory MongoDB, tenant plugin). The run counts its identities once
 * (getReconciliationUserCount), plans batches of skip/limit over that count, and each batch
 * fetches its pages: count and pages must use the same filter, or batches skip or repeat
 * identities.
 *
 * - includedDepartments: profile.departmentName or profile.departmentCode equals an entry,
 *   ignoring case.
 * - excludedUsers: an identity id matches _id, an email matches profile.email ignoring case.
 */
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { connectTestDb, clearTestDb, closeTestDb, createMockLoggerFactory } from '@testing';
import type { ReconciliationScope } from '@shared/utils/reconciliation-scope';
import { IdentitySchema, type IdentityDocument } from './schemas/identity.schema';
import { IdentityQueryService } from './identity-query.service';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-a';

describe('Reconciliation scan scope (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  let query: IdentityQueryService;
  /** _id of each seeded identity by its first name. */
  const ids: Record<string, string> = {};

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

  afterAll(async () => {
    await clearTestDb();
    await closeTestDb();
  });

  const seed = (
    firstName: string,
    profile: { departmentName?: string; departmentCode?: string; email?: string },
    tenantId = TENANT,
    deletedAt?: Date,
  ) =>
    withTenantContext(tenantId, async () => {
      const doc = await identityModel.create({
        tenantId,
        profile: {
          firstName,
          lastName: 'Test',
          email: profile.email ?? `${firstName.toLowerCase()}@example.com`,
          status: 'ACTIVE',
          ...(profile.departmentName ? { departmentName: profile.departmentName } : {}),
          ...(profile.departmentCode ? { departmentCode: profile.departmentCode } : {}),
        },
        ...(deletedAt ? { deletedAt } : {}),
      });
      ids[firstName] = String(doc._id);
    });

  beforeAll(async () => {
    await seed('Ada', { departmentName: 'Sales' });
    await seed('Bob', { departmentName: 'sales' });
    await seed('Cy', { departmentCode: 'SALES' });
    await seed('Dan', { departmentName: 'Sales', email: 'Dan.CEO@Example.com' });
    await seed('Eve', { departmentName: 'Sales' });
    await seed('Fay', { departmentName: 'R&D' });
    await seed('Gil', { departmentName: 'Sales Support' });
    await seed('Hal', {});
    await seed('Ivy', { departmentName: 'R&D' });
    await seed('Jon', { departmentName: 'Sales' }, TENANT, new Date());
    await seed('Kim', { departmentName: 'Sales' }, 'tenant-b');
  });

  const firstNames = (users: Record<string, unknown>[]) =>
    users.map((u) => String(u.firstName)).sort();

  /** What a run scans: the count, then pages of `pageSize` over it, as the batches fetch them. */
  const scan = (scope: ReconciliationScope | undefined, pageSize: number) =>
    withTenantContext(TENANT, async () => {
      const { total } = await query.findUsersPageForReconciliation(0, 1, scope);
      const seen: Record<string, unknown>[] = [];
      for (let skip = 0; skip < (total ?? 0); skip += pageSize) {
        const { users } = await query.findUsersPageForReconciliation(skip, pageSize, scope);
        seen.push(...users);
      }
      return { total, seen };
    });

  it('scans every live identity of the tenant without a scope', async () => {
    const { total, seen } = await scan(undefined, 3);

    expect(total).toBe(9);
    expect(firstNames(seen)).toEqual([
      'Ada',
      'Bob',
      'Cy',
      'Dan',
      'Eve',
      'Fay',
      'Gil',
      'Hal',
      'Ivy',
    ]);
  });

  it('counts and pages the same identities: each matching one once, across pages', async () => {
    const scope: ReconciliationScope = {
      includedDepartments: ['SALES'],
      excludedUsers: ['dan.ceo@example.COM', ids.Eve],
    };

    const { total, seen } = await scan(scope, 1);

    // departmentName or departmentCode, exact and ignoring case: not "Sales Support", not the
    // soft-deleted Jon, not tenant-b's Kim; Dan by his email, Eve by her id
    expect(firstNames(seen)).toEqual(['Ada', 'Bob', 'Cy']);
    expect(total).toBe(3);
    expect(new Set(seen.map((u) => String(u._id))).size).toBe(seen.length);
  });

  it('takes several departments, and excluded users without a department scope', async () => {
    const departments = await scan({ includedDepartments: ['r&d', 'Sales Support'] }, 2);
    expect(firstNames(departments.seen)).toEqual(['Fay', 'Gil', 'Ivy']);
    expect(departments.total).toBe(3);

    const excluded = await scan({ excludedUsers: [ids.Hal, 'ADA@example.com'] }, 4);
    expect(firstNames(excluded.seen)).toEqual(['Bob', 'Cy', 'Dan', 'Eve', 'Fay', 'Gil', 'Ivy']);
    expect(excluded.total).toBe(7);
  });

  it('takes entries as text: a regex character matches only itself', async () => {
    expect((await scan({ includedDepartments: ['.*'] }, 5)).total).toBe(0);
    expect((await scan({ excludedUsers: ['.*@example.com'] }, 5)).total).toBe(9);
  });
});
