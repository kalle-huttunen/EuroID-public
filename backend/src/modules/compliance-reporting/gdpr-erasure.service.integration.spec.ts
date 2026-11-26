/**
 * GDPR erasure counts on in-memory MongoDB (tenant plugin): the dry run and the attestation count
 * only what the erasure deletes. The GDPR_ERASURE_EXECUTED entries under the identity (earlier
 * dry runs, the erasure's own entry) are kept and not counted, and neither are outbox events not
 * yet published. Before, both were counted, so the attestation, the legal record of the erasure,
 * overstated what was deleted.
 */
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { clearTestDb, closeTestDb, connectTestDb } from '@testing';
import { AuditService } from '../audit/audit.service';
import { AuditEvent, AuditEventSchema } from '../audit/schemas/audit-event.schema';
import { AuditChainHead, AuditChainHeadSchema } from '../audit/schemas/audit-chain-head.schema';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { UserEvent, UserEventSchema } from '../identity/schemas/user-event.schema';
import { ReviewItem, ReviewItemSchema } from '../access-review/schemas/review-item.schema';
import { ReviewExclusion, ReviewExclusionSchema } from '../policy/schemas/review-exclusion.schema';
import { OutboxEvent, OutboxEventSchema } from '@infrastructure/events/schemas/outbox-event.schema';
import { GdprErasureService } from './gdpr-erasure.service';
import type { GdprExternalStores } from './gdpr-erasure-external-stores';
import type { NhiOwnershipService } from '../nhi/nhi-ownership.service';

mongoose.plugin(tenantPlugin);

/** No access graph or Elasticsearch index here (gdpr-erasure-reach.integration.spec.ts has them). */
const noExternalStores = {
  count: async () => ({ counts: {}, notReached: [] }),
  erase: async () => ({ counts: {}, notReached: [] }),
} as unknown as GdprExternalStores;

const A = 'tenant-a';
const ADA = '64b7f0c2a1b2c3d4e5f60a01';
const DPO = 'dpo@tenant-a.example';

