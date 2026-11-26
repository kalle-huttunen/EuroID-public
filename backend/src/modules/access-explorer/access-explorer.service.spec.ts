import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AccessExplorerService,
  HOLDER_PATH_LIMIT,
  IDENTITY_GRAPH_PATH_LIMIT,
} from './access-explorer.service';
import { getModelToken } from '@nestjs/mongoose';
import { GRAPH_UNAVAILABLE, GraphService } from '@infrastructure/graph/graph.service';
import { SodPolicy } from '../policy/schemas/sod-policy.schema';
import { EntitlementCatalog } from '../entitlement-catalog/schemas/entitlement-catalog.schema';

/** What GraphService.readStrict throws when Neo4j is not configured, not connected or fails. */
const unavailable = () => new ServiceUnavailableException(GRAPH_UNAVAILABLE.notConfigured);

/** The neo4j Integer the LIMIT parameter must be (a JS number is sent as a float). */
const limitOf = (params: Record<string, unknown> | undefined) =>
  (params?.limit as { toNumber(): number }).toNumber();

/**
 * Helper: create a mock Neo4j node structure.
 */
function mockNeo4jNode(id: string, labels: string[], properties: Record<string, unknown> = {}) {
  return {
    labels,
    elementId: `node-${id}`,
    identity: id,
    properties: { id, ...properties },
  };
}

/**
 * Helper: create a mock Neo4j relationship.
 */
function mockNeo4jRel(
  id: string,
  type: string,
  startId: string,
  endId: string,
  properties: Record<string, unknown> = {},
) {
  return {
    elementId: `rel-${id}`,
    identity: id,
    type,
    startNodeElementId: `node-${startId}`,
    endNodeElementId: `node-${endId}`,
    start: startId,
    end: endId,
    properties,
  };
}

/**
 * Helper: create a mock Neo4j path with segments.
 */
function mockPath(
  segments: Array<{
    start: ReturnType<typeof mockNeo4jNode>;
    end: ReturnType<typeof mockNeo4jNode>;
    relationship: ReturnType<typeof mockNeo4jRel>;
  }>,
) {
  return { segments };
}

/**
 * Helper: create a mock Neo4j record that responds to .get(key).
 */
function mockRecord(data: Record<string, unknown>) {
  return {
    get: (key: string) => data[key],
  };
}

