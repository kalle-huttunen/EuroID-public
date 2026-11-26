/**
 * Tenant administration on in-memory MongoDB: POST /tenants/migrate assigns documents that have
 * no tenant to a tenant that exists, previews by default, and never moves the audit chain or a
 * live tenant's documents (the `default` tenant included); PATCH /tenants/:id merges settings
 * instead of replacing them.
 */
import mongoose, { Model, Schema } from 'mongoose';
import type { Db } from 'mongodb';
import { NotFoundException } from '@nestjs/common';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import { Tenant, TenantDocument, TenantSchema } from './schemas/tenant.schema';
import { TenantService } from './tenant.service';
import { TenantStatusService } from './tenant-status.service';
import { tenantPlugin } from './tenant.plugin';

const RAW = [
  'identities',
  'policies',
  'audit_events',
  'access_requests',
  'event_outbox',
  'audit_chain_heads',
];

/** A model as the app registers one: its schema carries the tenant plugin (tenant.module.ts). */
function tenantModelFor(name: string, collection: string) {
  const schema = new Schema({ name: String }, { collection });
  schema.plugin(tenantPlugin);
  return mongoose.models[name] ?? mongoose.model(name, schema);
}

describe('tenant administration (in-memory MongoDB)', () => {
  let tenantModel: Model<TenantDocument>;
  let db: Db;
  let service: TenantService;
  const savedDefault = process.env.DEFAULT_TENANT_ID;

  beforeAll(async () => {
    await connectTestDb();
    tenantModel = mongoose.model(Tenant.name, TenantSchema) as unknown as Model<TenantDocument>;
    // Tenant collections the hand-kept list missed (hunt: access requests, the outbox), and the
    // audit chain's heads, which stay per tenant like audit_events
    tenantModelFor('MigrateAccessRequest', 'access_requests');
    tenantModelFor('MigrateOutbox', 'event_outbox');
    tenantModelFor('MigrateChainHead', 'audit_chain_heads');
    db = mongoose.connection.db as unknown as Db;
    service = new TenantService(
      tenantModel,
      mongoose.connection,
      new TenantStatusService(tenantModel),
    );
  });

  beforeEach(async () => {
    process.env.DEFAULT_TENANT_ID = 'acme';
    await tenantModel.create({ tenantId: 'acme', name: 'Acme' });
    await db
      .collection('identities')
      .insertMany([
        { name: 'no tenant' },
        { name: 'null tenant', tenantId: null },
        { name: 'empty tenant', tenantId: '' },
        { name: 'legacy default', tenantId: 'default' },
        { name: 'globex person', tenantId: 'globex' },
      ]);
    await db.collection('policies').insertOne({ name: 'unassigned policy' });
    await db.collection('audit_events').insertMany([{ seq: 1 }, { seq: 2, tenantId: 'default' }]);
  });

  afterEach(async () => {
    process.env.DEFAULT_TENANT_ID = savedDefault;
    await clearTestDb();
    for (const name of RAW) await db.collection(name).deleteMany({});
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const tenantsOf = async (collection: string) =>
    (await db.collection(collection).find().sort({ name: 1, seq: 1 }).toArray()).map(
      (d) => d.tenantId,
    );

  describe('migrate', () => {
    it('refuses a target that is not a tenant, and moves nothing', async () => {
      await expect(service.migrateDatabase('acmee', false)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await db.collection('identities').countDocuments({ tenantId: 'acmee' })).toBe(0);
    });

    it('previews by default: counts per collection, nothing moved', async () => {
      const result = await service.migrateDatabase('acme');

      expect(result.dryRun).toBe(true);
      expect(result.collections).toMatchObject({ identities: 4, policies: 1 });
      expect(result.collections).not.toHaveProperty('audit_events');
      expect(await db.collection('identities').countDocuments({ tenantId: 'acme' })).toBe(0);
    });

    it('moves documents without a tenant, never the audit chain or another tenant', async () => {
      const result = await service.migrateDatabase('acme', false);

      expect(result).toMatchObject({ dryRun: false, collections: { identities: 4, policies: 1 } });
      expect(await db.collection('identities').countDocuments({ tenantId: 'acme' })).toBe(4);
      expect(await db.collection('identities').countDocuments({ tenantId: 'globex' })).toBe(1);
      expect(await tenantsOf('audit_events')).toEqual([undefined, 'default']);
    });

    it('moves the unassigned documents of every registered model that carries the tenant plugin', async () => {
      await db.collection('access_requests').insertOne({ name: 'unassigned request' });
      await db.collection('event_outbox').insertOne({ name: 'unassigned event', tenantId: null });

      const result = await service.migrateDatabase('acme', false);

      expect(result.collections).toMatchObject({ access_requests: 1, event_outbox: 1 });
      expect(await tenantsOf('access_requests')).toEqual(['acme']);
      expect(await tenantsOf('event_outbox')).toEqual(['acme']);
    });

    it('never moves the audit chain heads or the tenants and admin users collections', async () => {
      await db.collection('audit_chain_heads').insertOne({ name: 'head' });

      const result = await service.migrateDatabase('acme');

      expect(Object.keys(result.collections)).not.toEqual(
        expect.arrayContaining(['audit_chain_heads']),
      );
      expect(result.collections).not.toHaveProperty('tenants');
      expect(result.collections).not.toHaveProperty('admin_users');
    });

    it("never moves the documents of a tenant named 'default' that exists", async () => {
      await tenantModel.create({ tenantId: 'default', name: 'Default' });

      const result = await service.migrateDatabase('acme', false);

      expect(result.collections.identities).toBe(3);
      expect(await db.collection('identities').countDocuments({ tenantId: 'default' })).toBe(1);
    });

    it("never moves 'default' documents while DEFAULT_TENANT_ID is 'default' (the live tenant)", async () => {
      process.env.DEFAULT_TENANT_ID = 'default';

      await service.migrateDatabase('acme', false);

      expect(await db.collection('identities').countDocuments({ tenantId: 'default' })).toBe(1);
    });
  });

  describe('update', () => {
    it('merges settings: a PATCH of one setting keeps the others', async () => {
      await service.update('acme', { settings: { mfaRequired: true, retentionDays: 90 } });

      await service.update('acme', { settings: { retentionDays: 30 } });

      const stored = await tenantModel.findOne({ tenantId: 'acme' }).lean();
      expect(stored!.settings).toEqual({ mfaRequired: true, retentionDays: 30 });
    });

    it('removes a setting sent as null, and renames without touching settings', async () => {
      await service.update('acme', { settings: { mfaRequired: true, maxIdentities: 500 } });

      await service.update('acme', { name: 'Acme Oy', settings: { maxIdentities: null } });

      const stored = await tenantModel.findOne({ tenantId: 'acme' }).lean();
      expect(stored).toMatchObject({ name: 'Acme Oy', settings: { mfaRequired: true } });
      expect(stored!.settings).not.toHaveProperty('maxIdentities');
    });
  });
});
