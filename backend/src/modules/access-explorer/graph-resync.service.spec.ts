/**
 * GraphResyncService: loads the tenant's current state from MongoDB into Neo4j with the mapping
 * GraphSyncService writes from events (Identity, Entitlement, Application, HAS_ACCESS,
 * BELONGS_TO), stamps what it wrote with the run id, then removes the tenant's nodes and edges
 * without that stamp (what MongoDB no longer has). Before, nothing loaded what MongoDB already
 * held: a graph connected after the fact knew only later events. The Cypher itself runs against a
 * real Neo4j in access-explorer.neo4j.integration.spec.ts.
 *
 * A resync also removes the tenant's duplicate nodes (written before the uniqueness constraints
 * existed) and then has GraphService create the constraints still missing: the admin's way out
 * when one could not be created at start (FOLLOWUPS 2026-11-25, graph-resync.cypher.ts).
 */
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { GRAPH_UNAVAILABLE, type GraphService } from '@infrastructure/graph/graph.service';
import type { IdentityService } from '../identity/identity.service';
import type { PolicyEngineService } from '../policy/policy-engine.service';
import { MemoryOwnedLockStore, type OwnedLockStore } from '@infrastructure/cache/owned-lock.store';
import { GraphResyncService } from './graph-resync.service';

const TENANT = 'tenant-a';
const ADA = '64b7f0c2a1b2c3d4e5f60101';
const BOB = '64b7f0c2a1b2c3d4e5f60102';

type Doc = Record<string, unknown>;

/** A Mongoose model whose find() answers `docs` (once per call for keyset pages). */
function modelOf(pages: Doc[][]) {
  const calls: Array<Record<string, unknown>> = [];
  let page = 0;
  const chain = {
    sort: () => chain,
    limit: () => chain,
    select: () => chain,
    lean: () => chain,
    exec: async () => pages[page++] ?? [],
  };
  return {
    calls,
    model: {
      find: jest.fn((filter: Record<string, unknown>) => {
        calls.push(filter);
        return chain;
      }),
    },
  };
}

const identity = (id: string, provisioning: Doc[] = [], profile: Doc = {}) => ({
  _id: id,
  tenantId: TENANT,
  profile: { email: `${id}@corp.example`, status: 'ACTIVE', ...profile },
  provisioning,
  sources: [{ sourceName: 'workday-prod', externalId: `wd-${id}` }],
});

