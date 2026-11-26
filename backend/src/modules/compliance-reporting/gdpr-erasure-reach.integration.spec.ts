/**
 * What a GDPR erasure reaches beyond the identity, its timeline, audit entries, review items,
 * exclusions and outbox events (in-memory MongoDB, tenant plugin; the access graph and the
 * Elasticsearch audit index as fakes of GraphService and ElasticsearchService).
 *
 * Hunt 06 F4 and r2-06 N1: the erasure left the person's consent records, NHI ownership (with
 * their email), credential inventory, risk scores, anomalies, peer group membership, joiner,
 * leaver, mover and offboarding records, the upcoming offboarding entry (with email and name),
 * drift findings (with email and name) and access requests, and never touched the access graph
 * (an Identity node with the email) or the Elasticsearch audit index (searchable through
 * GET /analytics/v2/search). An attestation called that erased.
 *
 * Proves, for a real erasure:
 *   - The person's documents in each of those collections are deleted, another person's stay.
 *   - Records that belong to something else keep existing with the person taken out: an NHI agent
 *     keeps its owner id but not the owner's email, a peer group and a policy suggestion lose the
 *     person's id.
 *   - The graph's Identity node and the index's documents filed under the person are deleted (the
 *     erasure entries stay, as in MongoDB), after the bulk buffer is flushed.
 *   - The attestation and the audit entry count each of them; a dry run counts and changes nothing.
 *   - A graph or index the API cannot reach is named in `notReached`, and the rest is erased.
 */
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { OutboxEvent, OutboxEventSchema } from '@infrastructure/events/schemas/outbox-event.schema';
import type { GraphService } from '@infrastructure/graph/graph.service';
import type { ElasticsearchService } from '@infrastructure/elasticsearch/elasticsearch.service';
import { clearTestDb, closeTestDb, connectTestDb } from '@testing';
import type { AuditService } from '../audit/audit.service';
import { AuditEvent, AuditEventSchema } from '../audit/schemas/audit-event.schema';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { UserEvent, UserEventSchema } from '../identity/schemas/user-event.schema';
import { ReviewItem, ReviewItemSchema } from '../access-review/schemas/review-item.schema';
import { ReviewExclusion, ReviewExclusionSchema } from '../policy/schemas/review-exclusion.schema';
import { GdprErasureService } from './gdpr-erasure.service';
import { GdprExternalStores } from './gdpr-erasure-external-stores';
import { ERASURE_TARGETS } from './gdpr-erasure-scope';
import { NhiOwnershipService } from '../nhi/nhi-ownership.service';
import type { NhiService } from '../nhi/nhi.service';
import { AgentIdentity, AgentIdentitySchema } from '../nhi/schemas/agent-identity.schema';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const ADA = '64b7f0c2a1b2c3d4e5f60b01';
const BOB = '64b7f0c2a1b2c3d4e5f60b02';
const DPO = 'dpo@tenant-a.example';
/** Ada's linked admin identity, and Bob's. */
const ADA_ADMIN = '64b7f0c2a1b2c3d4e5f60b11';
const BOB_ADMIN = '64b7f0c2a1b2c3d4e5f60b12';

