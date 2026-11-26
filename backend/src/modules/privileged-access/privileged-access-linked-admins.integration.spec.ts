/**
 * The linked admin identities offboarding a person cascades to (in-memory MongoDB, through the
 * Temporal activity): every live admin identity of the person, whether it points at the person
 * (`parentIdentityId`) or the person's `linkedAdminAccounts` entry names it, in the person's tenant
 * only, oldest first, with its email (the child offboarding's input). Each one's running
 * privileged session is told to end first, so no session enables an account the offboarding
 * removes.
 */
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import type { PamConfig } from '@infrastructure/config/pam.config';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import {
  connectTestDb,
  clearTestDb,
  closeTestDb,
  createMockEventEmitter,
  createMockLoggerFactory,
} from '@testing';
import {
  Identity,
  IdentitySchema,
  type IdentityDocument,
} from '../identity/schemas/identity.schema';
import type { IdentityService } from '../identity/identity.service';
import { PrivilegedAccessActivities } from '../../activities/privileged-access.activities';
import { PrivilegedAccessService } from './privileged-access.service';
import type { PrivilegedSessionService } from './privileged-session.service';
import type { PamSessionStateService } from './pam-session-state.service';
import type { PamSessionService } from './pam-session.service';

mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';

describe('getLinkedAdminIdentities (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  let activities: PrivilegedAccessActivities;
  const sessions = { endIfRunning: jest.fn().mockResolvedValue(false) };

  beforeAll(async () => {
    await connectTestDb();
    identityModel = (mongoose.models[Identity.name] ??
      mongoose.model(Identity.name, IdentitySchema)) as unknown as Model<IdentityDocument>;
    await identityModel.syncIndexes();
    activities = new PrivilegedAccessActivities(
      new PrivilegedAccessService(
        identityModel,
        {} as IdentityService,
        createMockEventEmitter() as unknown as DomainEventEmitterService,
        createMockLoggerFactory().factory as unknown as LoggerFactoryService,
        {} as PamConfig,
        {} as PrivilegedSessionService,
      ),
      {} as PamSessionStateService,
      sessions as unknown as PamSessionService,
    );
  });

  afterEach(async () => {
    sessions.endIfRunning.mockClear();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const identity = (tenantId: string, email: string, extra: Record<string, unknown> = {}) =>
    withTenantContext(tenantId, () =>
      identityModel.create({
        tenantId,
        profile: { firstName: 'Eero', lastName: 'Admin', email, status: UserStatus.ACTIVE },
        sources: [],
        ...extra,
      }),
    );

  it('returns the live admin identities that point at the person or that its entries name', async () => {
    const parent = await identity(TENANT, 'eero@corp.example');
    const parentId = String(parent._id);
    const both = await identity(TENANT, 'adm0-eero@corp.example', { parentIdentityId: parentId });
    const entryOnly = await identity(TENANT, 'adm1-eero@corp.example');
    const pointerOnly = await identity(TENANT, 'adm2-eero@corp.example', {
      parentIdentityId: parentId,
    });
    const deleted = await identity(TENANT, 'adm3-eero@corp.example', {
      parentIdentityId: parentId,
      deletedAt: new Date('2026-11-20T10:00:00Z'),
    });
    // Another tenant's identity is never reached, even when it names the person
    await identity(OTHER_TENANT, 'adm-eero@other.example', { parentIdentityId: parentId });
    await withTenantContext(TENANT, () =>
      identityModel
        .updateOne(
          { _id: parentId },
          {
            $set: {
              linkedAdminAccounts: [both, entryOnly, deleted].map((a, i) => ({
                identityId: String(a._id),
                adminTier: ['TIER_0', 'TIER_1', 'TIER_2'][i],
                status: 'ACTIVE',
              })),
            },
          },
        )
        .exec(),
    );

    const admins = await activities.getLinkedAdminIdentities(parentId, TENANT, 'wf-1');

    expect(admins).toEqual([
      { identityId: String(both._id), email: 'adm0-eero@corp.example' },
      { identityId: String(entryOnly._id), email: 'adm1-eero@corp.example' },
      { identityId: String(pointerOnly._id), email: 'adm2-eero@corp.example' },
    ]);
    // Their running privileged sessions (and the person's own, were it an admin identity) are
    // told to end before the offboarding removes their accounts; the deleted one is left alone
    expect(sessions.endIfRunning.mock.calls).toEqual([
      [parentId, TENANT, 'offboarded'],
      [String(both._id), TENANT, 'offboarded'],
      [String(entryOnly._id), TENANT, 'offboarded'],
      [String(pointerOnly._id), TENANT, 'offboarded'],
    ]);
  });

  it('still returns them when a session cannot be told to end (best effort)', async () => {
    const parent = await identity(TENANT, 'ida@corp.example');
    const admin = await identity(TENANT, 'adm-ida@corp.example', {
      parentIdentityId: String(parent._id),
    });
    sessions.endIfRunning.mockRejectedValueOnce(new Error('Temporal is not connected'));

    await expect(
      activities.getLinkedAdminIdentities(String(parent._id), TENANT, 'wf-3'),
    ).resolves.toEqual([{ identityId: String(admin._id), email: 'adm-ida@corp.example' }]);
    expect(sessions.endIfRunning).toHaveBeenCalledTimes(2);
  });

  it('returns none for a person without linked admin accounts', async () => {
    const parent = await identity(TENANT, 'ada@corp.example');

    await expect(
      activities.getLinkedAdminIdentities(String(parent._id), TENANT, 'wf-2'),
    ).resolves.toEqual([]);
  });
});
