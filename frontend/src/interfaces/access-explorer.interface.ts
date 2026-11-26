/**
 * Access explorer answers (`/access-explorer`, backend `modules/access-explorer`), written out from
 * the controller: the generated types carry no response bodies for these routes. A node's `id` is
 * its key in the graph: an identity's `_id`, an entitlement's native id, an application's system.
 * Relationships point at those ids. Every route answers 503 with a message when the graph is not
 * available.
 */

export type GraphNodeType = 'Identity' | 'Entitlement' | 'Application' | 'Role';
export type GraphRelationshipType =
  | 'HAS_ACCESS'
  | 'MEMBER_OF'
  | 'GRANTS'
  | 'NESTED_IN'
  | 'BELONGS_TO';

export interface IGraphNode {
  id: string;
  type: GraphNodeType;
  tenantId: string;
  /** displayName, name or the id, as the backend picks it. */
  label: string;
  /** The node's properties: email and status (identities), name, entitlementType, system. */
  properties: Record<string, unknown>;
}

export interface IGraphRelationship {
  id: string;
  type: GraphRelationshipType;
  sourceId: string;
  targetId: string;
  /** HAS_ACCESS: grantedBy and source (resync), connector and grantedAt (provisioning). */
  properties: Record<string, unknown>;
}

/** GET /access-explorer/identity/:id/graph */
export interface IIdentityAccessGraph {
  identityId: string;
  /** False: the graph has no node for the identity (not loaded), not "no access". */
  identityFound: boolean;
  nodes: IGraphNode[];
  relationships: IGraphRelationship[];
  nodeCount: number;
  relationshipCount: number;
  /** The graph has more paths than the answer carries (pathLimit). */
  truncated: boolean;
  pathLimit: number;
}

export interface IAccessPath {
  nodes: IGraphNode[];
  relationships: IGraphRelationship[];
  depth: number;
}

/** One holder per path: an identity reaching the entitlement two ways is listed twice. */
export interface IEntitlementHolder {
  identity: IGraphNode;
  pathDepth: number;
  pathNodes: IGraphNode[];
  pathRelationships: IGraphRelationship[];
}

/** GET /access-explorer/entitlement/:id/holders */
export interface IEntitlementHolders {
  entitlementId: string;
  entitlementFound: boolean;
  entitlement: IGraphNode | null;
  holders: IEntitlementHolder[];
  count: number;
  truncated: boolean;
  pathLimit: number;
}

/** GET /access-explorer/path?fromIdentity=&toEntitlement= */
export interface IAccessPathResult {
  fromIdentity: string;
  toEntitlement: string;
  identityFound: boolean;
  entitlementFound: boolean;
  found: boolean;
  path: IAccessPath | null;
}

export interface IGraphSodViolation {
  policyName?: string;
  severity?: string;
  action?: string;
  entitlementA: IGraphNode;
  entitlementB: IGraphNode;
  pathToA: IAccessPath;
  pathToB: IAccessPath;
  conflictingEntitlements: Array<{ entitlement: IGraphNode; path: IAccessPath }>;
}

/** GET /access-explorer/identity/:id/sod-violations */
export interface IGraphSodViolations {
  identityId: string;
  identityFound: boolean;
  /** Active SoD policies of the tenant that name entitlements. */
  policiesChecked: number;
  violations: IGraphSodViolation[];
  violationCount: number;
}

/** POST /access-explorer/resync (super-admin) */
export interface IGraphResyncResult {
  identities: number;
  entitlements: number;
  applications: number;
  grants: { policy: number; request: number };
  removed: {
    identities: number;
    entitlements: number;
    applications: number;
    relationships: number;
  };
  durationMs: number;
}
