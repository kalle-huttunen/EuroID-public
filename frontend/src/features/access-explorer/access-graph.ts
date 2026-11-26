/**
 * An identity's access graph as table rows and as a canvas layout. Rows: every node the identity
 * reaches, nearest first, each with the shortest way there (breadth first over the answer's
 * relationships, which point at node ids). The canvas: the identity on the left, then a column per
 * hop, at most CANVAS_NODE_LIMIT nodes besides the identity (the nearest ones); the page says how
 * many were left out and the table still lists them all.
 */
import type { Edge, Node } from '@xyflow/react';
import type { IGraphNode, IGraphRelationship, IIdentityAccessGraph } from '../../interfaces';
import { edgeLabel } from './access-explorer-labels';

/** Most nodes the canvas draws besides the identity. */
export const CANVAS_NODE_LIMIT = 60;

const COLUMN_WIDTH = 300;
const ROW_HEIGHT = 84;

export interface AccessRow {
  node: IGraphNode;
  /** Hops from the identity. */
  depth: number;
  /** The nodes between the identity and this one on the shortest way. */
  via: IGraphNode[];
  /** The relationship that reaches this node on that way. */
  edge: IGraphRelationship;
}

export interface GraphNodeData extends Record<string, unknown> {
  node: IGraphNode;
  root: boolean;
}

export interface CanvasLayout {
  nodes: Node<GraphNodeData>[];
  edges: Edge[];
  /** Nodes besides the identity: drawn, and in the answer. */
  shown: number;
  total: number;
}

const order = (a: IGraphNode, b: IGraphNode) =>
  a.type.localeCompare(b.type) ||
  String(a.properties.system ?? '').localeCompare(String(b.properties.system ?? '')) ||
  (a.label || a.id).localeCompare(b.label || b.id);

export function accessRows(graph: IIdentityAccessGraph): AccessRow[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, IGraphRelationship[]>();
  for (const rel of graph.relationships) {
    out.set(rel.sourceId, [...(out.get(rel.sourceId) ?? []), rel]);
  }

  const rows: AccessRow[] = [];
  const reached = new Map<string, AccessRow | null>([[graph.identityId, null]]);
  let frontier = [graph.identityId];
  for (let depth = 1; frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const from of frontier) {
      const before = reached.get(from);
      for (const rel of out.get(from) ?? []) {
        const node = byId.get(rel.targetId);
        if (!node || reached.has(node.id)) continue;
        const via = before ? [...before.via, before.node] : [];
        const row = { node, depth, via, edge: rel };
        reached.set(node.id, row);
        rows.push(row);
        next.push(node.id);
      }
    }
    frontier = next;
  }
  return rows.sort((a, b) => a.depth - b.depth || order(a.node, b.node));
}

export function canvasLayout(
  graph: IIdentityAccessGraph,
  rows: AccessRow[],
  limit = CANVAS_NODE_LIMIT,
): CanvasLayout {
  const root = graph.nodes.find((n) => n.id === graph.identityId);
  const drawn = rows.slice(0, limit);
  const columns = new Map<number, AccessRow[]>();
  for (const row of drawn) columns.set(row.depth, [...(columns.get(row.depth) ?? []), row]);
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const top = (count: number) => ((tallest - count) * ROW_HEIGHT) / 2;

  const nodes: Node<GraphNodeData>[] = [];
  if (root) {
    nodes.push({
      id: root.id,
      type: 'graphNode',
      position: { x: 0, y: top(1) },
      data: { node: root, root: true },
    });
  }
  for (const [depth, column] of columns) {
    column.forEach((row, i) =>
      nodes.push({
        id: row.node.id,
        type: 'graphNode',
        position: { x: depth * COLUMN_WIDTH, y: top(column.length) + i * ROW_HEIGHT },
        data: { node: row.node, root: false },
      }),
    );
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = graph.relationships
    .filter((r) => ids.has(r.sourceId) && ids.has(r.targetId))
    .map((r) => ({
      id: r.id,
      source: r.sourceId,
      target: r.targetId,
      label: edgeLabel(r),
      ...(r.type === 'MEMBER_OF' ? { style: { strokeDasharray: '5 5' } } : {}),
    }));

  return { nodes, edges, shown: drawn.length, total: rows.length };
}