/* eslint-disable @typescript-eslint/no-explicit-any -- untyped test models */
describe('GdprErasureService counts (in-memory MongoDB)', () => {
  let identities: Model<any>;
  let audit: Model<any>;
  let outbox: Model<any>;
  let service: GdprErasureService;
  const inTenant = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;

  /** As AuditService.log stores an entry (the hash chain left out). */
  const auditService = {
    log: jest.fn(async (entry: Record<string, unknown>) => {
      await audit.create({ ...entry, timestamp: new Date() });
    }),
  };

  const auditEntry = (action: string, at: string) => ({
    action,
    severity: 'info',
    timestamp: new Date(at),
    actor: 'op@tenant-a.example',
    resourceType: 'identity',
    resourceId: ADA,
    resourceName: ADA,
    description: action,
    tenantId: A,
  });

  const outboxEvent = (eventId: string, status: string) => ({
    eventId,
    type: 'identity.updated',
    aggregateId: ADA,
    payload: { identityId: ADA },
    metadata: { correlationId: eventId, depth: 0, emittedBy: 'test', actor: 'test', tenantId: A },
    status,
    tenantId: A,
  });

  const model = (name: string, schema: mongoose.Schema) =>
    mongoose.model(name, schema) as unknown as Model<any>;

  beforeAll(async () => {
    await connectTestDb();
    identities = model(Identity.name, IdentitySchema);
    audit = model(AuditEvent.name, AuditEventSchema);
    outbox = model(OutboxEvent.name, OutboxEventSchema);
    service = new GdprErasureService(
      identities,
      model(UserEvent.name, UserEventSchema),
      audit,
      model(ReviewItem.name, ReviewItemSchema),
      model(ReviewExclusion.name, ReviewExclusionSchema),
      outbox,
      auditService as unknown as AuditService,
      mongoose.connection,
      noExternalStores,
      { markOwnerless: jest.fn().mockResolvedValue(0) } as unknown as NhiOwnershipService,
    );
  });

  beforeEach(async () => {
    await inTenant(async () => {
      await identities.create({
        _id: ADA,
        tenantId: A,
        profile: { firstName: 'Ada', lastName: 'Virtanen', email: 'ada@tenant-a.example' },
      });
      await audit.create([
        auditEntry('IDENTITY_UPDATED', '2026-11-01T10:00:00.000Z'),
        auditEntry('DATA_EXPORTED', '2026-11-02T10:00:00.000Z'),
        // An earlier preview: kept by the erasure
        auditEntry('GDPR_ERASURE_EXECUTED', '2026-11-03T10:00:00.000Z'),
      ]);
      await outbox.create([outboxEvent('e1', 'published'), outboxEvent('e2', 'failed')]);
    });
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('a dry run counts the audit entries and outbox events the erasure would delete', async () => {
    const preview = await inTenant(() => service.eraseIdentity(ADA, DPO, true));

    expect(preview.documentCounts).toMatchObject({
      identities: 1,
      audit_events: 2,
      outbox_events: 1,
    });
    // Nothing deleted; the preview's own entry is written.
    expect(await inTenant(() => audit.countDocuments({ resourceId: ADA }).exec())).toBe(4);
  });

  it('the attestation counts exactly what the erasure deleted', async () => {
    // A preview first, as the GDPR page does: one more kept entry.
    await inTenant(() => service.eraseIdentity(ADA, DPO, true));
    const auditBefore = await inTenant(() => audit.countDocuments({ resourceId: ADA }).exec());
    const outboxBefore = await inTenant(() => outbox.countDocuments({ aggregateId: ADA }).exec());

    const attestation = await inTenant(() => service.eraseIdentity(ADA, DPO, false));

    // The erasure wrote its own entry (+1) before deleting.
    const auditAfter = await inTenant(() => audit.countDocuments({ resourceId: ADA }).exec());
    const outboxAfter = await inTenant(() => outbox.countDocuments({ aggregateId: ADA }).exec());
    expect(attestation.documentCounts.audit_events).toBe(auditBefore + 1 - auditAfter);
    expect(attestation.documentCounts.outbox_events).toBe(outboxBefore - outboxAfter);
    expect(attestation.documentCounts).toMatchObject({ audit_events: 2, outbox_events: 1 });
    // Kept: the three erasure entries (earlier preview, this test's preview, the erasure) and the
    // failed outbox event.
    const kept = await inTenant(() => audit.find({ resourceId: ADA }).lean().exec());
    expect(kept.map((e: { action: string }) => e.action)).toEqual([
      'GDPR_ERASURE_EXECUTED',
      'GDPR_ERASURE_EXECUTED',
      'GDPR_ERASURE_EXECUTED',
    ]);
    expect(outboxAfter).toBe(1);
    expect(await inTenant(() => identities.countDocuments({ _id: ADA }).exec())).toBe(0);
  });

  // With the real hash chain: the gap the erased entries leave is reported as this erasure
  it('the chain check reports the erased entries as the erasure, not as tampering', async () => {
    const heads = model(AuditChainHead.name, AuditChainHeadSchema);
    await Promise.all([audit.init(), heads.init()]);
    await audit.collection.deleteMany({});
    const chain = new AuditService(audit, heads);
    const chained = new GdprErasureService(
      identities,
      model(UserEvent.name, UserEventSchema),
      audit,
      model(ReviewItem.name, ReviewItemSchema),
      model(ReviewExclusion.name, ReviewExclusionSchema),
      outbox,
      chain,
      mongoose.connection,
      noExternalStores,
      { markOwnerless: jest.fn().mockResolvedValue(0) } as unknown as NhiOwnershipService,
    );
    const write = (resourceId: string, action: string) =>
      chain.log({
        action,
        actor: 'op@tenant-a.example',
        resourceType: 'identity',
        resourceId,
        resourceName: resourceId,
        description: action,
        tenantId: A,
      });
    await inTenant(async () => {
      await write('someone-else', 'IDENTITY_UPDATED');
      await write(ADA, 'IDENTITY_UPDATED');
      await write('someone-else', 'CONFIG_CHANGED');
      await write(ADA, 'DATA_EXPORTED');
      await write('someone-else', 'CONFIG_CHANGED');
    });

    await inTenant(() => chained.eraseIdentity(ADA, DPO, false));

    const erasure = await inTenant(() =>
      audit.findOne({ action: 'GDPR_ERASURE_EXECUTED' }).lean().exec(),
    );
    expect(erasure.payload.metadata.removedSeqs).toEqual([2, 4]);
    await expect(chain.verifyIntegrity(A)).resolves.toMatchObject({
      valid: true,
      eventsChecked: 4,
      erasureGaps: [{ erasureEntryId: String(erasure._id), eventsRemoved: 2 }],
    });
    // The same gap without the erasure's record is tampering
    await audit.collection.updateOne(
      { _id: erasure._id },
      { $unset: { 'payload.metadata.removedSeqs': '' } },
    );
    await expect(chain.verifyIntegrity(A)).resolves.toMatchObject({
      valid: false,
      firstInvalidSeq: 3,
      reason: 'missing_events',
      missingEvents: 1,
    });
  });
});
