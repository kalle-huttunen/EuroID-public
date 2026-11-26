/**
 * Expiry warnings of the hourly entitlementExpiryWorkflow (in-memory MongoDB, tenant plugin):
 * `entitlement.expiring_soon` (7 days left) and `entitlement.expiring_tomorrow` are emitted once
 * per provisioning entry and expiry date, however many hourly runs and extra batches see the
 * entry in the window. A changed expiry date is warned about again. Each batch picks entries
 * not yet warned, so with more entries than the batch size the next batch goes on with the rest.
 * Each run also ends the expired identity attribute controls (department and job title
 * overrides) of the tenant, in the tenant's context.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getEventSchema } from '@infrastructure/events/event-payload-schemas';
import { TenantService } from '@infrastructure/multi-tenancy/tenant.service';
import {
  Identity,
  IdentityDocument,
  IdentitySchema,
} from '../modules/identity/schemas/identity.schema';
import { IdentityProvisioningService } from '../modules/identity/identity-provisioning.service';
import { IdentityService } from '../modules/identity/identity.service';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { PrivilegedAccessService } from '../modules/privileged-access/privileged-access.service';
import { EntitlementExpiryActivities } from './entitlement-expiry.activities';
import { EntitlementExpiryDeprovision } from './entitlement-expiry-deprovision';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-11-22T10:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('Entitlement expiry warnings (MongoDB)', () => {
  let moduleRef: TestingModule;
  let activities: EntitlementExpiryActivities;
  let identities: Model<IdentityDocument>;
  const events = { emit: jest.fn() };
  /** The attribute controls' expiry sweep (IdentityControlsService), and the tenant it ran in. */
  const sweptIn: string[] = [];
  const endExpiredControls = jest.fn(async (_tenantId: string, _now: Date, _limit: number) => {
    sweptIn.push(requestContext.getStore()?.tenantId ?? '');
    return 0;
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
      ],
      providers: [
        EntitlementExpiryActivities,
        { provide: IdentityProvisioningService, useValue: {} },
        { provide: EntitlementExpiryDeprovision, useValue: {} },
        { provide: DomainEventEmitterService, useValue: events },
        { provide: TenantService, useValue: { findAll: async () => [] } },
        {
          provide: PrivilegedAccessService,
          useValue: { deactivateExpiredSessions: async () => 0 },
        },
        { provide: IdentityService, useValue: { endExpiredControls } },
      ],
    }).compile();
    activities = moduleRef.get(EntitlementExpiryActivities);
    identities = moduleRef.get(getModelToken(Identity.name));
  });

  beforeEach(async () => {
    events.emit.mockReset();
    endExpiredControls.mockClear();
    sweptIn.length = 0;
    await identities.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  async function identity(name: string, provisioning: Array<Record<string, unknown>>) {
    const doc = await withTenantContext(A, () =>
      identities.create({
        tenantId: A,
        profile: { firstName: name, lastName: 'Test', email: `${name}@a.example` },
        provisioning: provisioning.map((p) => ({ status: 'SYNCED', ...p })),
      }),
    );
    return String(doc._id);
  }

  const run = (now: Date, limit = 50) =>
    activities.runEntitlementExpiryCheck(A, now.toISOString(), limit);
  const emitted = (type: DomainEventType) =>
    events.emit.mock.calls
      .filter(([t]) => t === type)
      .map(([, , payload]) => ({
        identityId: payload.identityId,
        targetSystem: payload.targetSystem,
        expiresAt: new Date(payload.expiresAt).toISOString(),
      }));

  it('warns once per entry and threshold across hourly runs and extra batches', async () => {
    const id = await identity('ada', [
      { targetSystem: 'entra-id', expiresAt: at(7 * DAY) },
      { targetSystem: 'scim', expiresAt: at(DAY) },
    ]);

    const first = await run(NOW);
    expect(first).toMatchObject({ expiringSoonCount: 1, expiringTomorrowCount: 1 });
    await run(NOW); // the workflow's next batch in the same run
    await run(at(HOUR));
    const later = await run(at(5 * HOUR));
    expect(later).toMatchObject({ expiringSoonCount: 0, expiringTomorrowCount: 0 });

    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRING_SOON)).toEqual([
      { identityId: id, targetSystem: 'entra-id', expiresAt: at(7 * DAY).toISOString() },
    ]);
    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRING_TOMORROW)).toEqual([
      { identityId: id, targetSystem: 'scim', expiresAt: at(DAY).toISOString() },
    ]);
  });

  // Plan 2.0dn: the warnings carried the identity's email to the audit log and the websocket.
  // The emitter parses a payload with its schema, which would strip a key it does not know.
  it('warns with a payload its schema keeps whole, which names no email', async () => {
    await identity('dee', [
      { targetSystem: 'entra-id', expiresAt: at(7 * DAY) },
      { targetSystem: 'scim', expiresAt: at(DAY) },
    ]);

    await run(NOW);

    expect(events.emit).toHaveBeenCalledTimes(2);
    for (const [type, , payload] of events.emit.mock.calls) {
      expect(getEventSchema(type).parse(payload)).toEqual(payload);
      expect(JSON.stringify(payload)).not.toContain('@a.example');
    }
  });

  it('warns again when the expiry date changes', async () => {
    const id = await identity('bob', [{ targetSystem: 'entra-id', expiresAt: at(7 * DAY) }]);
    await run(NOW);

    // Extended by a day: warned again when the new date is 7 days ahead, once
    await identities
      .updateOne({ _id: id }, { $set: { 'provisioning.0.expiresAt': at(8 * DAY) } })
      .setOptions({ skipTenantScope: true });
    await run(at(HOUR));
    await run(at(DAY));
    await run(at(DAY + HOUR));

    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRING_SOON).map((e) => e.expiresAt)).toEqual([
      at(7 * DAY).toISOString(),
      at(8 * DAY).toISOString(),
    ]);
  });

  it('a batch goes on with the entries not yet warned', async () => {
    const first = await identity('cy', [{ targetSystem: 'entra-id', expiresAt: at(7 * DAY) }]);
    const second = await identity('di', [{ targetSystem: 'entra-id', expiresAt: at(7 * DAY) }]);

    await run(NOW, 1);
    await run(NOW, 1);
    await run(NOW, 1);

    const warned = emitted(DomainEventType.ENTITLEMENT_EXPIRING_SOON).map((e) => e.identityId);
    expect(warned.sort()).toEqual([first, second].sort());
  });

  it('ends the expired attribute controls of the tenant, in its context, at its now and batch size', async () => {
    await run(NOW, 20);

    expect(endExpiredControls).toHaveBeenCalledWith(A, NOW, 20);
    expect(sweptIn).toEqual([A]);
  });

  it('goes on with the run when the control sweep fails', async () => {
    endExpiredControls.mockRejectedValueOnce(new Error('MongoServerError: down'));
    await identity('ada', [{ targetSystem: 'entra-id', expiresAt: at(DAY) }]);

    await expect(run(NOW)).resolves.toMatchObject({ expiringTomorrowCount: 1 });
  });
});
