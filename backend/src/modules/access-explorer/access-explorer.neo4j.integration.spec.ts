/**
 * The access explorer against a real Neo4j, with the tenant's state in an in-memory MongoDB:
 * GraphResyncService fills the graph from MongoDB (identities, catalog, policy grants on synced
 * accounts, active requests), removes what MongoDB no longer has for the tenant and leaves other
 * tenants alone; the four explorer queries answer from what it wrote (LIMIT as an integer,
 * OPTIONAL MATCH answers for missing nodes, shortestPath with a missing end). Between resyncs
 * GraphSyncService names entitlements from discovery.completed and removes a deleted identity;
 * a GraphService that could not reach Neo4j at start connects on a later call. Connecting creates
 * the uniqueness constraints on (tenantId, id) of the three node labels, so a second node with a
 * label's tenant and id is refused. A group most identities get from a rule that names it by
 * display name is one node, the catalog's (system::native id), with every holder however they got it,
 * for holders, paths and SoD; the node the old key made goes with the next resync.
 *
 * Opt-in, like the Redis suite: NEO4J_TEST_URL=bolt://127.0.0.1:7697 NEO4J_TEST_PASSWORD=...
 * (NEO4J_TEST_USER, default neo4j), a throwaway Neo4j 5. The test only touches nodes of its own
 * random tenants and removes them at the end. Policy evaluation is stubbed (one rule set per
 * identity); it is not what this suite checks.
 */
import mongoose, { Model } from 'mongoose';
import neo4j from 'neo4j-driver';
import { ConfigService } from '@nestjs/config';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { GRAPH_UNAVAILABLE, GraphService } from '@infrastructure/graph/graph.service';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { DomainEventType } from '@infrastructure/events/event-types';
import { connectTestDb, closeTestDb } from '@testing';
import { IdentitySchema, type IdentityDocument } from '../identity/schemas/identity.schema';
import { EntitlementCatalogSchema } from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { AccessRequestSchema } from '../access-requests/schemas/access-request.schema';
import { SodPolicySchema } from '../policy/schemas/sod-policy.schema';
import type { IdentityService } from '../identity/identity.service';
import type { PolicyEngineService } from '../policy/policy-engine.service';
import { AccessExplorerService } from './access-explorer.service';
import { GraphResyncService } from './graph-resync.service';
import { MemoryOwnedLockStore } from '@infrastructure/cache/owned-lock.store';
import { GraphSyncService } from './graph-sync.service';

/** Entra ID's part of an entitlement's graph key (entitlement-node-id.ts). */
const E = 'entra-id::';
const NEO4J_TEST_URL = process.env.NEO4J_TEST_URL;
const describeNeo4j = NEO4J_TEST_URL ? describe : describe.skip;

mongoose.plugin(tenantPlugin);

/** The test Neo4j's settings, as ConfigService answers them, with `extra` on top. */
const configFor = (extra: Record<string, string> = {}) =>
  ({
    get: (key: string) =>
      ({
        NEO4J_URL: NEO4J_TEST_URL,
        NEO4J_USER: process.env.NEO4J_TEST_USER ?? 'neo4j',
        NEO4J_PASSWORD: process.env.NEO4J_TEST_PASSWORD,
        ...extra,
      })[key],
  }) as unknown as ConfigService;

