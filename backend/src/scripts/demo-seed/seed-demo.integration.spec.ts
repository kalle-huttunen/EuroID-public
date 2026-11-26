/**
 * The demo seed on the in-memory MongoDB with the tenant plugin: what it writes, that the app's
 * services read it, that a second run writes nothing, that --reset removes only the seed's
 * documents, and that nothing lands in another tenant.
 */
import mongoose, { type Connection } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { createMockLoggerFactory, closeTestDb, testDbUri } from '@testing';
import type { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { IdentityQueryService } from '@modules/identity/identity-query.service';
import type { IdentityDocument } from '@modules/identity/schemas/identity.schema';
import { DriftService } from '@modules/reconciliation/drift.service';
import type { DriftDocument } from '@modules/reconciliation/schemas/drift.schema';
import { demoModels, type DemoCollection, type DemoModels } from './models';
import { buildDemoData, seedDemoData } from './seed-demo';
import { planPeople } from './people';
import { parseSeedArgs } from './args';
import { startOfUtcDay } from './random';
import { UserStatus } from '@shared/dtos/standard-user.dto';

mongoose.plugin(tenantPlugin);

const A = 'demo-tenant-a';
const B = 'demo-tenant-b';
const NOW = new Date('2026-11-24T10:30:00Z');
jest.setTimeout(120_000);

describe('Demo seed (MongoDB)', () => {
  let conn: Connection;
  let models: DemoModels;

  const countIn = async (tenantId: string): Promise<Record<DemoCollection, number>> => {
    const out = {} as Record<DemoCollection, number>;
    for (const [key, model] of Object.entries(models)) {
      out[key as DemoCollection] = await model.countDocuments({ tenantId }).exec();
    }
    return out;
  };
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    withTenantContext(tenantId, fn) as Promise<T>;

  beforeAll(async () => {
    conn = await mongoose.createConnection(testDbUri()).asPromise();
    models = demoModels(conn);
    // The unique indexes (email among live identities, one open leaver event, ...) must hold
    await Promise.all(Object.values(models).map((m) => m.init()));
  });

  afterAll(async () => {
    await conn.close();
    await closeTestDb();
  });

  describe('a first run', () => {
    let inserted: Partial<Record<DemoCollection, number>>;

    beforeAll(async () => {
      const result = await seedDemoData(conn, { tenantId: A, now: NOW });
      expect(result.seeded).toBe(true);
      inserted = result.inserted;
    });

    it('writes 200 live identities plus the offboarded ones, every document of them marked', async () => {
      const all = await models.identities.find({ tenantId: A }).lean().exec();
      expect(all).toHaveLength(203);
      expect(all.filter((i) => !i.deletedAt)).toHaveLength(200);
      expect(all.every((i) => (i.metadata as { demoSeed?: boolean }).demoSeed === true)).toBe(true);
      expect(await countIn(A)).toEqual(expect.objectContaining(inserted));
    });

    it('builds an org chart of ten departments under one CEO, with live managers', async () => {
      const live = await models.identities.find({ tenantId: A, deletedAt: null }).lean().exec();
      const profiles = live.map((i) => i.profile as Record<string, string>);
      const emails = new Set(profiles.map((p) => p.email));
      const linked = profiles.filter((p) => p.sourceSystem === 'csv-hr');
      expect(new Set(linked.map((p) => p.departmentName)).size).toBe(10);
      const withoutManager = linked.filter((p) => !p.managerEmail);
      expect(withoutManager.map((p) => p.jobTitle)).toEqual(['Chief Executive Officer']);
      expect(linked.filter((p) => p.managerEmail).every((p) => emails.has(p.managerEmail))).toBe(
        true,
      );
      expect([...emails].every((e) => /@([a-z]+\.)*example\.com$/.test(e))).toBe(true);
      expect(new Set(profiles.map((p) => p.countryCode)).size).toBeGreaterThanOrEqual(6);
    });

    it('covers the lifecycles: joiners, leavers, contractors, second HR source, unlinked records', async () => {
      const q = (filter: Record<string, unknown>) =>
        models.identities.countDocuments({ tenantId: A, ...filter }).exec();
      expect(await q({ 'profile.startDate': { $gt: NOW } })).toBeGreaterThanOrEqual(3);
      expect(await q({ 'profile.status': 'TERMINATED', deletedAt: null })).toBe(3);
      expect(await q({ deletedAt: { $ne: null } })).toBe(3);
      expect(await q({ 'profile.employmentType': 'CONTRACTOR' })).toBeGreaterThanOrEqual(3);
      expect(
        await q({ 'sources.sourceRole': 'secondary-hr', 'sources.1': { $exists: true } }),
      ).toBeGreaterThan(5);
      expect(
        await q({ 'metadata.correlationStatus': { $in: ['uncorrelated', 'ambiguous'] } }),
      ).toBe(4);
      expect(
        await q({ 'metadata.correlationConflict': true, 'metadata.requiresReview': true }),
      ).toBe(3);
      expect(await q({ 'provisioning.status': 'ERROR' })).toBe(6);
      expect(await q({ 'provisioning.expiryFailure': { $exists: true } })).toBe(2);
    });

    // HR ingest stores the row it validated (StandardUserSchema): the seed wrote "active" and
    // "terminated", which reconcile copied into the profile, and Link answered 500
    it('stores each HR record as HR ingest does: its status is a UserStatus', async () => {
      const all = await models.identities.find({ tenantId: A }).lean().exec();
      const records = all.flatMap((i) =>
        ((i.sources ?? []) as Array<{ sourceRole?: string; rawData?: { status?: unknown } }>)
          .filter((s) => s.sourceRole !== 'target')
          .map((s) => s.rawData ?? {}),
      );
      expect(records.length).toBeGreaterThan(200);
      const statuses = new Set(records.map((r) => r.status));
      expect([...statuses].sort()).toEqual([UserStatus.ACTIVE, UserStatus.TERMINATED]);
    });

    it('keeps the dates it was given (timestamps are not overwritten by the insert)', async () => {
      const ceo = await models.identities
        .findOne({ tenantId: A, 'profile.jobTitle': 'Chief Executive Officer' })
        .lean()
        .exec();
      expect((ceo?.createdAt as Date).getTime()).toBeLessThan(NOW.getTime() - 365 * 86_400_000);
    });

    it('writes the governance and operations data in the states the pages show', async () => {
      const statuses = async (key: DemoCollection, field: string) =>
        (await models[key].find({ tenantId: A }).lean().exec())
          .map((d) => String((d as Record<string, unknown>)[field]))
          .sort();
      expect(await statuses('accessRequests', 'status')).toEqual([
        'ACTIVE',
        'ACTIVE',
        'ACTIVE',
        'ACTIVE',
        'EXPIRED',
        'EXPIRED',
        'PENDING_APPROVAL',
        'PENDING_APPROVAL',
        'PENDING_APPROVAL',
        'PENDING_APPROVAL',
        'REJECTED',
        'REJECTED',
      ]);
      expect(await statuses('campaigns', 'status')).toEqual(['ACTIVE', 'COMPLETED']);
      expect(new Set(await statuses('reviewItems', 'decision'))).toEqual(
        new Set(['pending', 'approved', 'revoked', 'expired']),
      );
      expect(new Set(await statuses('drifts', 'status'))).toEqual(
        new Set(['open', 'corrected', 'ignored', 'quarantined']),
      );
      expect(await statuses('policies', 'status')).toEqual([
        'active',
        'active',
        'active',
        'active',
        'active',
        'draft',
      ]);
      expect(await statuses('sodPolicies', 'action')).toEqual(['BLOCK', 'WARN', 'WARN']);
      expect(await statuses('subscriptions', 'status')).toEqual(['DISABLED', 'PAUSED']);
      for (const key of ['joinerBatches', 'leaverBatches', 'moverBatches'] as const) {
        expect(await statuses(key, 'status')).toEqual(['pending']);
      }
      const movers = await models.moverItems.find({ tenantId: A }).lean().exec();
      expect(
        movers.map((m) => (m.changes as Array<{ field: string }>).map((c) => c.field)),
      ).toEqual(Array(3).fill(['departmentName', 'jobTitle']));
    });

    it('is read by the app: the identity list and the drift listing', async () => {
      const { factory } = createMockLoggerFactory();
      const identities = new IdentityQueryService(
        models.identities as unknown as mongoose.Model<IdentityDocument>,
        factory as unknown as LoggerFactoryService,
      );
      const drifts = new DriftService(
        models.drifts as unknown as mongoose.Model<DriftDocument>,
        {} as never,
        {} as never,
        {} as never,
      );
      const [list, total] = await inTenant(A, () => identities.findAllPaginated(0, 50));
      expect(total).toBe(200);
      expect(list).toHaveLength(50);
      const open = await inTenant(A, () => drifts.getDrifts({ status: 'open' }));
      expect(open).toHaveLength(8);
      expect((await inTenant(A, () => drifts.getStats())).total).toBe(8);
      const [, totalInB] = await inTenant(B, () => identities.findAllPaginated(0, 50));
      expect(totalInB).toBe(0);
    });

    it('writes nothing to another tenant', async () => {
      const inB = await countIn(B);
      expect(Object.values(inB).every((n) => n === 0)).toBe(true);
    });
  });

  it('builds the same people and documents for the same day, other ids for another tenant', () => {
    const anchor = startOfUtcDay(NOW);
    const ctx = (tenantId: string) => ({ tenantId, anchor, people: planPeople(200, anchor) });
    expect(JSON.stringify(buildDemoData(ctx(A)))).toBe(JSON.stringify(buildDemoData(ctx(A))));
    const [a, b] = [buildDemoData(ctx(A)), buildDemoData(ctx(B))];
    const emails = (d: typeof a) =>
      d.identities?.map((i) => (i.profile as { email: string }).email);
    expect(emails(b)).toEqual(emails(a));
    expect(String(b.identities?.[0]._id)).not.toBe(String(a.identities?.[0]._id));
  });

  it('writes nothing on a second run', async () => {
    const before = await countIn(A);
    const again = await seedDemoData(conn, { tenantId: A, now: NOW });
    expect(again).toEqual({ seeded: false, inserted: {} });
    expect(await countIn(A)).toEqual(before);
  });

  it('--reset removes only what the seed wrote, then seeds the same data again', async () => {
    await seedDemoData(conn, { tenantId: B, now: NOW });
    const inB = await countIn(B);
    const seededIds = (await models.identities.find({ tenantId: A }).select('_id').lean().exec())
      .map((d) => String(d._id))
      .sort();
    const ownId = await inTenant(A, async () => {
      const own = await models.identities.create({
        tenantId: A,
        profile: {
          firstName: 'Own',
          lastName: 'Person',
          email: 'own.person@tenant-a.example',
          status: 'ACTIVE',
        },
      });
      const id = String(own._id);
      await models.userEvents.create({
        tenantId: A,
        userId: id,
        type: 'USER_CREATED',
        title: 'Created',
        actor: 'system',
      });
      await models.drifts.create({
        tenantId: A,
        type: 'FIELD_MISMATCH',
        severity: 'low',
        userId: id,
        userDisplayName: 'Own Person',
        userEmail: 'own.person@tenant-a.example',
        targetSystem: 'entra',
        status: 'open',
      });
      // Derived by the app about a seeded identity: goes with it
      await models.userEvents.create({
        tenantId: A,
        userId: seededIds[5],
        type: 'USER_UPDATED',
        title: 'Updated',
        actor: 'admin',
      });
      return id;
    });

    const result = await seedDemoData(conn, { tenantId: A, now: NOW, reset: true });

    expect(result.seeded).toBe(true);
    expect(result.removed?.identities).toBe(203);
    expect(await models.identities.exists({ tenantId: A, _id: ownId })).not.toBeNull();
    expect(await models.userEvents.countDocuments({ tenantId: A, userId: ownId })).toBe(1);
    expect(await models.drifts.countDocuments({ tenantId: A, userId: ownId })).toBe(1);
    expect(
      await models.userEvents.countDocuments({ tenantId: A, title: 'Updated', actor: 'admin' }),
    ).toBe(0);
    const reseeded = (
      await models.identities
        .find({ tenantId: A, 'metadata.demoSeed': true })
        .select('_id')
        .lean()
        .exec()
    )
      .map((d) => String(d._id))
      .sort();
    expect(reseeded).toEqual(seededIds);
    const afterA = await countIn(A);
    expect(afterA.identities).toBe(204);
    expect(afterA.drifts).toBe((result.inserted.drifts ?? 0) + 1);
    expect(await countIn(B)).toEqual(inB);
  });
});

describe('Demo seed arguments', () => {
  it('defaults to the dev tenant and 200 identities', () => {
    expect(parseSeedArgs([], {})).toEqual({ tenantId: 'dev-tenant', count: 200, reset: false });
    expect(parseSeedArgs(['--reset', '--count', '80'], { DEV_TENANT_ID: 't1' })).toEqual({
      tenantId: 't1',
      count: 80,
      reset: true,
    });
  });

  it('refuses production, unknown arguments and counts it cannot fill', () => {
    expect(() => parseSeedArgs([], { NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => parseSeedArgs(['--force'], {})).toThrow(/--force/);
    expect(() => parseSeedArgs(['--count', '10'], {})).toThrow(/--count/);
    expect(() => parseSeedArgs(['--tenant', '{"$gt":""}'], {})).toThrow(/--tenant/);
  });
});
