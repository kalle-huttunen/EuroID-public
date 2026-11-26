/**
 * Texts and small formatters of the access explorer page. A grant is described from what the
 * graph stores on the relationship: grantedBy and source (written by the resync from MongoDB),
 * connector and grantedAt (written when provisioning completes). Anything else is "not recorded".
 */
import type { IAccessPath, IGraphNode, IGraphRelationship } from '../../interfaces';

export const PAGE_SUBTITLE =
  'Who has access to what, read from the access graph (Neo4j): an identity and the entitlements it reaches directly or through groups, who holds an entitlement, the path between them, and SoD conflicts reached through nested groups.';

export const HOW_THE_GRAPH_IS_FILLED =
  'How the graph is filled: an administrator configures Neo4j on the API and the worker (NEO4J_URL, NEO4J_USER, NEO4J_PASSWORD) and restarts them; a super-admin then loads it from MongoDB with Load graph from MongoDB on this page. After that, completed provisioning keeps it current.';

export const NO_ACCOUNTS_NOTE =
  'The graph holds identities, entitlements and applications. Accounts in the target systems are not in the graph: the Entitlement map on the identity page shows them per system. Nothing writes group nesting to the graph yet, so access through nested groups does not show here.';

export const NOT_IN_GRAPH_HINT =
  'The graph has no node for it yet: it was not loaded since the identity or entitlement was created, or it was never provisioned while the graph was connected. A super-admin loads the graph from MongoDB with Load graph from MongoDB.';

export const RESYNC_TITLE = 'Load the graph from MongoDB';

export const RESYNC_EXPLANATION = [
  "Writes this tenant's identities, the entitlement catalog entries that have an id in their system, and the access the identity page shows as Active: policy grants on a system where the account is synced, and active access requests.",
  'Then removes what MongoDB no longer has for this tenant (identities, entitlements, applications and their access). Group nesting is not in MongoDB and is kept. Other tenants are not touched.',
  'It runs while you wait: one policy evaluation per identity with a synced account.',
];

export const TYPE_LABEL: Record<IGraphNode['type'], string> = {
  Identity: 'Identity',
  Entitlement: 'Entitlement',
  Application: 'Application',
  Role: 'Role',
};

/** An identity's work email when the graph has it, else its id. */
export function identityText(node: IGraphNode): string {
  const email = node.properties.email;
  return typeof email === 'string' && email ? email : node.label || node.id;
}

/** System and type of an entitlement, as the graph stores them. */
export function entitlementDetail(node: IGraphNode): string {
  const p = node.properties;
  return [p.system, p.entitlementType].filter((v) => typeof v === 'string' && v).join(' · ');
}

const intPart = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  const low = (v as { low?: unknown } | null)?.low;
  return typeof low === 'number' ? low : undefined;
};

/** A Neo4j datetime as the API serializes it ({ year, month, day, ... }), or an ISO string. */
export function graphDate(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, 10);
  const v = value as { year?: unknown; month?: unknown; day?: unknown } | null;
  const [y, m, d] = [intPart(v?.year), intPart(v?.month), intPart(v?.day)];
  if (y === undefined || m === undefined || d === undefined) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** How the relationship into a node was granted, as far as the graph knows. */
export function grantText(rel: IGraphRelationship | undefined): string {
  if (!rel) return '';
  if (rel.type === 'MEMBER_OF') return 'Member of the group';
  const p = rel.properties;
  if (p.grantedBy === 'policy') return `Policy: ${String(p.source ?? 'unnamed')}`;
  if (p.grantedBy === 'request') return String(p.source ?? 'Access request');
  if (typeof p.connector === 'string' && p.connector) {
    const date = graphDate(p.grantedAt);
    return `Provisioned in ${p.connector}${date ? ` on ${date}` : ''}`;
  }
  return 'Not recorded in the graph';
}

/** Short edge label on the canvas. */
export function edgeLabel(rel: IGraphRelationship): string | undefined {
  if (rel.type === 'MEMBER_OF') return 'member of';
  if (rel.properties.grantedBy === 'policy') return 'policy';
  if (rel.properties.grantedBy === 'request') return 'request';
  return undefined;
}

/** "Direct" for one hop, else the nodes in between. */
export function pathSummary(path: Pick<IAccessPath, 'nodes' | 'depth'>): string {
  if (path.depth <= 1) return 'Direct';
  const between = path.nodes.slice(1, -1).map((n) => n.label || n.id);
  return `Via ${between.join(' → ')}`;
}
