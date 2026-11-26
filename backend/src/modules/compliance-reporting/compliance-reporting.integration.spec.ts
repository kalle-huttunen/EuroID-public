/**
 * The SOX and ISO 27001 report figures on in-memory MongoDB, from audit entries as the platform
 * writes them and campaigns as access reviews store them.
 *
 * Proves:
 *   - Policy changes count the audit actions policy and SoD policy changes are recorded under
 *     (the domain event types). Before, the report counted POLICY_CREATED and the like, which
 *     nothing writes, so it always showed 0 (hunt r2-06 N2).
 *   - GDPR erasures count executed erasures only, not dry runs (hunt 06 F7).
 *   - Campaign figures belong to the report's period and count every campaign: completed within
 *     the period; in progress and overdue as they stood at its end. Before, they were today's
 *     state of at most the newest 100 campaigns, whatever the period (hunt 06 F9).
 */
jest.mock('@temporalio/client', () => ({ Connection: jest.fn(), Client: jest.fn() }));
jest.mock('../../infrastructure/temporal/temporal-client.provider', () => ({
  TemporalClientProvider: { provide: 'TEMPORAL_CLIENT', useValue: {} },
}));

import mongoose, { Model } from 'mongoose';
import { clearTestDb, closeTestDb, connectTestDb } from '@testing';
import { DomainEventType } from '@infrastructure/events/event-types';
import { AuditEvent, AuditEventSchema } from '../audit/schemas/audit-event.schema';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import {
  EntitlementCatalog,
  EntitlementCatalogSchema,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import {
  ReviewCampaign,
  ReviewCampaignSchema,
} from '../access-review/schemas/review-campaign.schema';
import { ReportMetadata, ReportMetadataSchema } from './schemas/report-metadata.schema';
import { SodPolicy, SodPolicySchema } from '../policy/schemas/sod-policy.schema';
import { IdentityRiskScore, RiskScoreSchema } from '../risk-scoring/schemas/risk-score.schema';
import { ComplianceReportingService } from './compliance-reporting.service';
import type { SoxReportPayload } from './templates/sox-report.template';
import type { Iso27001ReportPayload } from './templates/iso27001-report.template';

const A = 'tenant-a';
const PERIOD = { from: new Date('2025-01-01T00:00:00Z'), to: new Date('2025-12-31T23:59:59Z') };
const IN = new Date('2025-06-01T10:00:00Z');

/* eslint-disable @typescript-eslint/no-explicit-any -- untyped test models */
describe('Compliance report figures (in-memory MongoDB)', () => {
  let audit: Model<any>;
  let campaigns: Model<any>;
  let service: ComplianceReportingService;
  const gather = () =>
    service as unknown as {
      gatherIso27001Data(t: string, r: typeof PERIOD): Promise<Iso27001ReportPayload>;
      gatherSoxData(t: string, r: typeof PERIOD): Promise<SoxReportPayload>;
    };

  const model = (name: string, schema: mongoose.Schema) =>
    (mongoose.models[name] ?? mongoose.model(name, schema)) as unknown as Model<any>;

  const entry = (action: string, timestamp: Date, metadata?: Record<string, unknown>) => ({
    tenantId: A,
    action,
    severity: 'info',
    timestamp,
    actor: 'admin@tenant-a.example',
    resourceType: 'policy',
    resourceId: 'p-1',
    description: action,
    ...(metadata ? { payload: { metadata } } : {}),
  });

  let seq = 0;
  /** A campaign as stored, with its own createdAt (the raw driver keeps it as given). */
  const campaign = (fields: Record<string, unknown>) => ({
    tenantId: A,
    campaignId: `c-${++seq}`,
    name: `Campaign ${seq}`,
    scope: { type: 'all' },
    createdBy: 'admin@tenant-a.example',
    stats: { totalItems: 0, approved: 0, revoked: 0, pending: 0, expired: 0 },
    ...fields,
  });

  beforeAll(async () => {
    await connectTestDb();
    audit = model(AuditEvent.name, AuditEventSchema);
    campaigns = model(ReviewCampaign.name, ReviewCampaignSchema);
    const anomalyService = { listByDateRange: jest.fn().mockResolvedValue([]) };
    service = new ComplianceReportingService(
      model(ReportMetadata.name, ReportMetadataSchema),
      model(SodPolicy.name, SodPolicySchema),
      model(IdentityRiskScore.name, RiskScoreSchema),
      audit,
      model(Identity.name, IdentitySchema),
      model(EntitlementCatalog.name, EntitlementCatalogSchema),
      campaigns,
      { verifyIntegrity: jest.fn().mockResolvedValue({ valid: true, eventsChecked: 0 }) } as never,
      {
        getDistribution: jest.fn().mockResolvedValue({ average: 0, median: 0 }),
        getTopRisky: jest.fn().mockResolvedValue([]),
      } as never,
      anomalyService as never,
      { listAllAdminAccounts: jest.fn().mockResolvedValue([]) } as never,
      { emit: jest.fn() } as never,
      { reportsPath: '/nonexistent' } as never,
    );
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('counts the policy and SoD policy changes of the period as they are audited', async () => {
    await audit.collection.insertMany([
      entry(DomainEventType.POLICY_CREATED, IN),
      entry(DomainEventType.POLICY_UPDATED, IN),
      entry(DomainEventType.POLICY_DELETED, IN),
      entry(DomainEventType.SOD_POLICY_CREATED, IN),
      entry(DomainEventType.SOD_POLICY_UPDATED, IN),
      entry(DomainEventType.SOD_POLICY_DELETED, IN),
      // Not a change, and a change outside the period
      entry(DomainEventType.POLICY_EVALUATED, IN),
      entry(DomainEventType.POLICY_UPDATED, new Date('2026-02-01T00:00:00Z')),
    ]);

    const iso = await gather().gatherIso27001Data(A, PERIOD);

    expect(iso.changeManagement.policyChanges).toBe(6);
  });

  // HX-G follow-up: the figure counted every CONFIG_CHANGED, canvas saves that moved a node and
  // node saves without settings included. It counts connector configuration changes only.
  it('counts connector configuration changes, not every canvas save', async () => {
    const config = (resourceType: string, metadata?: Record<string, unknown>) => ({
      ...entry('CONFIG_CHANGED', IN, metadata),
      resourceType,
    });
    await audit.collection.insertMany([
      // The connector store's configuration of an installed connector
      config('connector'),
      // A node's connector settings saved through PATCH /blueprints/:id
      config('blueprint-node', { nodeType: 'entra-id', configKeys: ['tenantId'] }),
      // A canvas save that changed a connector's settings
      config('blueprint', { nodeCount: 3, connectorConfigChanges: ['entra-id'] }),
      // Not connector configuration: a canvas save that changed none (a moved node, an edge),
      // a node save without settings, a canvas save audited before the field existed
      config('blueprint', { nodeCount: 3, connectorConfigChanges: [] }),
      config('blueprint-node', { nodeType: 'entra-id', configKeys: [] }),
      config('blueprint', { nodeCount: 3 }),
      // Outside the period
      { ...config('connector'), timestamp: new Date('2026-02-01T00:00:00Z') },
    ]);

    const iso = await gather().gatherIso27001Data(A, PERIOD);

    expect(iso.changeManagement.connectorConfigChanges).toBe(3);
  });

  it('counts executed GDPR erasures, not their dry runs', async () => {
    await audit.collection.insertMany([
      entry('GDPR_ERASURE_EXECUTED', IN, { dryRun: true, documentCounts: {} }),
      entry('GDPR_ERASURE_EXECUTED', IN, { dryRun: true, documentCounts: {} }),
      entry('GDPR_ERASURE_EXECUTED', IN, { dryRun: false, documentCounts: {} }),
    ]);

    const iso = await gather().gatherIso27001Data(A, PERIOD);

    expect(iso.dataProtection.gdprErasureEvents).toBe(1);
  });

  // Final review RC3: a person's linked admin identities are erased in the same run, each with an
  // entry of its own (metadata.parentIdentityId), so one erasure counted as three
  it('counts one erasure per request, not one per linked admin identity erased with it', async () => {
    await audit.collection.insertMany([
      entry('GDPR_ERASURE_EXECUTED', IN, { dryRun: false, documentCounts: {} }),
      entry('GDPR_ERASURE_EXECUTED', IN, {
        dryRun: false,
        documentCounts: {},
        parentIdentityId: 'person-1',
      }),
      entry('GDPR_ERASURE_EXECUTED', IN, {
        dryRun: false,
        documentCounts: {},
        parentIdentityId: 'person-1',
      }),
    ]);

    const iso = await gather().gatherIso27001Data(A, PERIOD);

    expect(iso.dataProtection.gdprErasureEvents).toBe(1);
  });

  it("counts every campaign of the period, as it stood at the period's end", async () => {
    await campaigns.collection.insertMany([
      // Completed within the period: 105 of them, more than one page of the campaign list
      ...Array.from({ length: 105 }, () =>
        campaign({
          status: 'COMPLETED',
          createdAt: new Date('2025-03-01T00:00:00Z'),
          deadline: new Date('2025-04-01T00:00:00Z'),
          completedAt: IN,
        }),
      ),
      // Completed before the period
      campaign({
        status: 'COMPLETED',
        createdAt: new Date('2024-03-01T00:00:00Z'),
        deadline: new Date('2024-04-01T00:00:00Z'),
        completedAt: new Date('2024-06-01T00:00:00Z'),
      }),
      // In progress at the period's end and past its deadline then; completed later
      campaign({
        status: 'COMPLETED',
        createdAt: new Date('2025-11-01T00:00:00Z'),
        deadline: new Date('2025-12-15T00:00:00Z'),
        completedAt: new Date('2026-03-01T00:00:00Z'),
        stats: { totalItems: 9, approved: 9, revoked: 0, pending: 0, expired: 0 },
      }),
      // In progress at the period's end, deadline later
      campaign({
        status: 'ACTIVE',
        createdAt: new Date('2025-10-01T00:00:00Z'),
        deadline: new Date('2099-01-01T00:00:00Z'),
        stats: { totalItems: 10, approved: 3, revoked: 0, pending: 7, expired: 2 },
      }),
      // Created after the period
      campaign({
        status: 'ACTIVE',
        createdAt: new Date('2026-02-01T00:00:00Z'),
        deadline: new Date('2026-03-01T00:00:00Z'),
        stats: { totalItems: 4, approved: 0, revoked: 0, pending: 4, expired: 0 },
      }),
      // Another tenant's
      { ...campaign({ status: 'COMPLETED', completedAt: IN, createdAt: IN }), tenantId: 'other' },
    ]);

    const iso = await gather().gatherIso27001Data(A, PERIOD);
    const sox = await gather().gatherSoxData(A, PERIOD);

    expect(iso.periodicReviewStatus).toEqual({
      campaignsCompleted: 105,
      campaignsInProgress: 2,
      campaignsOverdue: 1,
    });
    expect(sox.accessCertification).toMatchObject({
      campaignsCompleted: 105,
      campaignsInProgress: 2,
      campaignsOverdue: 1,
      totalPendingReviews: 7,
      autoRevokedItems: 2,
    });
  });
});
