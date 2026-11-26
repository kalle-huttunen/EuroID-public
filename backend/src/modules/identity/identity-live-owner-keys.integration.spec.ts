/**
 * IdentityQueryService.findLiveOwnerKeys on in-memory MongoDB (tenant plugin): orphan detection
 * asks once per page of target accounts which of their keys (UPN, mail, id, objectGUID) a live
 * identity has, instead of up to six findUserForReconciliation calls per account (r2-05 N11).
 * A key counts as findUserForReconciliation matches one (profile.email, profile.sourceUserId,
 * sources.externalId, _id), for an identity that is not soft-deleted and has a status other
 * than TERMINATED or DELETED.
 */
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { connectTestDb, clearTestDb, closeTestDb, createMockLoggerFactory } from '@testing';
import { IdentitySchema, type IdentityDocument } from './schemas/identity.schema';
import { IdentityQueryService } from './identity-query.service';

mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-a';

describe('IdentityQueryService.findLiveOwnerKeys (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  let query: IdentityQueryService;
  let adaId: string;

  beforeAll(async () => {
    await connectTestDb();
    mongoose.set('autoIndex', false);
    identityModel = mongoose.model(
      'Identity',
      IdentitySchema,
    ) as unknown as Model<IdentityDocument>;
    query = new IdentityQueryService(
      identityModel,
      createMockLoggerFactory().factory as unknown as LoggerFactoryService,
    );
    const seed = (tenantId: string, doc: Record<string, unknown>) =>
      withTenantContext(tenantId, () => identityModel.create({ tenantId, ...doc }));
    const ada = await seed(TENANT, {
      profile: { firstName: 'Ada', lastName: 'L', email: 'ada@corp.example', status: 'ACTIVE' },
      sources: [{ sourceName: 'ad', externalId: 'CN=Ada,OU=Staff,DC=corp' }],
    });
    adaId = String(ada._id);
    await seed(TENANT, {
      profile: {
        firstName: 'Bob',
        lastName: 'B',
        email: 'bob@corp.example',
        sourceUserId: 'EMP-2',
        status: 'PENDING',
      },
    });
    await seed(TENANT, {
      profile: { firstName: 'Leo', lastName: 'L', email: 'leo@corp.example', status: 'TERMINATED' },
    });
    await seed(TENANT, {
      profile: { firstName: 'Del', lastName: 'D', email: 'del@corp.example', status: 'ACTIVE' },
      deletedAt: new Date('2026-11-01'),
    });
    await seed('tenant-b', {
      profile: { firstName: 'Oth', lastName: 'O', email: 'other@corp.example', status: 'ACTIVE' },
    });
  });

  afterAll(async () => {
    await clearTestDb();
    await closeTestDb();
  });

  it('answers the keys a live identity of the tenant has, by every field the lookup reads', async () => {
    const owned = await withTenantContext(TENANT, () =>
      query.findLiveOwnerKeys([
        'ada@corp.example',
        'CN=Ada,OU=Staff,DC=corp',
        adaId,
        'EMP-2',
        'leo@corp.example',
        'del@corp.example',
        'other@corp.example',
        'nobody@corp.example',
      ]),
    );

    expect([...owned].sort()).toEqual(
      ['CN=Ada,OU=Staff,DC=corp', 'EMP-2', 'ada@corp.example', adaId].sort(),
    );
  });

  it('answers nothing for no keys, without a query', async () => {
    const find = jest.spyOn(identityModel, 'find');

    const owned = await withTenantContext(TENANT, () => query.findLiveOwnerKeys(['', '']));

    expect(owned.size).toBe(0);
    expect(find).not.toHaveBeenCalled();
    find.mockRestore();
  });
});
