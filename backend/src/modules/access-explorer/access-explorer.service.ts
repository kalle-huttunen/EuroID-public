/**
 * Access Explorer Service
 *
 * Queries Neo4j for identity access graph data: full access graphs, entitlement holders, shortest
 * access paths, and transitive SoD violations (the SoD policies themselves are read from MongoDB).
 *
 * Fail closed: every method reads through GraphService.readStrict, which answers 503 with what to
 * do when Neo4j is not configured, not connected or a query fails. An empty answer always means
 * the graph was asked; whether the identity or entitlement is in the graph at all is said
 * separately (identityFound, entitlement, entitlementFound), so "no access" never stands for
 * "the graph does not know this identity". The graph is filled by GraphSyncService (events) and
 * GraphResyncService (from MongoDB).
 */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import neo4j from 'neo4j-driver';
import { GraphService } from '@infrastructure/graph/graph.service';
import type {
  AccessPath,
  AccessPathResult,
  EntitlementHolders,
  GraphNode,
  IdentityAccessGraph,
  SodViolation,
  SodViolationsResult,
} from '@infrastructure/graph/graph.interface';
import {
  SodPolicy,
  type SodEntitlementRef,
  type SodPolicyDocument,
} from '../policy/schemas/sod-policy.schema';
import {
  EntitlementCatalog,
  type EntitlementCatalogDocument,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { loadCatalogTargetLookup } from '../entitlement-catalog/catalog-target-lookup';
import { pathsToGraph, toAccessPath, toGraphNode } from './graph-records';
import { entitlementNodeId } from './entitlement-node-id';

/** Most paths an identity graph answer carries; the answer says when the graph had more. */
export const IDENTITY_GRAPH_PATH_LIMIT = 2000;
/** Most holder paths an entitlement holders answer carries. */
export const HOLDER_PATH_LIMIT = 1000;

/** LIMIT takes an integer; a JS number goes to Neo4j as a float. One more tells a cut answer. */
const limitPlusOne = (limit: number) => neo4j.int(limit + 1);

@Injectable()
export class AccessExplorerService {
  constructor(
    private readonly graphService: GraphService,
    @InjectModel(SodPolicy.name) private readonly sodPolicyModel: Model<SodPolicyDocument>,
    @InjectModel(EntitlementCatalog.name)
    private readonly catalogModel: Model<EntitlementCatalogDocument>,
  ) {}

  /**
   * The identity and every node reachable from it by direct assignment or through group nesting
   * (HAS_ACCESS / MEMBER_OF, up to 5 hops), at most IDENTITY_GRAPH_PATH_LIMIT paths.
   */
  async getIdentityAccessGraph(identityId: string, tenantId: string): Promise<IdentityAccessGraph> {
    const result = await this.graphService.readStrict(
      `MATCH (i:Identity {id: $id, tenantId: $tenantId})
       OPTIONAL MATCH path = (i)-[:HAS_ACCESS|MEMBER_OF*1..5]->(e)
       RETURN i, path
       LIMIT $limit`,
      { id: identityId, tenantId, limit: limitPlusOne(IDENTITY_GRAPH_PATH_LIMIT) },
    );

    const truncated = result.records.length > IDENTITY_GRAPH_PATH_LIMIT;
    const records = result.records.slice(0, IDENTITY_GRAPH_PATH_LIMIT);
    const graph = pathsToGraph(records.map((r) => r.get('path')));
    const identity = records[0]?.get('i');
    if (identity) {
      const node = toGraphNode(identity);
      if (!graph.nodes.some((n) => n.id === node.id)) graph.nodes.unshift(node);
    }
    return { ...graph, identityFound: records.length > 0, truncated };
  }

  /**
   * Every identity that reaches the entitlement, directly or through group nesting (one holder
   * per path), at most HOLDER_PATH_LIMIT paths; entitlement null when the graph has no node for it.
   */
  async getEntitlementHolders(
    entitlementId: string,
    tenantId: string,
  ): Promise<EntitlementHolders> {
    const result = await this.graphService.readStrict(
      `MATCH (e:Entitlement {id: $entitlementId, tenantId: $tenantId})
       OPTIONAL MATCH path = (i:Identity {tenantId: $tenantId})-[:HAS_ACCESS|MEMBER_OF*1..5]->(e)
       RETURN e, i, path
       LIMIT $limit`,
      { entitlementId, tenantId, limit: limitPlusOne(HOLDER_PATH_LIMIT) },
    );

    const truncated = result.records.length > HOLDER_PATH_LIMIT;
    const records = result.records.slice(0, HOLDER_PATH_LIMIT);
    const node = records[0]?.get('e');
    const holders = records
      .filter((r) => r.get('i'))
      .map((r) => ({ identity: toGraphNode(r.get('i')), path: toAccessPath(r.get('path')) }));
    return { entitlement: node ? toGraphNode(node) : null, holders, truncated };
  }

  /** The shortest path from the identity to the entitlement, and which ends the graph has. */
  async findAccessPath(
    identityId: string,
    entitlementId: string,
    tenantId: string,
  ): Promise<AccessPathResult> {
    const result = await this.graphService.readStrict(
      `OPTIONAL MATCH (i:Identity {id: $identityId, tenantId: $tenantId})
       OPTIONAL MATCH (e:Entitlement {id: $entitlementId, tenantId: $tenantId})
       OPTIONAL MATCH path = shortestPath((i)-[:HAS_ACCESS|MEMBER_OF*1..10]->(e))
       RETURN i IS NOT NULL AS identityFound, e IS NOT NULL AS entitlementFound, path`,
      { identityId, entitlementId, tenantId },
    );

    const record = result.records[0];
    const path = record?.get('path');
    return {
      identityFound: record?.get('identityFound') === true,
      entitlementFound: record?.get('entitlementFound') === true,
      path: path ? toAccessPath(path) : null,
    };
  }

  /**
   * Separation of Duties violations through direct and nested access: the tenant's active SoD
   * policies (MongoDB `sod_policies`, as SodService checks them) whose every entitlement the
   * identity reaches in the graph (HAS_ACCESS / MEMBER_OF, up to 5 hops), each with the shortest
   * path found to it. A policy entitlement is matched to the :Entitlement node of its catalog
   * entry, keyed by system and native id (entitlement-node-id.ts, so one native id in two
   * systems is two entitlements), found as a rule's grant is linked (catalogTargetLookup: by
   * native id, else the one entry with that name on the system), so a policy naming a group by
   * display name, as SodService matches a rule, finds it; one the catalog does not know, or names
   * twice, is matched by its system and own id. entitlementA/B and pathToA/B are the policy's
   * first two entitlements; conflictingEntitlements lists all of them. The graph is asked whether
   * it has the identity even when no policy applies, so a missing graph is a 503.
   */
  async getTransitiveSodViolations(
    identityId: string,
    tenantId: string,
  ): Promise<SodViolationsResult> {
    const known = await this.graphService.readStrict(
      `MATCH (i:Identity {id: $id, tenantId: $tenantId}) RETURN i.id AS id LIMIT 1`,
      { id: identityId, tenantId },
    );
    const identityFound = known.records.length > 0;

    const policies = await this.sodPolicyModel.find({ tenantId, isActive: true }).lean().exec();
    const withRefs = policies.filter((p) => p.conflictingEntitlements?.length);
    const answer = (violations: SodViolation[]) => ({
      identityFound,
      policiesChecked: withRefs.length,
      violations,
    });
    if (!identityFound || withRefs.length === 0) return answer([]);

    const refs = withRefs.flatMap((p) => p.conflictingEntitlements);
    const entryOf = await loadCatalogTargetLookup(this.catalogModel, tenantId, refs);
    const keyOf = (ref: SodEntitlementRef) => {
      const entry = entryOf(ref);
      return entry
        ? entitlementNodeId(entry.system, entry.nativeId)
        : entitlementNodeId(ref.system, ref.targetId);
    };
    const entitlementIds = [...new Set(refs.map(keyOf))];
    const result = await this.graphService.readStrict(
      `MATCH path = (i:Identity {id: $id, tenantId: $tenantId})-[:HAS_ACCESS|MEMBER_OF*1..5]->(e:Entitlement {tenantId: $tenantId})
       WHERE e.id IN $entitlementIds
       RETURN e, path`,
      { id: identityId, tenantId, entitlementIds },
    );

    const reached = new Map<string, { entitlement: GraphNode; path: AccessPath }>();
    for (const record of result.records) {
      const entitlement = toGraphNode(record.get('e'));
      const path = toAccessPath(record.get('path'));
      const seen = reached.get(entitlement.id);
      if (!seen || path.depth < seen.path.depth) reached.set(entitlement.id, { entitlement, path });
    }

    const violations: SodViolation[] = [];
    for (const policy of withRefs) {
      const conflicting = policy.conflictingEntitlements.map((r) => reached.get(keyOf(r)));
      if (conflicting.some((c) => !c)) continue;
      const all = conflicting as Array<{ entitlement: GraphNode; path: AccessPath }>;
      violations.push({
        policyName: policy.name,
        severity: policy.severity,
        action: policy.action,
        entitlementA: all[0].entitlement,
        entitlementB: all[1]?.entitlement ?? all[0].entitlement,
        pathToA: all[0].path,
        pathToB: all[1]?.path ?? all[0].path,
        conflictingEntitlements: all,
      });
    }
    return answer(violations);
  }
}
