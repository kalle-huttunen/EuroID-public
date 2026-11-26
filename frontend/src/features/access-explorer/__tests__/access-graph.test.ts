/**
 * accessRows and canvasLayout: every node the identity reaches, nearest first, with the shortest
 * way there; the canvas draws the identity and at most the limit of the nearest nodes, and only
 * the edges between drawn nodes.
 */
import { describe, it, expect } from 'vitest';
import { accessRows, canvasLayout } from '../access-graph';
import { ADA_GRAPH, ADA_ID, bigGraph, entitlementNode, rel } from './AccessExplorerPage.fixtures';

describe('accessRows', () => {
  it('lists each reached node once, nearest first, with the nodes in between and the edge into it', () => {
    const rows = accessRows(ADA_GRAPH);

    const summary = rows.map((r) => [r.node.id, r.depth, r.via.map((v) => v.id), r.edge.type]);
    expect(summary).toHaveLength(4);
    expect(summary.slice(0, 3)).toEqual(
      expect.arrayContaining([
        ['grp-all', 1, [], 'HAS_ACCESS'],
        ['grp-fin-appr', 1, [], 'HAS_ACCESS'],
        ['grp-fin-team', 1, [], 'MEMBER_OF'],
      ]),
    );
    expect(summary[3]).toEqual(['grp-fin-admin', 2, ['grp-fin-team'], 'HAS_ACCESS']);
  });

  it('keeps the shortest way when a node is reached directly and through a group', () => {
    const graph = {
      ...ADA_GRAPH,
      relationships: [...ADA_GRAPH.relationships, rel('HAS_ACCESS', ADA_ID, 'grp-fin-admin')],
    };

    const admin = accessRows(graph).find((r) => r.node.id === 'grp-fin-admin')!;
    expect([admin.depth, admin.via]).toEqual([1, []]);
  });

  it('ignores an edge to a node the answer does not carry', () => {
    const graph = {
      ...ADA_GRAPH,
      relationships: [...ADA_GRAPH.relationships, rel('HAS_ACCESS', ADA_ID, 'grp-missing')],
    };
    expect(accessRows(graph).map((r) => r.node.id)).not.toContain('grp-missing');
  });
});

describe('canvasLayout', () => {
  it('puts the identity left and a column per hop, with every edge between drawn nodes', () => {
    const layout = canvasLayout(ADA_GRAPH, accessRows(ADA_GRAPH));

    const x = (id: string) => layout.nodes.find((n) => n.id === id)!.position.x;
    expect(x(ADA_ID)).toBe(0);
    expect(x('grp-all')).toBeGreaterThan(0);
    expect(x('grp-fin-admin')).toBeGreaterThan(x('grp-fin-team'));
    expect(layout.edges).toHaveLength(4);
    expect(layout.edges.find((e) => e.target === 'grp-fin-team')).toMatchObject({
      label: 'member of',
      style: { strokeDasharray: '5 5' },
    });
    expect([layout.shown, layout.total]).toEqual([4, 4]);
  });

  it('draws at most the limit of nodes besides the identity, and no edge to a left-out node', () => {
    const graph = bigGraph();
    const layout = canvasLayout(graph, accessRows(graph), 60);

    expect(layout.nodes).toHaveLength(61);
    expect([layout.shown, layout.total]).toEqual([60, 70]);
    const drawn = new Set(layout.nodes.map((n) => n.id));
    expect(layout.edges.every((e) => drawn.has(e.target))).toBe(true);
    expect(drawn.has(entitlementNode('grp-69', 'Group 69').id)).toBe(false);
  });
});