describe('AccessExplorerService', () => {
  let service: AccessExplorerService;
  let graphService: jest.Mocked<GraphService>;
  let sodPolicies: Array<Record<string, unknown>>;
  let sodPolicyModel: { find: jest.Mock };
  /** The entitlement catalog entries the SoD check's catalog read answers. */
  let catalogEntries: Array<{ system: string; nativeId: string; name: string }>;
  let catalogModel: { find: jest.Mock };

  beforeEach(async () => {
    sodPolicies = [];
    sodPolicyModel = {
      find: jest.fn(() => ({ lean: () => ({ exec: async () => sodPolicies }) })),
    };
    catalogEntries = [];
    catalogModel = {
      find: jest.fn(() => ({
        select: () => ({ lean: () => ({ exec: async () => catalogEntries }) }),
      })),
    };

    graphService = {
      runQuery: jest.fn(),
      runWriteQuery: jest.fn(),
      readStrict: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as jest.Mocked<GraphService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccessExplorerService,
        { provide: GraphService, useValue: graphService },
        { provide: getModelToken(SodPolicy.name), useValue: sodPolicyModel },
        { provide: getModelToken(EntitlementCatalog.name), useValue: catalogModel },
      ],
    }).compile();

    service = module.get<AccessExplorerService>(AccessExplorerService);
  });

  // ── getIdentityAccessGraph ─────────────────────────────────────────

  describe('getIdentityAccessGraph', () => {
    it('should return nodes and relationships from path results', async () => {
      const identityNode = mockNeo4jNode('user-1', ['Identity'], { email: 'john@test.com' });
      const entitlementNode = mockNeo4jNode('ent-1', ['Entitlement'], { name: 'Engineers' });
      const rel = mockNeo4jRel('r1', 'HAS_ACCESS', 'user-1', 'ent-1');
      const path = mockPath([{ start: identityNode, end: entitlementNode, relationship: rel }]);

      graphService.readStrict.mockResolvedValue({
        records: [mockRecord({ i: identityNode, path })],
      } as any);

      const result = await service.getIdentityAccessGraph('user-1', 'tenant-1');

      const [cypher, params] = graphService.readStrict.mock.calls[0];
      expect(cypher).toContain('OPTIONAL MATCH path');
      expect(params).toMatchObject({ id: 'user-1', tenantId: 'tenant-1' });
      expect(result.identityFound).toBe(true);
      expect(result.truncated).toBe(false);
      expect(result.nodes).toHaveLength(2);
      expect(result.relationships).toHaveLength(1);
      expect(result.nodes.find((n) => n.type === 'Identity')).toBeDefined();
      expect(result.nodes.find((n) => n.type === 'Entitlement')).toBeDefined();
    });

    it('says the identity is not in the graph when the graph has no node for it', async () => {
      graphService.readStrict.mockResolvedValue({ records: [] } as any);

      const result = await service.getIdentityAccessGraph('user-1', 'tenant-1');

      expect(result.identityFound).toBe(false);
      expect(result.nodes).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });

    it('returns the identity alone when it is in the graph without access', async () => {
      const identityNode = mockNeo4jNode('user-1', ['Identity'], { email: 'john@test.com' });
      graphService.readStrict.mockResolvedValue({
        records: [mockRecord({ i: identityNode, path: null })],
      } as any);

      const result = await service.getIdentityAccessGraph('user-1', 'tenant-1');

      expect(result.identityFound).toBe(true);
      expect(result.nodes.map((n) => n.id)).toEqual(['user-1']);
      expect(result.relationships).toHaveLength(0);
    });

    // Plan: before, a missing or failing Neo4j answered an empty graph ("no access").
    it('fails closed with 503 when the graph store cannot answer, never an empty graph', async () => {
      graphService.readStrict.mockRejectedValue(unavailable());

      await expect(service.getIdentityAccessGraph('user-1', 'tenant-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('keys every relationship by the ids of the nodes it joins', async () => {
      const identityNode = mockNeo4jNode('user-1', ['Identity']);
      const groupNode = mockNeo4jNode('grp-1', ['Entitlement']);
      const entNode = mockNeo4jNode('ent-1', ['Entitlement']);
      const path = mockPath([
        {
          start: identityNode,
          end: groupNode,
          relationship: mockNeo4jRel('r1', 'MEMBER_OF', 'user-1', 'grp-1'),
        },
        {
          start: groupNode,
          end: entNode,
          relationship: mockNeo4jRel('r2', 'HAS_ACCESS', 'grp-1', 'ent-1'),
        },
      ]);
      graphService.readStrict.mockResolvedValue({
        records: [mockRecord({ i: identityNode, path })],
      } as any);

      const result = await service.getIdentityAccessGraph('user-1', 'tenant-1');

      // The node ids are the `id` properties; the element ids (node-...) must not leak into edges.
      expect(result.relationships.map((r) => [r.sourceId, r.targetId])).toEqual([
        ['user-1', 'grp-1'],
        ['grp-1', 'ent-1'],
      ]);
    });

    it('asks for one path more than it returns and says when the graph had more', async () => {
      const identityNode = mockNeo4jNode('user-1', ['Identity']);
      const records = Array.from({ length: IDENTITY_GRAPH_PATH_LIMIT + 1 }, (_, k) => {
        const ent = mockNeo4jNode(`ent-${k}`, ['Entitlement']);
        const rel = mockNeo4jRel(`r${k}`, 'HAS_ACCESS', 'user-1', `ent-${k}`);
        return mockRecord({
          i: identityNode,
          path: mockPath([{ start: identityNode, end: ent, relationship: rel }]),
        });
      });
      graphService.readStrict.mockResolvedValue({ records } as any);

      const result = await service.getIdentityAccessGraph('user-1', 'tenant-1');

      expect(limitOf(graphService.readStrict.mock.calls[0][1])).toBe(IDENTITY_GRAPH_PATH_LIMIT + 1);
      expect(result.truncated).toBe(true);
      expect(result.relationships).toHaveLength(IDENTITY_GRAPH_PATH_LIMIT);
    });

    it('should handle multi-hop paths (transitive access)', async () => {
      const identityNode = mockNeo4jNode('user-1', ['Identity']);
      const groupNode = mockNeo4jNode('grp-1', ['Entitlement'], { name: 'Group A' });
      const entNode = mockNeo4jNode('ent-1', ['Entitlement'], { name: 'License B' });
      const rel1 = mockNeo4jRel('r1', 'MEMBER_OF', 'user-1', 'grp-1');
      const rel2 = mockNeo4jRel('r2', 'HAS_ACCESS', 'grp-1', 'ent-1');
      const path = mockPath([
        { start: identityNode, end: groupNode, relationship: rel1 },
        { start: groupNode, end: entNode, relationship: rel2 },
      ]);

      graphService.readStrict.mockResolvedValue({
        records: [mockRecord({ i: identityNode, path })],
      } as any);

      const result = await service.getIdentityAccessGraph('user-1', 'tenant-1');

      expect(result.nodes).toHaveLength(3);
      expect(result.relationships).toHaveLength(2);
    });
  });

  // ── getEntitlementHolders ──────────────────────────────────────────

  describe('getEntitlementHolders', () => {
    it('should return identity holders with access paths', async () => {
      const identityNode = mockNeo4jNode('user-1', ['Identity'], { displayName: 'John' });
      const entitlementNode = mockNeo4jNode('ent-1', ['Entitlement']);
      const rel = mockNeo4jRel('r1', 'HAS_ACCESS', 'user-1', 'ent-1');
      const path = mockPath([{ start: identityNode, end: entitlementNode, relationship: rel }]);

      graphService.readStrict.mockResolvedValue({
        records: [mockRecord({ e: entitlementNode, i: identityNode, path })],
      } as any);

      const { entitlement, holders, truncated } = await service.getEntitlementHolders(
        'ent-1',
        'tenant-1',
      );

      expect(entitlement?.id).toBe('ent-1');
      expect(truncated).toBe(false);
      expect(holders).toHaveLength(1);
      expect(holders[0].identity.type).toBe('Identity');
      expect(holders[0].path.depth).toBe(1);
    });

    it('should return multiple holders', async () => {
      const identity1 = mockNeo4jNode('user-1', ['Identity']);
      const identity2 = mockNeo4jNode('user-2', ['Identity']);
      const ent = mockNeo4jNode('ent-1', ['Entitlement']);
      const rel1 = mockNeo4jRel('r1', 'HAS_ACCESS', 'user-1', 'ent-1');
      const rel2 = mockNeo4jRel('r2', 'HAS_ACCESS', 'user-2', 'ent-1');
      const path1 = mockPath([{ start: identity1, end: ent, relationship: rel1 }]);
      const path2 = mockPath([{ start: identity2, end: ent, relationship: rel2 }]);

      graphService.readStrict.mockResolvedValue({
        records: [
          mockRecord({ e: ent, i: identity1, path: path1 }),
          mockRecord({ e: ent, i: identity2, path: path2 }),
        ],
      } as any);

      const { holders } = await service.getEntitlementHolders('ent-1', 'tenant-1');

      expect(holders).toHaveLength(2);
      expect(holders[0].identity.id).toBe('user-1');
      expect(holders[1].identity.id).toBe('user-2');
    });

    it('fails closed with 503 when the graph store cannot answer, never "nobody holds it"', async () => {
      graphService.readStrict.mockRejectedValue(unavailable());

      await expect(service.getEntitlementHolders('ent-1', 'tenant-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('tells an entitlement nobody holds from one the graph does not have', async () => {
      const ent = mockNeo4jNode('ent-1', ['Entitlement'], { name: 'Finance' });
      graphService.readStrict.mockResolvedValueOnce({
        records: [mockRecord({ e: ent, i: null, path: null })],
      } as any);
      const held = await service.getEntitlementHolders('ent-1', 'tenant-1');
      expect(held.entitlement?.label).toBe('Finance');
      expect(held.holders).toEqual([]);

      graphService.readStrict.mockResolvedValueOnce({ records: [] } as any);
      const unknown = await service.getEntitlementHolders('ent-x', 'tenant-1');
      expect(unknown.entitlement).toBeNull();
      expect(unknown.holders).toEqual([]);
    });

    it('caps the holder paths and says when the graph had more', async () => {
      const ent = mockNeo4jNode('ent-1', ['Entitlement']);
      const records = Array.from({ length: HOLDER_PATH_LIMIT + 1 }, (_, k) => {
        const who = mockNeo4jNode(`user-${k}`, ['Identity']);
        const rel = mockNeo4jRel(`r${k}`, 'HAS_ACCESS', `user-${k}`, 'ent-1');
        return mockRecord({
          e: ent,
          i: who,
          path: mockPath([{ start: who, end: ent, relationship: rel }]),
        });
      });
      graphService.readStrict.mockResolvedValue({ records } as any);

      const result = await service.getEntitlementHolders('ent-1', 'tenant-1');

      expect(limitOf(graphService.readStrict.mock.calls[0][1])).toBe(HOLDER_PATH_LIMIT + 1);
      expect(result.truncated).toBe(true);
      expect(result.holders).toHaveLength(HOLDER_PATH_LIMIT);
    });
  });

  // ── findAccessPath ─────────────────────────────────────────────────

  describe('findAccessPath', () => {
    it('should return shortest path between identity and entitlement', async () => {
      const identityNode = mockNeo4jNode('user-1', ['Identity']);
      const entNode = mockNeo4jNode('ent-1', ['Entitlement']);
      const rel = mockNeo4jRel('r1', 'HAS_ACCESS', 'user-1', 'ent-1');
      const path = mockPath([{ start: identityNode, end: entNode, relationship: rel }]);

      graphService.readStrict.mockResolvedValue({
        records: [mockRecord({ identityFound: true, entitlementFound: true, path })],
      } as any);

      const {
        identityFound,
        entitlementFound,
        path: result,
      } = await service.findAccessPath('user-1', 'ent-1', 'tenant-1');

      expect([identityFound, entitlementFound]).toEqual([true, true]);
      expect(result).not.toBeNull();
      expect(result!.depth).toBe(1);
      expect(result!.nodes).toHaveLength(2);
      expect(result!.relationships).toHaveLength(1);
      expect(result!.relationships[0]).toMatchObject({ sourceId: 'user-1', targetId: 'ent-1' });
    });

    it('should return null when no path exists, and say which ends the graph has', async () => {
      graphService.readStrict.mockResolvedValue({
        records: [mockRecord({ identityFound: true, entitlementFound: false, path: null })],
      } as any);

      const result = await service.findAccessPath('user-1', 'ent-1', 'tenant-1');
      expect(result).toEqual({ identityFound: true, entitlementFound: false, path: null });
    });

    it('fails closed with 503 when the graph store cannot answer, never "no path"', async () => {
      graphService.readStrict.mockRejectedValue(unavailable());

      await expect(service.findAccessPath('user-1', 'ent-1', 'tenant-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('should call GraphService with shortestPath Cypher', async () => {
      graphService.readStrict.mockResolvedValue({ records: [] } as any);

      await service.findAccessPath('user-1', 'ent-1', 'tenant-1');

      expect(graphService.readStrict).toHaveBeenCalledWith(
        expect.stringContaining('shortestPath'),
        {
          identityId: 'user-1',
          entitlementId: 'ent-1',
          tenantId: 'tenant-1',
        },
      );
    });
  });

  // ── getTransitiveSodViolations ─────────────────────────────────────

  /**
   * SoD policies live in MongoDB (sod_policies, SodService); the graph says which entitlements an
   * identity reaches, directly or through nested groups. Nothing writes :SodPolicy graph nodes.
   */
  describe('getTransitiveSodViolations', () => {
    const identity = mockNeo4jNode('user-1', ['Identity']);
    const group = mockNeo4jNode('grp-nested', ['Entitlement'], { name: 'Finance All' });
    const eA = mockNeo4jNode('entra-id::ent-a', ['Entitlement'], { name: 'Finance-Admin' });
    const eB = mockNeo4jNode('entra-id::ent-b', ['Entitlement'], { name: 'Finance-Approver' });
    const direct = (e: ReturnType<typeof mockNeo4jNode>) =>
      mockPath([
        {
          start: identity,
          end: e,
          relationship: mockNeo4jRel(`r-${e.identity}`, 'HAS_ACCESS', 'user-1', String(e.identity)),
        },
      ]);
    const nested = (e: ReturnType<typeof mockNeo4jNode>) =>
      mockPath([
        {
          start: identity,
          end: group,
          relationship: mockNeo4jRel('r-g', 'MEMBER_OF', 'user-1', 'grp-nested'),
        },
        {
          start: group,
          end: e,
          relationship: mockNeo4jRel(
            `r-n-${e.identity}`,
            'HAS_ACCESS',
            'grp-nested',
            String(e.identity),
          ),
        },
      ]);
    const policy = (name: string, targetIds: string[], extra: Record<string, unknown> = {}) => ({
      name,
      severity: 'HIGH',
      action: 'BLOCK',
      conflictingEntitlements: targetIds.map((targetId) => ({
        system: 'entra-id',
        type: 'group',
        targetId,
      })),
      ...extra,
    });

    /** The identity is in the graph; the path query answers these records. */
    const servePaths = (records: unknown[], identityInGraph = true) =>
      graphService.readStrict.mockImplementation(async (cypher: string) =>
        cypher.includes('RETURN i.id')
          ? ({ records: identityInGraph ? [mockRecord({ id: 'user-1' })] : [] } as any)
          : ({ records } as any),
      );
    const pathQueries = () =>
      graphService.readStrict.mock.calls.filter(([cypher]) => !cypher.includes('RETURN i.id'));

    it('reads the active policies of the tenant from MongoDB, not from the graph', async () => {
      sodPolicies.push(policy('Finance SoD', ['ent-a', 'ent-b']));
      servePaths([]);

      const result = await service.getTransitiveSodViolations('user-1', 'tenant-1');

      expect(sodPolicyModel.find).toHaveBeenCalledWith({ tenantId: 'tenant-1', isActive: true });
      expect(result).toEqual({ identityFound: true, policiesChecked: 1, violations: [] });
      const [cypher, params] = pathQueries()[0];
      expect(cypher).not.toContain('SodPolicy');
      expect(params).toEqual({
        id: 'user-1',
        tenantId: 'tenant-1',
        entitlementIds: ['entra-id::ent-a', 'entra-id::ent-b'],
      });
    });

    it('reports a policy whose every entitlement the identity reaches, with the shortest path to each', async () => {
      sodPolicies.push(policy('Finance SoD', ['ent-a', 'ent-b']));
      servePaths([
        mockRecord({ e: eA, path: nested(eA) }),
        mockRecord({ e: eA, path: direct(eA) }),
        mockRecord({ e: eB, path: nested(eB) }),
      ]);

      const { violations } = await service.getTransitiveSodViolations('user-1', 'tenant-1');

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        policyName: 'Finance SoD',
        severity: 'HIGH',
        action: 'BLOCK',
      });
      expect(violations[0].entitlementA.id).toBe('entra-id::ent-a');
      expect(violations[0].entitlementB.id).toBe('entra-id::ent-b');
      expect(violations[0].pathToA.depth).toBe(1);
      expect(violations[0].pathToB.depth).toBe(2);
      expect(violations[0].conflictingEntitlements.map((c) => c.entitlement.id)).toEqual([
        'entra-id::ent-a',
        'entra-id::ent-b',
      ]);
    });

    // FOLLOWUPS 2026-11-25 (graph-resync.service.ts:242): the graph keys a group by the catalog's
    // native id; a policy that names it by display name, as a rule does, must find that node.
    it("matches a policy's entitlement to the catalog's node, by native id or by its one name", async () => {
      catalogEntries = [{ system: 'entra-id', nativeId: 'ent-a', name: 'Finance-Admin' }];
      sodPolicies.push(policy('Finance SoD', ['Finance-Admin', 'ent-b']));
      servePaths([
        mockRecord({ e: eA, path: direct(eA) }),
        mockRecord({ e: eB, path: direct(eB) }),
      ]);

      const { violations } = await service.getTransitiveSodViolations('user-1', 'tenant-1');

      expect(catalogModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', system: { $in: ['entra-id'] } }),
      );
      expect(pathQueries()[0][1]).toMatchObject({
        entitlementIds: ['entra-id::ent-a', 'entra-id::ent-b'],
      });
      expect(violations.map((v) => [v.policyName, v.entitlementA.id, v.entitlementB.id])).toEqual([
        ['Finance SoD', 'entra-id::ent-a', 'entra-id::ent-b'],
      ]);
    });

    // Hunt 06 F3: with nodes keyed by native id alone, "admin" in AD and "admin" in Okta were one
    // node, so holding one looked like holding both and raised a conflict across systems.
    it('does not take an entitlement of one system for the same native id in another', async () => {
      const adAdmin = mockNeo4jNode('ad::admin', ['Entitlement'], { name: 'AD admins' });
      sodPolicies.push({
        ...policy('Admins in two systems', []),
        conflictingEntitlements: [
          { system: 'ad', type: 'group', targetId: 'admin' },
          { system: 'okta', type: 'group', targetId: 'admin' },
        ],
      });
      servePaths([mockRecord({ e: adAdmin, path: direct(adAdmin) })]);

      const { violations } = await service.getTransitiveSodViolations('user-1', 'tenant-1');

      expect(pathQueries()[0][1]).toMatchObject({ entitlementIds: ['ad::admin', 'okta::admin'] });
      expect(violations).toEqual([]);
    });

    it('lists every entitlement of a policy that names more than two', async () => {
      const eC = mockNeo4jNode('entra-id::ent-c', ['Entitlement']);
      sodPolicies.push(policy('Triple', ['ent-a', 'ent-b', 'ent-c']));
      servePaths([
        mockRecord({ e: eA, path: direct(eA) }),
        mockRecord({ e: eB, path: direct(eB) }),
        mockRecord({ e: eC, path: nested(eC) }),
      ]);

      const {
        violations: [violation],
      } = await service.getTransitiveSodViolations('user-1', 'tenant-1');

      expect(
        violation.conflictingEntitlements.map((c) => [c.entitlement.id, c.path.depth]),
      ).toEqual([
        ['entra-id::ent-a', 1],
        ['entra-id::ent-b', 1],
        ['entra-id::ent-c', 2],
      ]);
    });

    it('reports nothing when the identity reaches only some of the entitlements', async () => {
      sodPolicies.push(policy('Finance SoD', ['ent-a', 'ent-b']));
      servePaths([mockRecord({ e: eA, path: direct(eA) })]);

      expect((await service.getTransitiveSodViolations('user-1', 'tenant-1')).violations).toEqual(
        [],
      );
    });

    it('queries no paths when the tenant has no active policy, and says none was checked', async () => {
      servePaths([]);

      expect(await service.getTransitiveSodViolations('user-1', 'tenant-1')).toEqual({
        identityFound: true,
        policiesChecked: 0,
        violations: [],
      });
      expect(pathQueries()).toHaveLength(0);
    });

    it('says the identity is not in the graph instead of "no violations"', async () => {
      sodPolicies.push(policy('Finance SoD', ['ent-a', 'ent-b']));
      servePaths([], false);

      expect(await service.getTransitiveSodViolations('user-1', 'tenant-1')).toEqual({
        identityFound: false,
        policiesChecked: 1,
        violations: [],
      });
      expect(pathQueries()).toHaveLength(0);
    });

    // Fail closed also without a policy: the answer would otherwise read "no violations".
    it('fails closed with 503 when the graph store cannot answer, with or without policies', async () => {
      graphService.readStrict.mockRejectedValue(unavailable());
      await expect(service.getTransitiveSodViolations('user-1', 'tenant-1')).rejects.toThrow(
        ServiceUnavailableException,
      );

      sodPolicies.push(policy('Finance SoD', ['ent-a', 'ent-b']));
      await expect(service.getTransitiveSodViolations('user-1', 'tenant-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  // ── Node type inference ────────────────────────────────────────────

  describe('node type inference', () => {
    it('should infer Identity type from labels', async () => {
      const identityNode = mockNeo4jNode('user-1', ['Identity']);
      const entNode = mockNeo4jNode('ent-1', ['Entitlement']);
      const rel = mockNeo4jRel('r1', 'HAS_ACCESS', 'user-1', 'ent-1');
      const path = mockPath([{ start: identityNode, end: entNode, relationship: rel }]);

      graphService.readStrict.mockResolvedValue({
        records: [mockRecord({ i: identityNode, path })],
      } as any);

      const result = await service.getIdentityAccessGraph('user-1', 'tenant-1');
      const identity = result.nodes.find((n) => n.id === 'user-1');
      expect(identity?.type).toBe('Identity');
    });

    it('should infer Application type from labels', async () => {
      const identityNode = mockNeo4jNode('user-1', ['Identity']);
      const appNode = mockNeo4jNode('app-1', ['Application'], { name: 'Slack' });
      const rel = mockNeo4jRel('r1', 'HAS_ACCESS', 'user-1', 'app-1');
      const path = mockPath([{ start: identityNode, end: appNode, relationship: rel }]);

      graphService.readStrict.mockResolvedValue({
        records: [mockRecord({ i: identityNode, path })],
      } as any);

      const result = await service.getIdentityAccessGraph('user-1', 'tenant-1');
      const app = result.nodes.find((n) => n.id === 'app-1');
      expect(app?.type).toBe('Application');
    });

    it('should fall back to Entitlement for unknown labels', async () => {
      const identityNode = mockNeo4jNode('user-1', ['Identity']);
      const unknownNode = mockNeo4jNode('x-1', ['SomeOther'], { name: 'Unknown' });
      const rel = mockNeo4jRel('r1', 'HAS_ACCESS', 'user-1', 'x-1');
      const path = mockPath([{ start: identityNode, end: unknownNode, relationship: rel }]);

      graphService.readStrict.mockResolvedValue({
        records: [mockRecord({ i: identityNode, path })],
      } as any);

      const result = await service.getIdentityAccessGraph('user-1', 'tenant-1');
      const unknown = result.nodes.find((n) => n.id === 'x-1');
      expect(unknown?.type).toBe('Entitlement');
    });
  });
});
