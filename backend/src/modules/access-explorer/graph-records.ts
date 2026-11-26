/**
 * Neo4j records to the access explorer's graph types. A node's id is its `id` property (the
 * identity's `_id`, the entitlement's `<system>::<native id>`, the application's system), so a
 * relationship's sourceId and targetId are those ids too: the answer's edges point at the
 * answer's nodes.
 */
import type {
  Node as Neo4jNode,
  Relationship as Neo4jRelationship,
  Path as Neo4jPath,
} from 'neo4j-driver';
import type {
  AccessPath,
  GraphNode,
  GraphQueryResult,
  GraphRelationship,
} from '@infrastructure/graph/graph.interface';

export function toGraphNode(node: Neo4jNode): GraphNode {
  const labels = node.labels ?? [];
  const props = (node.properties ?? {}) as Record<string, unknown>;

  return {
    id: (props.id as string) ?? node.elementId ?? String(node.identity),
    type: nodeType(labels),
    tenantId: (props.tenantId as string) ?? '',
    label:
      (props.displayName as string) ??
      (props.name as string) ??
      (props.label as string) ??
      (props.id as string) ??
      '',
    properties: { ...props },
  };
}

function nodeType(labels: string[]): GraphNode['type'] {
  if (labels.includes('Identity')) return 'Identity';
  if (labels.includes('Entitlement')) return 'Entitlement';
  if (labels.includes('Application')) return 'Application';
  if (labels.includes('Role')) return 'Role';
  return 'Entitlement'; // Fallback
}

/** Element id of a path node to its business id, for the relationships between them. */
type NodeIds = Map<string, string>;

function elementIdOf(node: Neo4jNode): string {
  return node.elementId ?? String(node.identity);
}

function toGraphRelationship(rel: Neo4jRelationship, ids: NodeIds): GraphRelationship {
  const props = (rel.properties ?? {}) as Record<string, unknown>;
  const r = rel as unknown as {
    startNodeElementId?: string;
    start?: unknown;
    endNodeElementId?: string;
    end?: unknown;
  };
  const start = String(r.startNodeElementId ?? r.start);
  const end = String(r.endNodeElementId ?? r.end);
  return {
    id: rel.elementId ?? String(rel.identity),
    type: rel.type as GraphRelationship['type'],
    sourceId: ids.get(start) ?? start,
    targetId: ids.get(end) ?? end,
    properties: { ...props },
  };
}

/** Every node and relationship of these paths, each once. */
export function pathsToGraph(paths: Array<Neo4jPath | null | undefined>): GraphQueryResult {
  const nodes = new Map<string, GraphNode>();
  const rels = new Map<string, GraphRelationship>();
  for (const path of paths) {
    for (const segment of path?.segments ?? []) {
      const ids: NodeIds = new Map();
      for (const n of [segment.start, segment.end]) {
        const node = toGraphNode(n);
        ids.set(elementIdOf(n), node.id);
        nodes.set(node.id, node);
      }
      const rel = toGraphRelationship(segment.relationship, ids);
      rels.set(rel.id, rel);
    }
  }
  return { nodes: Array.from(nodes.values()), relationships: Array.from(rels.values()) };
}

/** One path in order: its nodes from the identity on, its relationships and its hop count. */
export function toAccessPath(path: Neo4jPath | null | undefined): AccessPath {
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  if (!path || !path.segments) return { nodes, relationships, depth: 0 };

  for (const segment of path.segments) {
    const start = toGraphNode(segment.start);
    const end = toGraphNode(segment.end);
    if (!nodes.find((n) => n.id === start.id)) nodes.push(start);
    nodes.push(end);
    const ids: NodeIds = new Map([
      [elementIdOf(segment.start), start.id],
      [elementIdOf(segment.end), end.id],
    ]);
    relationships.push(toGraphRelationship(segment.relationship, ids));
  }
  return { nodes, relationships, depth: relationships.length };
}
