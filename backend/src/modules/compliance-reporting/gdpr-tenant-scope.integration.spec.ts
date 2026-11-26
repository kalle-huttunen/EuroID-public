/**
 * GDPR erasure and DSAR export stay in the request tenant (in-memory MongoDB, tenant plugin as in
 * production): both services find the subject by its id only, so the tenant plugin is what keeps
 * an admin of another tenant from erasing or exporting a person. Such a request answers 404,
 * deletes and exports nothing and writes no audit entry.
 */
import mongoose, { Model } from 'mongoose';
import { NotFoundException } from '@nestjs/common';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { OutboxEvent, OutboxEventSchema } from '@infrastructure/events/schemas/outbox-event.schema';
import { closeTestDb, connectTestDb } from '@testing';
import { AuditService } from '../audit/audit.service';
import { AuditEvent, AuditEventSchema } from '../audit/schemas/audit-event.schema';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { UserEvent, UserEventSchema } from '../identity/schemas/user-event.schema';
import { ReviewItem, ReviewItemSchema } from '../access-review/schemas/review-item.schema';
import { ReviewExclusion, ReviewExclusionSchema } from '../policy/schemas/review-exclusion.schema';
import type { IdentityEntitlementsService } from '../identity/identity-entitlements.service';
import { GdprErasureService } from './gdpr-erasure.service';
import type { GdprExternalStores } from './gdpr-erasure-external-stores';
import { DsarExportService } from './dsar-export.service';
import { ConsentService } from './consent.service';
import { Consent, ConsentSchema } from './schemas/consent.schema';
import type { NhiOwnershipService } from '../nhi/nhi-ownership.service';

mongoose.plugin(tenantPlugin);

/** No access graph or Elasticsearch index here (gdpr-erasure-reach.integration.spec.ts has them). */
const noExternalStores = {
  count: async () => ({ counts: {}, notReached: [] }),
  erase: async () => ({ counts: {}, notReached: [] }),
} as unknown as GdprExternalStores;

const A = 'tenant-a';
const B = 'tenant-b';
const ADA = '64b7f0c2a1b2c3d4e5f60a02';

/* eslint-disable @typescript-eslint/no-explicit-any -- untyped test models */
describe('GDPR erasure and DSAR export tenant scope (in-memory MongoDB)', () => {
  let identities: Model<any>;
  let userEvents: Model<any>;
  let audit: Model<any>;
  let outbox: Model<any>;
  let erasure: GdprErasureService;
  let dsar: DsarExportService;
  const auditService = { log: jest.fn(), logFireAndForget: jest.fn() };
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    withTenantContext(tenantId, fn) as Promise<T>;

  /** What tenant A holds about Ada. */
  const adaData = () =>
    inTenant(A, async () => ({
      identities: await identities.countDocuments({ _id: ADA }).exec(),
      userEvents: await userEvents.countDocuments({ userId: ADA }).exec(),
      audit: await audit.countDocuments({ resourceId: ADA }).exec(),
      outbox: await outbox.countDocuments({ aggregateId: ADA }).exec(),
    }));

  beforeAll(async () => {
    await connectTestDb();
    const model = (name: string, schema: mongoose.Schema) =>
      mongoose.model(name, schema) as unknown as Model<any>;
    identities = model(Identity.name, IdentitySchema);
    userEvents = model(UserEvent.name, UserEventSchema);
    audit = model(AuditEvent.name, AuditEventSchema);
    outbox = model(OutboxEvent.name, OutboxEventSchema);
    const reviewItems = model(ReviewItem.name, ReviewItemSchema);
    const exclusions = model(ReviewExclusion.name, ReviewExclusionSchema);
    const audited = auditService as unknown as AuditService;
    erasure = new GdprErasureService(
      identities,
      userEvents,
      audit,
      reviewItems,
      exclusions,
      outbox,
      audited,
      mongoose.connection,
      noExternalStores,
      { markOwnerless: jest.fn().mockResolvedValue(0) } as unknown as NhiOwnershipService,
    );
    const consents = model(Consent.name, ConsentSchema);
    dsar = new DsarExportService(
      identities,
      userEvents,
      audit,
      reviewItems,
      exclusions,
      // The subject's grants are read in the request tenant like everything else
      { getEntitlements: async () => null } as unknown as IdentityEntitlementsService,
      new ConsentService(consents, identities),
      audited,
      mongoose.connection,
    );
    // The same identity id in another tenant must not bring that tenant's consent along
    await inTenant(B, () =>
      consents.create({
        tenantId: B,
        identityId: ADA,
        purpose: 'marketing',
        status: 'granted',
        grantedAt: new Date('2026-01-01T00:00:00.000Z'),
        grantedBy: 'dpo@tenant-b.example',
      }),
    );
    await inTenant(A, () =>
      consents.create({
        tenantId: A,
        identityId: ADA,
        purpose: 'analytics',
        status: 'granted',
        grantedAt: new Date('2026-01-01T00:00:00.000Z'),
        grantedBy: 'dpo@tenant-a.example',
        method: 'web-form',
      }),
    );

    await inTenant(A, async () => {
      await identities.create({
        _id: ADA,
        tenantId: A,
        profile: { firstName: 'Ada', lastName: 'Virtanen', email: 'ada@tenant-a.example' },
      });
      await userEvents.create({
        tenantId: A,
        userId: ADA,
        type: 'USER_UPDATED',
        title: 'Profile updated',
        actor: 'hr-sync',
      });
      await audit.create({
        action: 'IDENTITY_UPDATED',
        severity: 'info',
        timestamp: new Date('2026-11-01T10:00:00.000Z'),
        actor: 'op@tenant-a.example',
        resourceType: 'identity',
        resourceId: ADA,
        resourceName: ADA,
        description: 'IDENTITY_UPDATED',
        tenantId: A,
      });
      await outbox.create({
        eventId: 'e1',
        type: 'identity.updated',
        aggregateId: ADA,
        payload: { identityId: ADA },
        metadata: { correlationId: 'e1', depth: 0, emittedBy: 'test', actor: 'test', tenantId: A },
        status: 'published',
        tenantId: A,
      });
    });
  });

  afterEach(() => jest.clearAllMocks());

  afterAll(async () => {
    await closeTestDb();
  });

  it("an erasure from another tenant answers 404 and deletes nothing of the person's", async () => {
    const before = await adaData();
    expect(before).toEqual({ identities: 1, userEvents: 1, audit: 1, outbox: 1 });

    for (const dryRun of [true, false]) {
      await expect(
        inTenant(B, () => erasure.eraseIdentity(ADA, 'dpo@tenant-b.example', dryRun)),
      ).rejects.toThrow(NotFoundException);
    }

    expect(await adaData()).toEqual(before);
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('a DSAR export from another tenant answers 404 and exports nothing', async () => {
    await expect(
      inTenant(B, () => dsar.exportIdentityData(ADA, 'dpo@tenant-b.example')),
    ).rejects.toThrow(NotFoundException);
    expect(auditService.logFireAndForget).not.toHaveBeenCalled();

    // The person's own tenant gets the export
    const pkg = await inTenant(A, () => dsar.exportIdentityData(ADA, 'dpo@tenant-a.example'));
    expect(pkg.dataSubjectId).toBe(ADA);
    expect(pkg.timeline).toHaveLength(1);
    expect(pkg.auditTrail).toHaveLength(1);
    expect(pkg.consents).toEqual([
      expect.objectContaining({ purpose: 'analytics', status: 'granted', method: 'web-form' }),
    ]);
  });
});