describeNeo4j('Access explorer with a real Neo4j', () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const TENANT = `explorer-it-${suffix}`;
  const OTHER = `explorer-it-other-${suffix}`;
  const RULE = `explorer-it-rule-${suffix}`;
  const COLLIDE = `explorer-it-collide-${suffix}`;
  let graph: GraphService;
  let explorer: AccessExplorerService;
  let resync: GraphResyncService;
  let sync: GraphSyncService;
  let catalogModel: Model<unknown>;
  let ids: { ada: string; bob: string; carol: string };

  const inTenant = <T>(fn: () => Promise<T>) => withTenantContext(TENANT, fn);
  const raw = (cypher: string, params: Record<string, unknown> = {}) =>
    graph.writeStrict(cypher, params);
  const event = <T>(type: DomainEventType, payload: T, tenantId = TENANT): DomainEvent<T> => ({
    eventId: `evt-${type}`,
    type,
    aggregateId: 'agg',
    timestamp: new Date().toISOString(),
    payload,
    metadata: { correlationId: 'it', depth: 0, emittedBy: 'test', actor: 'test', tenantId },
  });

  beforeAll(async () => {
    await connectTestDb();
    mongoose.set('autoIndex', false);
    const identityModel = mongoose.model(
      'Identity',
      IdentitySchema,
    ) as unknown as Model<IdentityDocument>;
    catalogModel = mongoose.model('EntitlementCatalog', EntitlementCatalogSchema) as Model<unknown>;
    const requestModel = mongoose.model('AccessRequest', AccessRequestSchema);
    const sodModel = mongoose.model('SodPolicy', SodPolicySchema);

    graph = new GraphService(configFor());
    await graph.onModuleInit();
    graph.assertAvailable();

    await inTenant(async () => {
      type Provisioning = Array<{ targetSystem: string; status: 'SYNCED' | 'PENDING' }>;
      const person = (
        name: string,
        provisioning: Provisioning,
        extra: Record<string, unknown> = {},
      ) =>
        identityModel.create({
          tenantId: TENANT,
          profile: {
            firstName: name,
            lastName: 'Test',
            email: `${name}@corp.example`,
            status: 'ACTIVE',
          },
          provisioning,
          ...extra,
        });
      const ada = await person('ada', [{ targetSystem: 'entra-id', status: 'SYNCED' }]);
      const bob = await person('bob', [{ targetSystem: 'entra-id', status: 'PENDING' }]);
      const carol = await person('carol', [], { deletedAt: new Date() });
      ids = { ada: String(ada._id), bob: String(bob._id), carol: String(carol._id) };

      const entry = (nativeId: string | undefined, name: string) =>
        catalogModel.create({
          tenantId: TENANT,
          system: 'entra-id',
          name,
          type: 'Group',
          ...(nativeId ? { nativeId } : {}),
        });
      await entry('grp-all', 'All staff');
      await entry('grp-fin-admin', 'Finance-Admin');
      await entry('grp-fin-appr', 'Finance-Approver');
      await entry(undefined, 'Registered by name only');

      const request = (
        requestId: string,
        identityId: string,
        nativeId: string,
        status = 'ACTIVE',
      ) =>
        requestModel.create({
          tenantId: TENANT,
          requestId,
          requesterId: identityId,
          requesterEmail: 'requester@corp.example',
          targetIdentityId: identityId,
          status,
          entitlements: [
            {
              catalogEntryId: 'c1',
              system: 'entra-id',
              entitlementName: nativeId,
              nativeId,
              justification: 'work',
            },
          ],
        });
      await request(`REQ-${suffix}-1`, ids.ada, 'grp-fin-appr');
      await request(`REQ-${suffix}-2`, ids.bob, 'grp-fin-appr');
      await request(`REQ-${suffix}-3`, ids.bob, 'grp-fin-admin', 'REVOKED');

      await sodModel.create({
        tenantId: TENANT,
        name: 'Finance SoD',
        severity: 'HIGH',
        action: 'BLOCK',
        isActive: true,
        conflictingEntitlements: [
          { system: 'entra-id', type: 'group', targetId: 'grp-fin-admin' },
          { system: 'entra-id', type: 'group', targetId: 'grp-fin-appr' },
        ],
      });
    });

    // What a graph out of step with MongoDB holds: a removed identity, an edge to an entitlement
    // the catalog dropped, an application nobody has; and another tenant's node with the same id.
    await raw(
      `MERGE (s:Identity {id: 'stale-identity', tenantId: $t})
       MERGE (g:Entitlement {id: 'grp-gone', tenantId: $t})
       MERGE (s)-[:HAS_ACCESS]->(g)
       MERGE (a:Identity {id: $ada, tenantId: $t})
       MERGE (a)-[:HAS_ACCESS]->(g)
       MERGE (:Application {id: 'old-app', tenantId: $t})
       MERGE (:Identity {id: $ada, tenantId: $other})`,
      { t: TENANT, other: OTHER, ada: ids.ada },
    );

    const identityService = {
      buildProfileWithContractsForPolicy: async (doc: { _id: unknown }) => ({
        id: String(doc._id),
      }),
    } as unknown as IdentityService;
    const policyEngine = {
      evaluateOperationsWithoutSod: async (profile: { id: string }) =>
        profile.id === ids.ada
          ? [
              {
                action: 'add',
                type: 'group',
                target: 'entra-id',
                targetId: 'grp-all',
                sourcePolicy: 'All staff',
              },
              {
                action: 'add',
                type: 'group',
                target: 'entra-id',
                targetId: 'grp-fin-admin',
                sourcePolicy: 'Finance',
              },
            ]
          : [],
    } as unknown as PolicyEngineService;

    explorer = new AccessExplorerService(graph, sodModel as never, catalogModel as never);
    resync = new GraphResyncService(
      graph,
      identityModel,
      catalogModel as never,
      requestModel as never,
      identityService,
      policyEngine,
      new MemoryOwnedLockStore(),
    );
    sync = new GraphSyncService(graph, identityModel, catalogModel as never);
  }, 60_000);

  afterAll(async () => {
    if (graph) {
      await raw('MATCH (n) WHERE n.tenantId IN $tenants DETACH DELETE n', {
        tenants: [TENANT, OTHER, RULE, COLLIDE],
      });
      await graph.onModuleDestroy();
    }
    await closeTestDb();
  });

  it('fills the graph from MongoDB and removes what MongoDB no longer has, in this tenant only', async () => {
    const result = await inTenant(() => resync.resync(TENANT));

    expect(result).toMatchObject({
      identities: 2,
      applications: 1,
      entitlements: 3,
      grants: { policy: 2, request: 2 },
      // The stale identity's edge and ada's edge to grp-gone
      removed: { identities: 1, entitlements: 1, applications: 1, relationships: 2 },
    });
    const left = await graph.readStrict(
      'MATCH (n {tenantId: $t}) RETURN labels(n)[0] + ":" + n.id AS key ORDER BY key',
      { t: TENANT },
    );
    expect(left.records.map((r) => r.get('key'))).toEqual(
      [
        'Application:entra-id',
        'Entitlement:entra-id::grp-all',
        'Entitlement:entra-id::grp-fin-admin',
        'Entitlement:entra-id::grp-fin-appr',
        `Identity:${ids.ada}`,
        `Identity:${ids.bob}`,
      ].sort(),
    );
    const other = await graph.readStrict('MATCH (n {tenantId: $t}) RETURN count(n) AS n', {
      t: OTHER,
    });
    expect(other.records[0].get('n').toNumber()).toBe(1);
  });

  it('holds a uniqueness constraint on (tenantId, id) per node label, refusing a second node', async () => {
    const constraints = await graph.readStrict(
      `SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties
       WHERE name ENDS WITH '_tenant_id_unique'
       RETURN name, type, labelsOrTypes, properties ORDER BY name`,
    );
    expect(
      constraints.records.map((r) => [
        r.get('name'),
        r.get('type'),
        r.get('labelsOrTypes'),
        r.get('properties'),
      ]),
    ).toEqual(
      ['Application', 'Entitlement', 'Identity'].map((label) => [
        `${label.toLowerCase()}_tenant_id_unique`,
        expect.stringContaining('UNIQUENESS'),
        [label],
        ['tenantId', 'id'],
      ]),
    );

    await expect(
      raw('CREATE (:Identity {id: $ada, tenantId: $t})', { ada: ids.ada, t: TENANT }),
    ).rejects.toThrow(GRAPH_UNAVAILABLE.queryFailed);
    // Created again at every connection: a no-op once there
    await expect(graph.ensureNodeConstraints()).resolves.toBeUndefined();
  });

  it('is idempotent: a second run writes the same and removes nothing', async () => {
    const result = await inTenant(() => resync.resync(TENANT));

    expect(result.removed).toEqual({
      identities: 0,
      entitlements: 0,
      applications: 0,
      relationships: 0,
    });
    const edges = await graph.readStrict(
      'MATCH (:Identity {tenantId: $t})-[r:HAS_ACCESS]->() RETURN count(r) AS n',
      { t: TENANT },
    );
    expect(edges.records[0].get('n').toNumber()).toBe(4);
  });

  it("answers an identity's graph with how each entitlement was granted", async () => {
    const result = await explorer.getIdentityAccessGraph(ids.ada, TENANT);

    expect(result.identityFound).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.nodes.map((n) => n.id).sort()).toEqual(
      [`${E}grp-all`, `${E}grp-fin-admin`, `${E}grp-fin-appr`, ids.ada].sort(),
    );
    const grants = result.relationships.map((r) => [
      r.sourceId,
      r.targetId,
      r.properties.grantedBy,
      r.properties.source,
    ]);
    expect(grants).toEqual(
      expect.arrayContaining([
        [ids.ada, `${E}grp-all`, 'policy', 'All staff'],
        [ids.ada, `${E}grp-fin-appr`, 'request', `Access request REQ-${suffix}-1`],
      ]),
    );

    const unknown = await explorer.getIdentityAccessGraph(ids.carol, TENANT);
    expect(unknown).toMatchObject({ identityFound: false, nodes: [], relationships: [] });
  });

  it('answers the holders of an entitlement, and one the graph does not have', async () => {
    const held = await explorer.getEntitlementHolders(`${E}grp-fin-appr`, TENANT);
    expect(held.entitlement?.label).toBe('Finance-Approver');
    expect(held.entitlement?.properties).toMatchObject({
      nativeId: 'grp-fin-appr',
      system: 'entra-id',
    });
    expect(held.holders.map((h) => h.identity.id).sort()).toEqual([ids.ada, ids.bob].sort());

    const none = await explorer.getEntitlementHolders('grp-gone', TENANT);
    expect(none).toEqual({ entitlement: null, holders: [], truncated: false });
  });

  it('answers the shortest path, and which end is missing when there is none', async () => {
    const found = await explorer.findAccessPath(ids.ada, `${E}grp-fin-admin`, TENANT);
    expect(found.path?.depth).toBe(1);
    expect(found.path?.relationships[0]).toMatchObject({
      sourceId: ids.ada,
      targetId: `${E}grp-fin-admin`,
    });

    // bob's request for grp-fin-admin was revoked: both ends exist, no path
    expect(await explorer.findAccessPath(ids.bob, `${E}grp-fin-admin`, TENANT)).toEqual({
      identityFound: true,
      entitlementFound: true,
      path: null,
    });
    expect(await explorer.findAccessPath(ids.carol, `${E}grp-nowhere`, TENANT)).toEqual({
      identityFound: false,
      entitlementFound: false,
      path: null,
    });
  });

  it('finds the SoD violation of an identity holding both entitlements, none for the other', async () => {
    const ada = await explorer.getTransitiveSodViolations(ids.ada, TENANT);
    expect(ada.identityFound).toBe(true);
    expect(ada.policiesChecked).toBe(1);
    expect(ada.violations.map((v) => [v.policyName, v.entitlementA.id, v.entitlementB.id])).toEqual(
      [['Finance SoD', `${E}grp-fin-admin`, `${E}grp-fin-appr`]],
    );

    const bob = await explorer.getTransitiveSodViolations(ids.bob, TENANT);
    expect(bob).toEqual({ identityFound: true, policiesChecked: 1, violations: [] });
  });

  it('names an entitlement and its application from discovery.completed, keeping its holders', async () => {
    // Provisioning links ada to a group the catalog does not have yet: the node is its own key
    await sync.onProvisioningCompleted(
      event(DomainEventType.PROVISIONING_COMPLETED, {
        identityId: ids.ada,
        connector: 'okta',
        operations: [
          { action: 'add' as const, type: 'group' as const, targetId: 'okta-eng', success: true },
        ],
        durationMs: 1,
      }),
    );
    expect(
      (await explorer.getEntitlementHolders('okta::okta-eng', TENANT)).entitlement?.label,
    ).toBe('okta::okta-eng');

    await inTenant(() =>
      catalogModel.create({
        tenantId: TENANT,
        system: 'okta',
        nativeId: 'okta-eng',
        name: 'Okta Engineers',
        type: 'Group',
      }),
    );
    await sync.onDiscoveryCompleted(
      event(DomainEventType.DISCOVERY_COMPLETED, { system: 'okta', discovered: 1, removed: 0 }),
    );

    const held = await explorer.getEntitlementHolders('okta::okta-eng', TENANT);
    expect(held.entitlement?.label).toBe('Okta Engineers');
    expect(held.holders.map((h) => h.identity.id)).toEqual([ids.ada]);
    const app = await graph.readStrict(
      `MATCH (:Entitlement {id: 'okta::okta-eng', tenantId: $t})-[:BELONGS_TO]->(a:Application)
       WHERE a.tenantId = $t RETURN a.id AS id`,
      { t: TENANT },
    );
    expect(app.records.map((r) => r.get('id'))).toEqual(['okta']);
  });

  it("removes a deleted identity's node and edges on identity.deleted, in this tenant only", async () => {
    await sync.onIdentityDeleted(
      event(DomainEventType.IDENTITY_DELETED, {
        identityId: ids.ada,
        reason: 'offboarding-workflow',
      }),
    );

    expect((await explorer.getIdentityAccessGraph(ids.ada, TENANT)).identityFound).toBe(false);
    const held = await explorer.getEntitlementHolders(`${E}grp-fin-appr`, TENANT);
    expect(held.entitlement?.label).toBe('Finance-Approver');
    expect(held.holders.map((h) => h.identity.id)).toEqual([ids.bob]);
    expect((await explorer.getEntitlementHolders('okta::okta-eng', TENANT)).holders).toEqual([]);
    const other = await graph.readStrict(
      'MATCH (i:Identity {id: $ada, tenantId: $t}) RETURN count(i) AS n',
      { ada: ids.ada, t: OTHER },
    );
    expect(other.records[0].get('n').toNumber()).toBe(1);
  });

  // Hunt 06 F3: a node keyed by native id and tenant only merged "admin" of AD and "admin" of
  // Okta into one entitlement: holders of both, a path to the wrong system.
  it('keeps one native id in two systems apart: nodes, holders and paths', async () => {
    const requests = mongoose.model('AccessRequest');
    const identityModel = mongoose.model('Identity');
    const people = await withTenantContext(COLLIDE, async () => {
      const person = (name: string) =>
        identityModel.create({
          tenantId: COLLIDE,
          profile: { firstName: name, lastName: 'Test', email: `${name}@corp.example` },
          provisioning: [],
        });
      const kim = String((await person('kim'))._id);
      const lee = String((await person('lee'))._id);
      for (const [system, name] of [
        ['ad', 'AD admins'],
        ['okta', 'Okta admins'],
      ]) {
        await catalogModel.create({
          tenantId: COLLIDE,
          system,
          nativeId: 'admin',
          name,
          type: 'Group',
        });
      }
      const holds = (identityId: string, system: string, n: number) =>
        requests.create({
          tenantId: COLLIDE,
          requestId: `REQ-${suffix}-collide-${n}`,
          requesterId: identityId,
          requesterEmail: 'requester@corp.example',
          targetIdentityId: identityId,
          status: 'ACTIVE',
          entitlements: [
            {
              catalogEntryId: 'c',
              system,
              entitlementName: 'admin',
              nativeId: 'admin',
              justification: 'w',
            },
          ],
        });
      await holds(kim, 'ad', 1);
      await holds(lee, 'okta', 2);
      return { kim, lee };
    });

    await withTenantContext(COLLIDE, () => resync.resync(COLLIDE));

    const ad = await explorer.getEntitlementHolders('ad::admin', COLLIDE);
    const okta = await explorer.getEntitlementHolders('okta::admin', COLLIDE);
    expect([ad.entitlement?.label, ad.holders.map((h) => h.identity.id)]).toEqual([
      'AD admins',
      [people.kim],
    ]);
    expect([okta.entitlement?.label, okta.holders.map((h) => h.identity.id)]).toEqual([
      'Okta admins',
      [people.lee],
    ]);
    expect((await explorer.findAccessPath(people.kim, 'okta::admin', COLLIDE)).path).toBeNull();
  });

  it('connects on its own when Neo4j was not reachable at start, without a restart', async () => {
    let attempts = 0;
    // The first attempt goes to a closed port, as a Neo4j that is not up yet; later ones to Neo4j
    const late = new GraphService(
      configFor({ NEO4J_RECONNECT_INTERVAL_MS: '0' }),
      (url, user, pw) =>
        neo4j.driver(attempts++ === 0 ? 'bolt://127.0.0.1:1' : url, neo4j.auth.basic(user, pw)),
    );
    try {
      await late.onModuleInit();
      expect(() => late.assertAvailable()).toThrow(/not connected/);

      for (let i = 0; i < 100 && late.connectionState() !== 'ok'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(late.connectionState()).toBe('ok');
      const one = await late.readStrict('RETURN 1 AS one');
      expect(one.records[0].get('one').toNumber()).toBe(1);
      expect(attempts).toBe(2);
    } finally {
      await late.onModuleDestroy();
    }
  });

  // FOLLOWUPS 2026-11-25 (graph-resync.service.ts:242, graph-sync.service.ts:228 and :240)
  describe('a group most identities get from a rule that names it by display name', () => {
    let people: { dan: string; eve: string; fay: string; gil: string; hal: string };
    let removed: { entitlements: number; relationships: number };
    const sales = { action: 'add', type: 'group', target: 'entra-id', sourcePolicy: 'Sales staff' };

    beforeAll(async () => {
      const identityModel = mongoose.model('Identity') as unknown as Model<IdentityDocument>;
      const requestModel = mongoose.model('AccessRequest');
      const sodModel = mongoose.model('SodPolicy');

      await withTenantContext(RULE, async () => {
        const person = async (name: string, status: 'SYNCED' | 'PENDING') =>
          String(
            (
              await identityModel.create({
                tenantId: RULE,
                profile: {
                  firstName: name,
                  lastName: 'Test',
                  email: `${name}@corp.example`,
                  status: 'ACTIVE',
                },
                provisioning: [{ targetSystem: 'entra-id', status }],
              })
            )._id,
          );
        people = {
          dan: await person('dan', 'SYNCED'),
          eve: await person('eve', 'SYNCED'),
          fay: await person('fay', 'SYNCED'),
          // Not synced: the rules give gil nothing yet; gil requested the group
          gil: await person('gil', 'PENDING'),
          hal: await person('hal', 'PENDING'),
        };
        await catalogModel.create(
          [
            ['guid-sales', 'SG-Sales'],
            ['guid-crm', 'CRM users'],
            // Two entries with one name: which one a rule naming it means is unknown
            ['guid-shared-1', 'SG-Shared'],
            ['guid-shared-2', 'SG-Shared'],
          ].map(([nativeId, name]) => ({
            tenantId: RULE,
            system: 'entra-id',
            nativeId,
            name,
            type: 'Group',
          })),
        );
        await requestModel.create({
          tenantId: RULE,
          requestId: `REQ-${suffix}-rule`,
          requesterId: people.gil,
          requesterEmail: 'gil@corp.example',
          targetIdentityId: people.gil,
          status: 'ACTIVE',
          entitlements: [
            {
              catalogEntryId: 'c-sales',
              system: 'entra-id',
              entitlementName: 'SG-Sales',
              nativeId: 'guid-sales',
              justification: 'work',
            },
          ],
        });
        // Named as the rule names the group, so SodService blocks the rule's grant too
        await sodModel.create({
          tenantId: RULE,
          name: 'Sales and CRM',
          severity: 'HIGH',
          action: 'WARN',
          isActive: true,
          conflictingEntitlements: [
            { system: 'entra-id', type: 'group', targetId: 'SG-Sales' },
            { system: 'entra-id', type: 'group', targetId: 'guid-crm' },
          ],
        });
      });

      // What the graph held before: the rule's holders on a node keyed by the display name
      await raw(
        `MERGE (d:Identity {id: $dan, tenantId: $t})
         MERGE (old:Entitlement {id: 'SG-Sales', tenantId: $t})
         MERGE (d)-[:HAS_ACCESS {grantedBy: 'policy', source: 'Sales staff'}]->(old)`,
        { t: RULE, dan: people.dan },
      );

      const ruleResync = new GraphResyncService(
        graph,
        identityModel,
        catalogModel as never,
        requestModel as never,
        {
          buildProfileWithContractsForPolicy: async (doc: { _id: unknown }) => ({
            id: String(doc._id),
          }),
        } as unknown as IdentityService,
        {
          evaluateOperationsWithoutSod: async (profile: { id: string }) =>
            profile.id === people.dan
              ? [
                  { ...sales, targetId: 'SG-Sales' },
                  { ...sales, targetId: 'CRM users' },
                  { ...sales, targetId: 'SG-Shared' },
                ]
              : [{ ...sales, targetId: 'SG-Sales' }],
        } as unknown as PolicyEngineService,
        new MemoryOwnedLockStore(),
      );
      ({ removed } = await withTenantContext(RULE, () => ruleResync.resync(RULE)));
    }, 60_000);

    const holderIds = async (entitlementId: string) =>
      (await explorer.getEntitlementHolders(entitlementId, RULE)).holders
        .map((h) => h.identity.id)
        .sort();

    it("puts every holder on the catalog's node, and the resync removes the node the old key made", async () => {
      const held = await explorer.getEntitlementHolders(`${E}guid-sales`, RULE);

      expect(held.entitlement?.label).toBe('SG-Sales');
      expect(
        held.holders
          .map((h) => [h.identity.id, h.path.relationships[0].properties.grantedBy])
          .sort(),
      ).toEqual(
        [
          [people.dan, 'policy'],
          [people.eve, 'policy'],
          [people.fay, 'policy'],
          [people.gil, 'request'],
        ].sort(),
      );
      expect(await explorer.getEntitlementHolders(`${E}SG-Sales`, RULE)).toEqual({
        entitlement: null,
        holders: [],
        truncated: false,
      });
      expect(removed).toMatchObject({ entitlements: 1, relationships: 1 });

      // A name the catalog has twice keeps the rule's own key
      const dan = await explorer.getIdentityAccessGraph(people.dan, RULE);
      expect(dan.nodes.map((n) => n.id).sort()).toEqual(
        [`${E}SG-Shared`, `${E}guid-crm`, `${E}guid-sales`, people.dan].sort(),
      );
    });

    it("answers the path from a rule's holder to the catalog's node", async () => {
      const found = await explorer.findAccessPath(people.eve, `${E}guid-sales`, RULE);

      expect(found.path?.depth).toBe(1);
      expect(found.path?.relationships[0]).toMatchObject({
        sourceId: people.eve,
        targetId: `${E}guid-sales`,
        properties: expect.objectContaining({ grantedBy: 'policy', source: 'Sales staff' }),
      });
    });

    it("finds the SoD violation on the catalog's nodes, the policy naming one by display name", async () => {
      const dan = await explorer.getTransitiveSodViolations(people.dan, RULE);
      expect(
        dan.violations.map((v) => [v.policyName, v.entitlementA.id, v.entitlementB.id]),
      ).toEqual([['Sales and CRM', `${E}guid-sales`, `${E}guid-crm`]]);

      const eve = await explorer.getTransitiveSodViolations(people.eve, RULE);
      expect(eve).toEqual({ identityFound: true, policiesChecked: 1, violations: [] });
    });

    it("links provisioning that names the group by display name to the catalog's node, and removes it there", async () => {
      const provisioned = (action: 'add' | 'remove') =>
        sync.onProvisioningCompleted(
          event(
            DomainEventType.PROVISIONING_COMPLETED,
            {
              identityId: people.hal,
              connector: 'entra-id',
              operations: [{ action, type: 'group' as const, targetId: 'SG-Sales', success: true }],
              durationMs: 1,
            },
            RULE,
          ),
        );

      await provisioned('add');
      expect(await holderIds(`${E}guid-sales`)).toEqual(
        [people.dan, people.eve, people.fay, people.gil, people.hal].sort(),
      );
      expect((await explorer.getEntitlementHolders(`${E}SG-Sales`, RULE)).entitlement).toBeNull();

      await provisioned('remove');
      expect(await holderIds(`${E}guid-sales`)).toEqual(
        [people.dan, people.eve, people.fay, people.gil].sort(),
      );
    });
  });
});