describe('GraphResyncService', () => {
  let graph: {
    assertAvailable: jest.Mock;
    writeStrict: jest.Mock;
    ensureNodeConstraints: jest.Mock;
  };
  let identities: ReturnType<typeof modelOf>;
  let catalog: ReturnType<typeof modelOf>;
  let requests: ReturnType<typeof modelOf>;
  let identityService: { buildProfileWithContractsForPolicy: jest.Mock };
  let policyEngine: { evaluateOperationsWithoutSod: jest.Mock };
  let service: GraphResyncService;
  /** The lock store the API replicas share (Redis in production). */
  let locks: OwnedLockStore;

  const build = () =>
    new GraphResyncService(
      graph as unknown as GraphService,
      identities.model as never,
      catalog.model as never,
      requests.model as never,
      identityService as unknown as IdentityService,
      policyEngine as unknown as PolicyEngineService,
      locks,
    );

  /** The writes whose Cypher contains `marker`, as [cypher, params]. */
  const writes = (marker: string) =>
    graph.writeStrict.mock.calls.filter(([cypher]: [string]) => cypher.includes(marker));
  const rowsOf = (marker: string) =>
    writes(marker).flatMap(([, params]: [string, { rows: Doc[] }]) => params.rows);

  beforeEach(() => {
    locks = new MemoryOwnedLockStore();
    graph = {
      assertAvailable: jest.fn(),
      // A prune answers how many it removed; the merges answer nothing.
      writeStrict: jest.fn(async (cypher: string) =>
        cypher.includes('AS removed') ? { records: [{ get: () => 2 }] } : { records: [] },
      ),
      ensureNodeConstraints: jest.fn(async () => undefined),
    };
    identities = modelOf([
      [
        identity(ADA, [{ targetSystem: 'entra-id', status: 'SYNCED' }]),
        identity(BOB, [{ targetSystem: 'entra-id', status: 'PENDING' }]),
      ],
    ]);
    catalog = modelOf([
      [
        { system: 'entra-id', nativeId: 'grp-fin', name: 'Finance', type: 'Group' },
        { system: 'entra-id', nativeId: 'lic-e5', name: 'M365 E5', type: 'License' },
        { system: 'okta', nativeId: 'okta-app', name: 'Okta app', type: 'Group' },
      ],
    ]);
    requests = modelOf([
      [
        {
          requestId: 'REQ-1',
          targetIdentityId: BOB,
          requesterId: ADA,
          entitlements: [
            {
              system: 'entra-id',
              nativeId: 'grp-pay',
              entitlementName: 'Payroll',
              entitlementType: 'Group',
            },
            { system: 'entra-id', entitlementName: 'No native id', entitlementType: 'Group' },
          ],
        },
        // A self-request: no target identity, the requester is the identity
        {
          requestId: 'REQ-2',
          requesterId: ADA,
          entitlements: [{ system: 'okta', nativeId: 'okta-app', entitlementName: 'Okta app' }],
        },
        // The identity is not (or no longer) in the tenant's identities
        {
          requestId: 'REQ-3',
          targetIdentityId: '64b7f0c2a1b2c3d4e5f60199',
          requesterId: ADA,
          entitlements: [{ system: 'entra-id', nativeId: 'grp-fin', entitlementName: 'Finance' }],
        },
      ],
    ]);
    identityService = {
      buildProfileWithContractsForPolicy: jest.fn(async (doc: Doc) => ({ email: 'profile', doc })),
    };
    policyEngine = {
      evaluateOperationsWithoutSod: jest.fn(async () => [
        {
          action: 'add',
          type: 'group',
          target: 'entra-id',
          targetId: 'grp-fin',
          sourcePolicy: 'Finance staff',
        },
        {
          action: 'add',
          type: 'license',
          target: 'entra',
          targetId: 'lic-e5',
          sourcePolicy: 'Licences',
        },
        // An attribute and a removal grant nothing
        {
          action: 'set',
          type: 'attribute',
          target: 'entra-id',
          targetId: 'department',
          sourcePolicy: 'X',
        },
        {
          action: 'remove',
          type: 'group',
          target: 'entra-id',
          targetId: 'grp-old',
          sourcePolicy: 'X',
        },
        // The policy wants it, but the identity has no synced account in that system
        {
          action: 'add',
          type: 'group',
          target: 'okta',
          targetId: 'okta-grp',
          sourcePolicy: 'Okta staff',
        },
      ]),
    };
    service = build();
  });

  it('answers 503 and writes nothing when the graph store is not available', async () => {
    graph.assertAvailable.mockImplementation(() => {
      throw new ServiceUnavailableException(GRAPH_UNAVAILABLE.notConfigured);
    });

    await expect(service.resync(TENANT)).rejects.toThrow(GRAPH_UNAVAILABLE.notConfigured);
    expect(graph.writeStrict).not.toHaveBeenCalled();
    expect(identities.model.find).not.toHaveBeenCalled();
  });

  it("reads only the tenant's live identities, catalog entries with a native id and active requests", async () => {
    await service.resync(TENANT);

    expect(identities.calls[0]).toMatchObject({ tenantId: TENANT, deletedAt: null });
    expect(catalog.calls[0]).toMatchObject({ tenantId: TENANT });
    expect(requests.calls[0]).toEqual({ tenantId: TENANT, status: 'ACTIVE' });
  });

  it('merges each identity as an Identity node keyed by its _id and the tenant', async () => {
    await service.resync(TENANT);

    const [[cypher, params]] = writes('MERGE (i:Identity {id: row.id, tenantId: $tenantId})');
    expect(cypher).toContain('i.email = coalesce(row.email, i.email)');
    expect(params.tenantId).toBe(TENANT);
    expect(params.rows).toEqual([
      { id: ADA, status: 'ACTIVE', email: `${ADA}@corp.example`, sourceSystem: 'workday-prod' },
      { id: BOB, status: 'ACTIVE', email: `${BOB}@corp.example`, sourceSystem: 'workday-prod' },
    ]);
  });

  it('merges each catalog entry as an Entitlement of its Application, keyed by system and native id', async () => {
    await service.resync(TENANT);

    expect(writes('MERGE (a:Application {id: system, tenantId: $tenantId})')[0][1].systems).toEqual(
      ['entra-id', 'okta'],
    );
    expect(writes('MERGE (e)-[r:BELONGS_TO]->(a)')).toHaveLength(1);
    expect(rowsOf('MERGE (e)-[r:BELONGS_TO]->(a)')).toEqual([
      {
        id: 'entra-id::grp-fin',
        nativeId: 'grp-fin',
        name: 'Finance',
        type: 'Group',
        system: 'entra-id',
      },
      {
        id: 'entra-id::lic-e5',
        nativeId: 'lic-e5',
        name: 'M365 E5',
        type: 'License',
        system: 'entra-id',
      },
      {
        id: 'okta::okta-app',
        nativeId: 'okta-app',
        name: 'Okta app',
        type: 'Group',
        system: 'okta',
      },
    ]);
  });

  // Hunt 06 F3: the node was keyed by native id and tenant only, while the catalog is unique on
  // (tenant, system, native id). "admin", or a numeric group id, in two systems was one node:
  // its holders mixed, a path led to the wrong system, SoD saw a conflict across systems.
  it('keeps entitlements with one native id in two systems apart', async () => {
    catalog = modelOf([
      [
        { system: 'ad', nativeId: 'admin', name: 'AD admins', type: 'Group' },
        { system: 'okta', nativeId: 'admin', name: 'Okta admins', type: 'Group' },
      ],
    ]);
    policyEngine.evaluateOperationsWithoutSod.mockResolvedValue([
      { action: 'add', type: 'group', target: 'entra-id', targetId: 'admin', sourcePolicy: 'X' },
    ]);
    service = build();

    const result = await service.resync(TENANT);

    expect(rowsOf('MERGE (e)-[r:BELONGS_TO]->(a)').map((row) => row.id)).toEqual([
      'ad::admin',
      'okta::admin',
    ]);
    // A grant in a third system the catalog does not know gets its own node too
    expect(
      rowsOf('MERGE (i)-[r:HAS_ACCESS]->(e)')
        .filter((row) => row.grantedBy === 'policy')
        .map((row) => row.targetId),
    ).toEqual(['entra-id::admin']);
    expect(result.entitlements).toBe(5);
  });

  it("links the access the identity page calls Active: policy grants on a synced account, active requests' entitlements", async () => {
    await service.resync(TENANT);

    // Only ADA has a synced account: BOB's policy access is not provisioned yet.
    expect(policyEngine.evaluateOperationsWithoutSod).toHaveBeenCalledTimes(1);
    expect(policyEngine.evaluateOperationsWithoutSod).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'profile' }),
      TENANT,
    );
    expect(rowsOf('MERGE (i)-[r:HAS_ACCESS]->(e)')).toEqual([
      {
        identityId: ADA,
        targetId: 'entra-id::grp-fin',
        nativeId: 'grp-fin',
        type: 'group',
        connector: 'entra-id',
        grantedBy: 'policy',
        source: 'Finance staff',
      },
      {
        identityId: ADA,
        targetId: 'entra-id::lic-e5',
        nativeId: 'lic-e5',
        type: 'license',
        connector: 'entra-id',
        grantedBy: 'policy',
        source: 'Licences',
      },
      {
        identityId: BOB,
        targetId: 'entra-id::grp-pay',
        nativeId: 'grp-pay',
        type: 'group',
        connector: 'entra-id',
        grantedBy: 'request',
        source: 'Access request REQ-1',
      },
      {
        identityId: ADA,
        targetId: 'okta::okta-app',
        nativeId: 'okta-app',
        type: 'group',
        connector: 'okta',
        grantedBy: 'request',
        source: 'Access request REQ-2',
      },
    ]);
  });

  // FOLLOWUPS 2026-11-25 (graph-resync.service.ts:242): a rule naming a group by display name
  // linked its holders to a second node keyed by that name, apart from the catalog's node.
  it("links a rule's grant to the catalog's node: a group named by display name gets its native id", async () => {
    policyEngine.evaluateOperationsWithoutSod.mockResolvedValue([
      {
        action: 'add',
        type: 'group',
        target: 'entra-id',
        targetId: 'Finance',
        sourcePolicy: 'Finance staff',
      },
      // A name the catalog has on another system only, and one it does not have: own key
      { action: 'add', type: 'group', target: 'entra-id', targetId: 'Okta app', sourcePolicy: 'X' },
      {
        action: 'add',
        type: 'group',
        target: 'entra-id',
        targetId: 'SG-Unknown',
        sourcePolicy: 'X',
      },
    ]);

    const result = await service.resync(TENANT);

    expect(
      rowsOf('MERGE (i)-[r:HAS_ACCESS]->(e)')
        .filter((row) => row.grantedBy === 'policy')
        .map((row) => [row.targetId, row.connector, row.source]),
    ).toEqual([
      ['entra-id::grp-fin', 'entra-id', 'Finance staff'],
      ['entra-id::Okta app', 'entra-id', 'X'],
      ['entra-id::SG-Unknown', 'entra-id', 'X'],
    ]);
    // The catalog's three, the request's grp-pay and the two targets the catalog does not know
    expect(result.entitlements).toBe(6);
  });

  it('creates edges only from identities it merged (MATCH), entitlements as graph sync does (MERGE)', async () => {
    await service.resync(TENANT);

    const [[cypher]] = writes('MERGE (i)-[r:HAS_ACCESS]->(e)');
    expect(cypher).toContain('MATCH (i:Identity {id: row.identityId, tenantId: $tenantId})');
    expect(cypher).toContain('MERGE (e:Entitlement {id: row.targetId, tenantId: $tenantId})');
    expect(cypher).toContain(
      'ON CREATE SET e.entitlementType = row.type, e.system = row.connector, e.nativeId = row.nativeId',
    );
  });

  it('stamps every write with one run id, then removes what the tenant has without it', async () => {
    const result = await service.resync(TENANT);

    const runIds = new Set(graph.writeStrict.mock.calls.map(([, p]: [string, Doc]) => p.runId));
    const tenants = new Set(graph.writeStrict.mock.calls.map(([, p]: [string, Doc]) => p.tenantId));
    expect(runIds.size).toBe(1);
    expect([...tenants]).toEqual([TENANT]);

    const prunes = writes('AS removed').map(([cypher]: [string]) => cypher);
    // Five by the run stamp, three of duplicate nodes (the next test)
    expect(prunes).toHaveLength(8);
    for (const cypher of prunes) expect(cypher).toContain('{tenantId: $tenantId}');
    expect(prunes.filter((c: string) => c.includes('.syncRunId IS NULL OR'))).toHaveLength(5);
    expect(prunes.some((c: string) => c.includes('DETACH DELETE i'))).toBe(true);
    // Merges come first: a failure before the prunes removes nothing.
    const firstPrune = graph.writeStrict.mock.calls.findIndex(([c]: [string]) =>
      c.includes('AS removed'),
    );
    expect(
      graph.writeStrict.mock.calls
        .slice(firstPrune)
        .every(([c]: [string]) => c.includes('AS removed')),
    ).toBe(true);

    expect(result).toMatchObject({
      identities: 2,
      applications: 2,
      // The catalog's three and the request's grp-pay, which the catalog does not have
      entitlements: 4,
      grants: { policy: 2, request: 2 },
      // Each prune answers 2: unstamped nodes and duplicates of a label add up
      removed: { identities: 4, entitlements: 4, applications: 4, relationships: 4 },
    });
  });

  it("removes the tenant's duplicate nodes, one of each id staying, then creates the missing constraints", async () => {
    await service.resync(TENANT);

    const duplicates = writes('UNWIND tail(nodes) AS duplicate').map(
      ([cypher]: [string]) => cypher,
    );
    expect(
      duplicates.map((c: string) => /MATCH \(n:(\w+) \{tenantId: \$tenantId\}\)/.exec(c)?.[1]),
    ).toEqual(['Identity', 'Entitlement', 'Application']);
    for (const cypher of duplicates) {
      expect(cypher).toContain('WITH n.id AS id, collect(n) AS nodes');
      expect(cypher).toContain('DETACH DELETE duplicate');
    }
    expect(graph.ensureNodeConstraints).toHaveBeenCalledTimes(1);
    const lastWrite = Math.max(...graph.writeStrict.mock.invocationCallOrder);
    expect(graph.ensureNodeConstraints.mock.invocationCallOrder[0]).toBeGreaterThan(lastWrite);
  });

  it('reads identities in keyset pages by _id', async () => {
    identities = modelOf([[identity(ADA)], [identity(BOB)]]);
    service = build();
    (service as unknown as { pageSize: number }).pageSize = 1;

    const result = await service.resync(TENANT);

    expect(identities.calls[1]).toMatchObject({ tenantId: TENANT, _id: { $gt: ADA } });
    expect(result.identities).toBe(2);
  });

  it('stops before removing anything when a policy evaluation fails', async () => {
    policyEngine.evaluateOperationsWithoutSod.mockRejectedValue(new Error('bad contract'));

    await expect(service.resync(TENANT)).rejects.toThrow(
      `Policy evaluation failed for identity ${ADA}: bad contract. Nothing was removed from the graph.`,
    );
    expect(writes('AS removed')).toHaveLength(0);
    expect(graph.ensureNodeConstraints).not.toHaveBeenCalled();
  });

  it('refuses a second resync of the same tenant while one runs (409), not of another tenant', async () => {
    let release: () => void = () => undefined;
    graph.writeStrict.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ records: [] }))),
    );
    const first = service.resync(TENANT);
    await new Promise((r) => setImmediate(r));

    await expect(service.resync(TENANT)).rejects.toThrow(ConflictException);
    release();
    await first;
    // Free again after it finished
    await expect(service.resync(TENANT)).resolves.toBeDefined();
  });

  // Hunt r2-06 N4: the lock was a Set in each API process, so two replicas could resync one
  // tenant at once, and each run pruned the nodes and edges the other had stamped.
  it('refuses a resync of a tenant another API replica is resyncing (409)', async () => {
    const replica = build();
    let release: () => void = () => undefined;
    graph.writeStrict.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ records: [] }))),
    );
    const first = service.resync(TENANT);
    await new Promise((r) => setImmediate(r));

    await expect(replica.resync(TENANT)).rejects.toThrow(ConflictException);
    await expect(replica.resync('tenant-b')).resolves.toBeDefined();
    release();
    await first;
    await expect(replica.resync(TENANT)).resolves.toBeDefined();
  });
});
