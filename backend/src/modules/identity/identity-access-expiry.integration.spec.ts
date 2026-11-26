/**
 * Admin actions on expired access the hourly expiry run could not remove (in-memory MongoDB,
 * tenant plugin): retry clears the failure so the next run picks the entry again; removed
 * manually closes the entry as DEPROVISIONED. Both only for an entry with a failed expiry for
 * its current expiry date, only in the caller's tenant, once, audited with the admin as actor
 * (payloads their Zod schemas accept).
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getEventSchema } from '@infrastructure/events/event-payload-schemas';
import { isExpiryDue } from '../../activities/entitlement-expiry-failure';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { IdentityAccessExpiryService } from './identity-access-expiry.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const ADMIN = 'admin@tenant-a.example';
const NOW = new Date('2026-11-22T10:00:00.000Z');
const EXPIRED = new Date('2026-11-20T10:00:00.000Z');
const FAILURE = {
  expiresAt: EXPIRED,
  failedAt: new Date('2026-11-20T11:00:00.000Z'),
  reason: 'okta: Request failed with status code 403 (HTTP 403)',
  retryable: false,
  attempts: 1,
};

describe('Expired access: retry and removed manually (MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: IdentityAccessExpiryService;
  let identities: Model<IdentityDocument>;
  const events = { emit: jest.fn() };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
      ],
      providers: [
        IdentityAccessExpiryService,
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    service = moduleRef.get(IdentityAccessExpiryService);
    identities = moduleRef.get(getModelToken(Identity.name));
  });

  beforeEach(async () => {
    events.emit.mockReset();
    await identities.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  let created = 0;
  async function identity(
    provisioning: Array<Record<string, unknown>>,
    tenantId = A,
    extra: Record<string, unknown> = {},
  ) {
    created++;
    const doc = await withTenantContext(tenantId, () =>
      identities.create({
        tenantId,
        profile: { firstName: 'Ada', lastName: 'Test', email: `ada${created}@a.example` },
        provisioning: provisioning.map((p) => ({ status: 'SYNCED', ...p })),
        ...extra,
      }),
    );
    return String(doc._id);
  }

  const failedOkta = { targetSystem: 'okta', expiresAt: EXPIRED, expiryFailure: FAILURE };

  async function entryOf(id: string, targetSystem: string) {
    const doc = await identities.findById(id).setOptions({ skipTenantScope: true }).lean().exec();
    return doc?.provisioning.find((p) => p.targetSystem === targetSystem);
  }

  const inA = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;

  it('retry clears the failure, so the next expiry run picks the entry again', async () => {
    const id = await identity([failedOkta]);
    expect(isExpiryDue((await entryOf(id, 'okta'))!, NOW)).toBe(false);

    const answer = await inA(() => service.retry(id, 'okta', ADMIN));

    expect(answer).toMatchObject({ targetSystem: 'okta', status: 'SYNCED' });
    expect(answer.expiryFailure).toBeUndefined();
    const entry = (await entryOf(id, 'okta'))!;
    expect(entry.expiryFailure).toBeUndefined();
    expect(isExpiryDue(entry, NOW)).toBe(true);

    expect(events.emit).toHaveBeenCalledTimes(1);
    const [type, aggregateId, payload, options] = events.emit.mock.calls[0];
    expect([type, aggregateId, options]).toEqual([
      DomainEventType.ENTITLEMENT_EXPIRY_RETRY_REQUESTED,
      id,
      { actor: ADMIN },
    ]);
    expect(getEventSchema(type).parse(payload)).toEqual({
      identityId: id,
      targetSystem: 'okta',
      expiresAt: EXPIRED.toISOString(),
      failureReason: FAILURE.reason,
    });

    // Nothing left to retry
    await expect(inA(() => service.retry(id, 'okta', ADMIN))).rejects.toThrow(ConflictException);
  });

  it('removed manually closes the entry as DEPROVISIONED, once', async () => {
    const provisionedAt = new Date('2026-10-01T08:00:00.000Z');
    const id = await identity([
      { ...failedOkta, provisionedAt, writebackComplete: true },
      { targetSystem: 'entra-id', expiresAt: EXPIRED, provisionedAt, writebackComplete: true },
    ]);

    const answer = await inA(() =>
      service.markRemovedManually(id, 'okta', ADMIN, 'Deactivated in the Okta console'),
    );

    expect(answer).toMatchObject({ targetSystem: 'okta', status: 'DEPROVISIONED' });
    const entry = (await entryOf(id, 'okta'))!;
    expect(entry.status).toBe('DEPROVISIONED');
    // A deprovision: the system no longer counts as having an account (provisionedAt)
    expect(entry.provisionedAt).toBeNull();
    expect((await entryOf(id, 'entra-id'))!.provisionedAt).toEqual(provisionedAt);
    // and the writeback is undone, so a later provision writes the new account id back
    expect(entry.writebackComplete).toBe(false);
    expect((await entryOf(id, 'entra-id'))!.writebackComplete).toBe(true);
    expect(entry.expiryFailure).toBeUndefined();
    expect(entry.lastSync).toBeInstanceOf(Date);
    expect(isExpiryDue(entry, NOW)).toBe(false);
    expect((await entryOf(id, 'entra-id'))!.status).toBe('SYNCED');

    const [type, aggregateId, payload, options] = events.emit.mock.calls[0];
    expect([type, aggregateId, options]).toEqual([
      DomainEventType.ENTITLEMENT_EXPIRY_REMOVED_MANUALLY,
      id,
      { actor: ADMIN },
    ]);
    expect(getEventSchema(type).parse(payload)).toEqual({
      identityId: id,
      targetSystem: 'okta',
      expiresAt: EXPIRED.toISOString(),
      reason: 'Deactivated in the Okta console',
      failureReason: FAILURE.reason,
    });

    events.emit.mockClear();
    await expect(
      inA(() => service.markRemovedManually(id, 'okta', ADMIN, 'again')),
    ).rejects.toThrow('okta has no failed expiry to close: its access is already removed');
    await expect(inA(() => service.retry(id, 'okta', ADMIN))).rejects.toThrow(ConflictException);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it.each([
    ['no failure recorded', { targetSystem: 'okta', expiresAt: EXPIRED }],
    [
      'a failure for an earlier expiry date',
      { ...failedOkta, expiresAt: new Date('2026-11-21T10:00:00.000Z') },
    ],
    ['an entry already DEPROVISIONED', { ...failedOkta, status: 'DEPROVISIONED' }],
  ])('409 for %s, nothing changed', async (_label, entry) => {
    const id = await identity([entry]);
    const before = await entryOf(id, 'okta');

    await expect(inA(() => service.retry(id, 'okta', ADMIN))).rejects.toThrow(ConflictException);
    await expect(inA(() => service.markRemovedManually(id, 'okta', ADMIN, 'gone'))).rejects.toThrow(
      ConflictException,
    );

    expect(await entryOf(id, 'okta')).toEqual(before);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('404 for another tenant’s identity, a deleted one, or no entry for the target', async () => {
    const other = await identity([failedOkta], B);
    const deleted = await identity([failedOkta], A, { deletedAt: new Date() });
    const mine = await identity([failedOkta]);

    for (const id of [other, deleted]) {
      await expect(inA(() => service.retry(id, 'okta', ADMIN))).rejects.toThrow(
        'Identity not found',
      );
    }
    await expect(
      inA(() => service.markRemovedManually(mine, 'github', ADMIN, 'gone')),
    ).rejects.toThrow(NotFoundException);

    expect((await entryOf(other, 'okta'))!.expiryFailure).toBeDefined();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