/* eslint-disable @typescript-eslint/no-explicit-any -- untyped test models */
describe('GDPR erasure reach (in-memory MongoDB)', () => {
  let identities: Model<any>;
  let audit: Model<any>;
  let service: GdprErasureService;
  const inTenant = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;
  const auditService = {
    log: jest.fn(async (entry: Record<string, unknown>) => {
      await audit.create({ ...entry, timestamp: new Date() });
    }),
  };
  const events = { emit: jest.fn() };

  /** The graph: Identity nodes by id; connectionState and the strict calls as GraphService has them. */
  let graphNodes: Set<string>;
  let graphState: 'ok' | 'not-connected' | 'not-configured';
  const graph = {
    connectionState: () => graphState,
    readStrict: jest.fn(async (_cypher: string, params: { id: string }) => ({
      records: [{ get: () => (graphNodes.has(params.id) ? 1 : 0) }],
    })),
    writeStrict: jest.fn(async (_cypher: string, params: { id: string }) => {
      const had = graphNodes.delete(params.id);
      return { records: [{ get: () => (had ? 1 : 0) }] };
    }),
  };

  /** The index: documents with resourceId and action; the query's filters applied as ES would. */
  let indexDocs: Array<{ tenantId: string; resourceId: string; action: string }>;
  let esConnected: boolean;
  type EsQuery = {
    bool: {
      filter: Array<{ term: Record<string, string> }>;
      must_not: Array<{ term: Record<string, string> }>;
    };
  };
  const matches = (doc: Record<string, string>, query: EsQuery) =>
    query.bool.filter.every((f) => Object.entries(f.term).every(([k, v]) => doc[k] === v)) &&
    !query.bool.must_not.some((f) => Object.entries(f.term).every(([k, v]) => doc[k] === v));
  const es = {
    isAvailable: () => esConnected,
    count: jest.fn(
      async (_index: string, query: EsQuery) => indexDocs.filter((d) => matches(d, query)).length,
    ),
    deleteByQuery: jest.fn(async (_index: string, query: EsQuery) => {
      const before = indexDocs.length;
      indexDocs = indexDocs.filter((d) => !matches(d, query));
      return before - indexDocs.length;
    }),
  };

  const model = (name: string, schema: mongoose.Schema) =>
    (mongoose.models[name] ?? mongoose.model(name, schema)) as unknown as Model<any>;
  const raw = (name: string) =>
    mongoose.connection.collection(mongoose.models[name].collection.name);

  beforeAll(async () => {
    await connectTestDb();
    identities = model(Identity.name, IdentitySchema);
    audit = model(AuditEvent.name, AuditEventSchema);
    for (const target of ERASURE_TARGETS) model(target.model, target.schema);
    service = new GdprErasureService(
      identities,
      model(UserEvent.name, UserEventSchema),
      audit,
      model(ReviewItem.name, ReviewItemSchema),
      model(ReviewExclusion.name, ReviewExclusionSchema),
      model(OutboxEvent.name, OutboxEventSchema),
      auditService as unknown as AuditService,
      mongoose.connection,
      new GdprExternalStores(
        graph as unknown as GraphService,
        es as unknown as ElasticsearchService,
      ),
      // The real marking, as offboarding uses it: one audit entry and one event per agent
      new NhiOwnershipService(
        model(AgentIdentity.name, AgentIdentitySchema) as never,
        {} as NhiService,
        auditService as unknown as AuditService,
        events as unknown as DomainEventEmitterService,
      ),
    );
  });

  /** One document of the person and one of Bob in each collection the erasure now reaches. */
  async function seed() {
    graphNodes = new Set([ADA, BOB]);
    graphState = 'ok';
    esConnected = true;
    indexDocs = [
      { tenantId: A, resourceId: ADA, action: 'identity.updated' },
      { tenantId: A, resourceId: ADA, action: 'provisioning.completed' },
      { tenantId: A, resourceId: ADA, action: 'GDPR_ERASURE_EXECUTED' },
      { tenantId: A, resourceId: BOB, action: 'identity.updated' },
      { tenantId: 'tenant-b', resourceId: ADA, action: 'identity.updated' },
    ];
    await inTenant(() =>
      identities.create({
        _id: ADA,
        tenantId: A,
        profile: { firstName: 'Ada', lastName: 'Virtanen', email: 'ada@tenant-a.example' },
      }),
    );
    const both = (doc: (id: string) => Record<string, unknown>) => [
      { tenantId: A, ...doc(ADA) },
      { tenantId: A, ...doc(BOB) },
    ];
    await raw('Consent').insertMany(both((id) => ({ identityId: id, purpose: 'marketing' })));
    await raw('CredentialInventory').insertMany(
      both((id) => ({ identityId: id, targetSystem: 'ad', externalId: `CN=${id}` })),
    );
    await raw('IdentityRiskScore').insertMany(both((id) => ({ identityId: id, score: 40 })));
    await raw('RiskScore').insertMany(both((id) => ({ identityId: id, riskScore: 40 })));
    await raw('Anomaly').insertMany(
      both((id) => ({ identityId: id, anomalyId: `an-${id}`, title: 'Ada logged in at 3 am' })),
    );
    await raw('JoinerEvent').insertMany(both((id) => ({ identityId: id, sourceName: 'hr' })));
    await raw('LeaverEvent').insertMany(both((id) => ({ identityId: id, sourceName: 'hr' })));
    await raw('OffboardingRecord').insertMany(
      both((id) => ({ identityId: id, workflowId: `wf-${id}` })),
    );
    await raw('MoverBatchItem').insertMany(
      both((id) => ({ identityId: id, changes: [{ field: 'title', newValue: 'CFO' }] })),
    );
    await raw('UpcomingOffboarding').insertMany(
      both((id) => ({ identityId: id, email: `${id}@tenant-a.example` })),
    );
    await raw('Drift').insertMany(
      both((id) => ({ userId: id, userEmail: `${id}@tenant-a.example`, type: 'FIELD_MISMATCH' })),
    );
    await raw('AccessRequest').insertMany([
      // For Ada (requested by her manager), and her own request
      { tenantId: A, requestId: 'r1', requesterId: 'mgr', targetIdentityId: ADA },
      { tenantId: A, requestId: 'r2', requesterId: ADA, requesterEmail: 'ada@tenant-a.example' },
      { tenantId: A, requestId: 'r3', requesterId: BOB },
    ]);
    await raw('AgentIdentity').insertMany([
      // An agent always has a display name and kind (the ownerless audit entry names it)
      {
        tenantId: A,
        agentId: 'ada-bot',
        displayName: 'Ada bot',
        kind: 'bot',
        status: 'active',
        owner: { identityId: ADA, email: 'ada@tenant-a.example' },
      },
      {
        tenantId: A,
        agentId: 'bob-bot',
        displayName: 'Bob bot',
        kind: 'bot',
        status: 'active',
        owner: { identityId: BOB, email: 'bob@tenant-a.example' },
      },
    ]);
    await raw('PeerGroup').insertOne({
      tenantId: A,
      groupKey: 'finance',
      memberIds: [ADA, BOB],
      outliers: [{ identityId: ADA, deviationScore: 80 }],
    });
    await raw('PolicySuggestion').insertOne({
      tenantId: A,
      suggestionId: 's1',
      evidence: { sampleUserIds: [ADA, BOB] },
    });
  }

  beforeEach(seed);

  afterEach(async () => {
    jest.clearAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const left = async (name: string) =>
    (await raw(name).find({}).toArray()).map((d) => d.identityId ?? d.userId ?? d.requestId);

  it('deletes the person from every collection that refers to them, and leaves Bob', async () => {
    const attestation = await inTenant(() => service.eraseIdentity(ADA, DPO, false));

    for (const name of [
      'Consent',
      'CredentialInventory',
      'IdentityRiskScore',
      'RiskScore',
      'Anomaly',
      'JoinerEvent',
      'LeaverEvent',
      'OffboardingRecord',
      'MoverBatchItem',
      'UpcomingOffboarding',
      'Drift',
    ]) {
      expect([name, await left(name)]).toEqual([name, [BOB]]);
    }
    expect(await left('AccessRequest')).toEqual(['r3']);
    expect(attestation.documentCounts).toMatchObject({
      identities: 1,
      consents: 1,
      credential_inventory: 1,
      identity_risk_scores: 1,
      risk_scores: 1,
      anomalies: 1,
      joiner_events: 1,
      leaver_events: 1,
      offboarding_records: 1,
      mover_batch_items: 1,
      upcoming_offboardings: 1,
      drift_records: 1,
      access_requests: 2,
    });
    expect(attestation.collectionsAffected).toEqual(
      expect.arrayContaining(['consents', 'access_requests', 'agent_identities']),
    );
    expect(attestation.notReached).toEqual([]);
  });

  it('takes the person out of records that stay: NHI ownership, peer groups, suggestions', async () => {
    const attestation = await inTenant(() => service.eraseIdentity(ADA, DPO, false));

    const agents = await raw('AgentIdentity')
      .find({}, { sort: { agentId: 1 } })
      .toArray();
    expect(agents.map((a) => [a.agentId, a.owner])).toEqual([
      ['ada-bot', { identityId: ADA, email: '(erased)' }],
      ['bob-bot', { identityId: BOB, email: 'bob@tenant-a.example' }],
    ]);
    // HX-G follow-up: the agent is marked ownerless, so it gets no new credential until someone
    // gives it a new owner or revokes it
    expect(agents[0]).toMatchObject({
      ownerlessReason: 'erased',
      ownerlessSince: expect.any(Date),
    });
    expect(agents[1].ownerlessSince).toBeUndefined();
    const group = await raw('PeerGroup').findOne({});
    expect(group).toMatchObject({ memberIds: [BOB], outliers: [] });
    const suggestion = await raw('PolicySuggestion').findOne({});
    expect(suggestion?.evidence).toEqual({ sampleUserIds: [BOB] });
    expect(attestation.documentCounts).toMatchObject({
      agent_identities: 1,
      peer_groups: 1,
      policy_suggestions: 1,
    });
  });

  // Final review RC2: an admin who created (or revoked) an agent they own kept their email in
  // createdBy / revokedBy after their erasure
  it("takes the person's email out of who created or revoked their agents, and only theirs", async () => {
    await raw('AgentIdentity').updateOne(
      { agentId: 'ada-bot' },
      { $set: { createdBy: 'Ada@Tenant-A.example', revokedBy: 'ada@tenant-a.example' } },
    );
    await raw('AgentIdentity').insertOne({
      tenantId: A,
      agentId: 'ada-other-bot',
      displayName: 'Ada other bot',
      kind: 'bot',
      status: 'active',
      owner: { identityId: ADA, email: 'ada@tenant-a.example' },
      createdBy: 'admin@tenant-a.example',
    });

    await inTenant(() => service.eraseIdentity(ADA, DPO, false));

    const mine = await raw('AgentIdentity').findOne({ agentId: 'ada-bot' });
    expect(mine).toMatchObject({ createdBy: '(erased)', revokedBy: '(erased)' });
    const other = await raw('AgentIdentity').findOne({ agentId: 'ada-other-bot' });
    expect(other?.createdBy).toBe('admin@tenant-a.example');
    expect(other?.revokedBy).toBeUndefined();
  });

  // HX-G3: the erasure marked the owner's agents ownerless without the per-agent audit entry and
  // nhi.owner_lost event offboarding writes, so a webhook-driven process missed them
  describe("the erased owner's agents", () => {
    const ownerLost = () =>
      events.emit.mock.calls.filter(([type]) => type === DomainEventType.NHI_OWNER_LOST);
    const ownerlessEntries = () =>
      inTenant(() => audit.find({ action: 'AGENT_IDENTITY_OWNERLESS' }).lean().exec());

    it('writes the audit entry and emits nhi.owner_lost for each agent it newly marks, with no personal data', async () => {
      await inTenant(() => service.eraseIdentity(ADA, DPO, false));

      expect(ownerLost()).toEqual([
        [
          DomainEventType.NHI_OWNER_LOST,
          'ada-bot',
          { agentId: 'ada-bot', ownerIdentityId: ADA, reason: 'erased' },
          { tenantId: A, actor: 'nhi-ownership' },
        ],
      ]);
      const entries = await ownerlessEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        resourceId: 'ada-bot',
        severity: 'warning',
        payload: { metadata: { ownerIdentityId: ADA, reason: 'erased' } },
      });
      expect(JSON.stringify([ownerLost(), entries])).not.toContain('ada@tenant-a.example');
      const agent = await raw('AgentIdentity').findOne({ agentId: 'ada-bot' });
      expect(agent).toMatchObject({ ownerlessReason: 'erased', owner: { email: '(erased)' } });
    });

    it('writes neither for an agent marked at offboarding before, or revoked, and keeps its date', async () => {
      const offboardedAt = new Date('2026-10-01T10:00:00Z');
      await raw('AgentIdentity').updateOne(
        { agentId: 'ada-bot' },
        { $set: { ownerlessSince: offboardedAt, ownerlessReason: 'offboarded' } },
      );
      await raw('AgentIdentity').insertOne({
        tenantId: A,
        agentId: 'ada-revoked-bot',
        displayName: 'Ada old bot',
        kind: 'bot',
        status: 'revoked',
        owner: { identityId: ADA, email: 'ada@tenant-a.example' },
      });

      await inTenant(() => service.eraseIdentity(ADA, DPO, false));

      expect(ownerLost()).toEqual([]);
      expect(await ownerlessEntries()).toEqual([]);
      const marked = await raw('AgentIdentity').findOne({ agentId: 'ada-bot' });
      expect(marked?.ownerlessSince).toEqual(offboardedAt);
    });

    it('a dry run writes neither', async () => {
      await inTenant(() => service.eraseIdentity(ADA, DPO, true));

      expect(ownerLost()).toEqual([]);
      expect(await ownerlessEntries()).toEqual([]);
    });
  });

  it("removes the person's graph node and indexed audit documents, keeping the erasure entries", async () => {
    const attestation = await inTenant(() => service.eraseIdentity(ADA, DPO, false));

    expect([...graphNodes]).toEqual([BOB]);
    expect(graph.writeStrict).toHaveBeenCalledWith(expect.stringContaining('DETACH DELETE'), {
      id: ADA,
      tenantId: A,
    });
    expect(indexDocs).toEqual([
      { tenantId: A, resourceId: ADA, action: 'GDPR_ERASURE_EXECUTED' },
      { tenantId: A, resourceId: BOB, action: 'identity.updated' },
      { tenantId: 'tenant-b', resourceId: ADA, action: 'identity.updated' },
    ]);
    expect(attestation.documentCounts).toMatchObject({
      access_graph: 1,
      elasticsearch_audit_events: 2,
    });
    // The erasure entry counts them too
    const entry = auditService.log.mock.calls[0][0] as { payload: { metadata: any } };
    expect(entry.payload.metadata.documentCounts).toMatchObject({
      consents: 1,
      access_graph: 1,
      elasticsearch_audit_events: 2,
    });
  });

  it('a dry run counts every store and changes nothing', async () => {
    const preview = await inTenant(() => service.eraseIdentity(ADA, DPO, true));

    expect(preview.documentCounts).toMatchObject({
      consents: 1,
      agent_identities: 1,
      peer_groups: 1,
      access_requests: 2,
      access_graph: 1,
      elasticsearch_audit_events: 2,
    });
    expect(await left('Consent')).toEqual([ADA, BOB]);
    expect(graphNodes.has(ADA)).toBe(true);
    expect(indexDocs).toHaveLength(5);
    expect(graph.writeStrict).not.toHaveBeenCalled();
    expect(es.deleteByQuery).not.toHaveBeenCalled();
  });

  // HX-G follow-up: the erasure did not reach the person's linked admin identities
  // (parentIdentityId), so their name and admin UPN stayed unless each was erased by hand.
  describe("the person's linked admin identities", () => {
    beforeEach(async () => {
      graphNodes.add(ADA_ADMIN);
      graphNodes.add(BOB_ADMIN);
      indexDocs.push({ tenantId: A, resourceId: ADA_ADMIN, action: 'identity.created' });
      const admin = (id: string, parent: string, first: string) => ({
        _id: id,
        tenantId: A,
        parentIdentityId: parent,
        adminTier: 'TIER_0',
        profile: {
          firstName: first,
          lastName: 'Virtanen',
          email: `adm-${first.toLowerCase()}@tenant-a.example`,
          employmentType: 'ADMIN_ACCOUNT',
        },
      });
      await inTenant(() =>
        identities.create([admin(ADA_ADMIN, ADA, 'Ada'), admin(BOB_ADMIN, BOB, 'Bob')]),
      );
      await raw('Consent').insertOne({ tenantId: A, identityId: ADA_ADMIN, purpose: 'marketing' });
      await raw('CredentialInventory').insertOne({
        tenantId: A,
        identityId: ADA_ADMIN,
        targetSystem: 'entra-id',
        externalId: 'adm-ada',
      });
    });

    it('erases them in the same run, with the same scope, each in the attestation', async () => {
      const attestation = await inTenant(() => service.eraseIdentity(ADA, DPO, false));

      const ids = await inTenant(() => identities.find({}).select('_id').lean().exec());
      expect(ids.map((d: any) => String(d._id))).toEqual([BOB_ADMIN]);
      expect(await left('Consent')).toEqual([BOB]);
      expect(await left('CredentialInventory')).toEqual([BOB]);
      expect([...graphNodes].sort()).toEqual([BOB, BOB_ADMIN].sort());
      expect(indexDocs.some((d) => d.resourceId === ADA_ADMIN)).toBe(false);
      expect(attestation.linkedAdminIdentities).toEqual([
        expect.objectContaining({
          identityId: ADA_ADMIN,
          adminTier: 'TIER_0',
          documentCounts: expect.objectContaining({
            identities: 1,
            consents: 1,
            credential_inventory: 1,
            access_graph: 1,
            elasticsearch_audit_events: 1,
          }),
          notReached: [],
        }),
      ]);
      // Each identity gets its own erasure entry; the person's names the admin identities
      const entries = auditService.log.mock.calls.map(([e]) => e as any);
      const adminEntry = entries.find((e) => e.resourceId === ADA_ADMIN);
      expect(adminEntry.payload.metadata).toMatchObject({ dryRun: false, parentIdentityId: ADA });
      const personEntry = entries.find((e) => e.resourceId === ADA);
      expect(personEntry.payload.metadata.linkedAdminIdentityIds).toEqual([ADA_ADMIN]);
    });

    it('a dry run lists them with their counts and erases nothing', async () => {
      const preview = await inTenant(() => service.eraseIdentity(ADA, DPO, true));

      expect(preview.linkedAdminIdentities).toEqual([
        expect.objectContaining({
          identityId: ADA_ADMIN,
          documentCounts: expect.objectContaining({ identities: 1, consents: 1 }),
        }),
      ]);
      expect(await inTenant(() => identities.countDocuments({ _id: ADA_ADMIN }).exec())).toBe(1);
      expect(graphNodes.has(ADA_ADMIN)).toBe(true);
    });

    it('names a store it could not reach for an admin identity in the top-level notReached', async () => {
      esConnected = false;

      const attestation = await inTenant(() => service.eraseIdentity(ADA, DPO, false));

      expect(attestation.notReached).toEqual(['elasticsearch_audit_events']);
      expect(attestation.linkedAdminIdentities?.[0].notReached).toEqual([
        'elasticsearch_audit_events',
      ]);
    });
  });

  it('names a graph or index it cannot reach and erases the rest', async () => {
    graphState = 'not-connected';
    esConnected = false;

    const attestation = await inTenant(() => service.eraseIdentity(ADA, DPO, false));

    expect(attestation.notReached).toEqual(['access_graph', 'elasticsearch_audit_events']);
    expect(await left('Consent')).toEqual([BOB]);
    expect(await inTenant(() => identities.countDocuments({ _id: ADA }).exec())).toBe(0);
    const entry = auditService.log.mock.calls[0][0] as { payload: { metadata: any } };
    expect(entry.payload.metadata.notReached).toEqual([
      'access_graph',
      'elasticsearch_audit_events',
    ]);
  });

  it('counts nothing in a graph that is not configured, and does not call it', async () => {
    graphState = 'not-configured';

    const attestation = await inTenant(() => service.eraseIdentity(ADA, DPO, false));

    expect(attestation.notReached).toEqual([]);
    expect(attestation.documentCounts.access_graph).toBe(0);
    expect(graph.writeStrict).not.toHaveBeenCalled();
  });
});
