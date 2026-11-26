/**
 * Graph Infrastructure — Type Definitions
 *
 * Types for Neo4j graph nodes, relationships, and query results
 * used by the Access Explorer module and graph sync.
 */

// ── Node Types ───────────────────────────────────────────────────────

export type GraphNodeType = 'Identity' | 'Entitlement' | 'Application' | 'Role';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  tenantId: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface IdentityNode extends GraphNode {
  type: 'Identity';
  properties: {
    email?: string;
    displayName?: string;
    department?: string;
    status?: string;
    [key: string]: unknown;
  };
}

export interface EntitlementNode extends GraphNode {
  type: 'Entitlement';
  properties: {
    nativeId: string;
    entitlementType: string; // 'Group' | 'License' | 'DirectoryRole'
    system: string;
    [key: string]: unknown;
  };
}

export interface ApplicationNode extends GraphNode {
  type: 'Application';
  properties: {
    system: string;
    connectorType?: string;
    [key: string]: unknown;
  };
}

export interface RoleNode extends GraphNode {
  type: 'Role';
  properties: {
    roleName: string;
    system: string;
    [key: string]: unknown;
  };
}

// ── Relationship Types ───────────────────────────────────────────────

export type GraphRelationshipType =
  | 'HAS_ACCESS'
  | 'MEMBER_OF'
  | 'GRANTS'
  | 'NESTED_IN'
  | 'BELONGS_TO';

export interface GraphRelationship {
  id: string;
  type: GraphRelationshipType;
  sourceId: string;
  targetId: string;
  properties: Record<string, unknown>;
}

// ── Query Results ────────────────────────────────────────────────────

export interface AccessPath {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  /** Total hops from identity to entitlement */
  depth: number;
}

export interface GraphQueryResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

export interface SodViolation {
  /** The SoD policy (MongoDB sod_policies) the identity's access matches */
  policyName?: string;
  severity?: string;
  /** BLOCK or WARN, as the policy says */
  action?: string;
  /** The policy's first two entitlements */
  entitlementA: GraphNode;
  entitlementB: GraphNode;
  /** Shortest paths from identity to those two */
  pathToA: AccessPath;
  pathToB: AccessPath;
  /** Every entitlement of the policy, in policy order, each with the shortest path to it */
  conflictingEntitlements: Array<{ entitlement: GraphNode; path: AccessPath }>;
}

export interface EntitlementHolder {
  identity: GraphNode;
  /** How the identity reaches this entitlement */
  path: AccessPath;
}

// ── Access explorer answers ──────────────────────────────────────────

/** An identity's access graph; identityFound false when the graph has no node for it. */
export interface IdentityAccessGraph extends GraphQueryResult {
  identityFound: boolean;
  /** The graph had more paths than the answer carries (IDENTITY_GRAPH_PATH_LIMIT). */
  truncated: boolean;
}

/** Who reaches an entitlement; entitlement null when the graph has no node for it. */
export interface EntitlementHolders {
  entitlement: GraphNode | null;
  holders: EntitlementHolder[];
  /** The graph had more holder paths than the answer carries (HOLDER_PATH_LIMIT). */
  truncated: boolean;
}

/** The shortest path, and whether each end is in the graph at all. */
export interface AccessPathResult {
  identityFound: boolean;
  entitlementFound: boolean;
  path: AccessPath | null;
}

/** The SoD violations of an identity and how many active policies were checked. */
export interface SodViolationsResult {
  identityFound: boolean;
  policiesChecked: number;
  violations: SodViolation[];
}
