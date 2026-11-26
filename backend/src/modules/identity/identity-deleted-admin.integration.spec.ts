/**
 * Deleting a linked admin identity (PAM) ends its entry on the parent (in-memory MongoDB).
 * markAsDeleted is how offboarding (its own run, or the cascade from the parent's) and the last
 * target closed as removed manually delete an identity. A deleted admin identity holds no
 * privileged account, so the parent's `linkedAdminAccounts` entry for it must stop counting as an
 * active admin account (the Privileged access page, risk scoring): it becomes INACTIVE.
 * activateAdminAccount refuses a deleted admin identity, so the entry cannot turn ACTIVE again.
 */
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import {
  connectTestDb,
  clearTestDb,
  closeTestDb,
  createMockEventEmitter,
  createMockLoggerFactory,
  withTestTenant,
  TEST_TENANT_ID,
} from '@testing';
import { Identity, IdentitySchema, type IdentityDocument } from './schemas/identity.schema';
import { IdentityMutationService } from './identity-mutation.service';

mongoose.plugin(tenantPlugin);

type Ctor = ConstructorParameters<typeof IdentityMutationService>;
const SESSION_ENDED = new Date('2026-11-20T10:00:00Z');

describe('markAsDeleted of a linked admin identity (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  let service: IdentityMutationService;

  beforeAll(async () => {
    await connectTestDb();
    identityModel = (mongoose.models[Identity.name] ??
      mongoose.model(Identity.name, IdentitySchema)) as unknown as Model<IdentityDocument>;
    await identityModel.syncIndexes();
    // markAsDeleted reads and writes the identity collection and emits identity.deleted only
    service = new IdentityMutationService(
      identityModel as unknown as Ctor[0],
      {} as Ctor[1],
      {} as Ctor[2],
      createMockLoggerFactory().factory as unknown as LoggerFactoryService,
      createMockEventEmitter() as unknown as DomainEventEmitterService,
      {} as Ctor[5],
    );
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const create = (email: string, extra: Record<string, unknown> = {}) =>
    identityModel.create({
      tenantId: TEST_TENANT_ID,
      profile: { firstName: 'Eero', lastName: 'Admin', email, status: 'ACTIVE' },
      sources: [],
      ...extra,
    });

  /** A parent with an ACTIVE TIER_0 admin account and an INACTIVE TIER_2 one. */
  async function parentWithAdmins() {
    const active = await create('adm-eero.admin@corp.example', { adminTier: 'TIER_0' });
    const inactive = await create('adm2-eero.admin@corp.example', { adminTier: 'TIER_2' });
    const parent = await create('eero.admin@corp.example', {
      linkedAdminAccounts: [
        { identityId: String(active._id), adminTier: 'TIER_0', status: 'ACTIVE' },
        {
          identityId: String(inactive._id),
          adminTier: 'TIER_2',
          status: 'INACTIVE',
          deactivatedAt: SESSION_ENDED,
        },
      ],
    });
    const parentId = String(parent._id);
    await identityModel.updateMany(
      { _id: { $in: [active._id, inactive._id] } },
      { $set: { parentIdentityId: parentId } },
    );
    return { parentId, activeId: String(active._id), inactiveId: String(inactive._id) };
  }

  const entries = async (parentId: string) =>
    (await identityModel.findById(parentId).lean().exec())!.linkedAdminAccounts!;

  it("makes the deleted admin identity's ACTIVE entry on the parent INACTIVE", async () =>
    await withTestTenant(async () => {
      const { parentId, activeId } = await parentWithAdmins();

      await service.markAsDeleted(activeId);

      const [entry, other] = await entries(parentId);
      expect(entry.status).toBe('INACTIVE');
      expect(entry.deactivatedAt).toBeInstanceOf(Date);
      expect(other).toMatchObject({ status: 'INACTIVE', deactivatedAt: SESSION_ENDED });
      expect((await identityModel.findById(activeId).lean().exec())!.deletedAt).toBeInstanceOf(
        Date,
      );
    }));

  it('keeps when the session of an entry already INACTIVE ended', async () =>
    await withTestTenant(async () => {
      const { parentId, activeId, inactiveId } = await parentWithAdmins();

      await service.markAsDeleted(inactiveId);

      const [entry, other] = await entries(parentId);
      expect(other).toMatchObject({ status: 'INACTIVE', deactivatedAt: SESSION_ENDED });
      expect(entry).toMatchObject({ identityId: activeId, status: 'ACTIVE' });
    }));
});

/**
 * Hunt 2026-11-25 02 F14: markAsDeleted found the identity without `deletedAt: null`, so a retry
 * or a second call (offboarding's activity retried, a manual close after the run) rewrote
 * `deletedAt` and `deletedBy` and emitted identity.deleted again. `deletedAt` is what rehire
 * detection compares the HR start date against, so moving it later could hide a rehire.
 */
describe('markAsDeleted twice (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  let service: IdentityMutationService;
  const events = createMockEventEmitter();

  beforeAll(async () => {
    await connectTestDb();
    identityModel = (mongoose.models[Identity.name] ??
      mongoose.model(Identity.name, IdentitySchema)) as unknown as Model<IdentityDocument>;
    service = new IdentityMutationService(
      identityModel as unknown as Ctor[0],
      {} as Ctor[1],
      {} as Ctor[2],
      createMockLoggerFactory().factory as unknown as LoggerFactoryService,
      events as unknown as DomainEventEmitterService,
      {} as Ctor[5],
    );
  });

  afterEach(async () => {
    events.emit.mockClear();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('keeps the first deletion and reports it once', async () =>
    await withTestTenant(async () => {
      const identity = await identityModel.create({
        tenantId: TEST_TENANT_ID,
        profile: { firstName: 'Leo', lastName: 'Lahti', email: 'leo@corp.example' },
        sources: [],
      });
      const id = String(identity._id);

      const first = await service.markAsDeleted(id);
      const stored = await identityModel.findById(id).lean().exec();
      const again = await service.markAsDeleted(id, { actor: 'admin@corp.example', reason: 'x' });

      const after = await identityModel.findById(id).lean().exec();
      expect(after!.deletedAt).toEqual(stored!.deletedAt);
      expect(after!.deletedBy).toBe('offboarding-workflow');
      expect(again).toEqual({ _id: id, email: 'leo@corp.example', deletedAt: stored!.deletedAt });
      expect(first!.deletedAt).toEqual(stored!.deletedAt);
      const deleted = events.emit.mock.calls.filter(([type]) => type === 'identity.deleted');
      expect(deleted).toHaveLength(1);
    }));
});
