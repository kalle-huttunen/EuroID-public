/**
 * Canvas handler logic -- add & delete connectors.
 * Pure functions that return new state; the component calls setState.
 */
import React from 'react';
import { Node, Edge } from '@xyflow/react';
import { sourceStyle, targetStyle, edgeStyle } from './nodes';

// ── Types ────────────────────────────────────────────────────────────

export interface AddSystemResult {
    node: Node;
    edge: Edge;
}

// ── Add System ───────────────────────────────────────────────────────

/**
 * Creates a new node + edge for a connector (source or target).
 * Uses the custom 'connectorNode' type so badges/dots render.
 * The caller must set `node.data` with label, role, etc.
 */
export function buildNewConnector(
    type: string,
    direction: 'source' | 'target',
    _icon: React.ReactElement,
    existingNodes: Node[],
): AddSystemResult {
    const slug = type.toLowerCase().replace(/[\s/]+/g, '-');
    const id = `${slug}-${direction}-${Date.now()}`;
    const isSource = direction === 'source';

    // Count existing nodes on that side for smart vertical stacking
    const existingSide = existingNodes.filter(n =>
        isSource
            ? (n.id.includes('-source'))
            : n.id.includes('-target'),
    );
    const yOffset = 150 + existingSide.length * 100;

    const node: Node = {
        id,
        type: 'connectorNode',
        data: { label: null, role: direction }, // placeholder -- caller sets full data
        position: isSource ? { x: 50, y: yOffset } : { x: 700, y: yOffset },
        style: isSource ? sourceStyle : targetStyle,
    };

    const edge: Edge = isSource
        ? { id: `${id}-core`, source: id, target: 'euroid-core', style: edgeStyle, label: 'Data Feed' }
        : { id: `core-${id}`, source: 'euroid-core', target: id, style: edgeStyle, label: 'Provisioning' };

    return { node, edge };
}

// ── Delete Connector ─────────────────────────────────────────────────

/**
 * Returns filtered nodes and edges with the given node removed.
 */
export function removeConnector(
    nodeId: string,
    nodes: Node[],
    edges: Edge[],
): { nodes: Node[]; edges: Edge[] } {
    return {
        nodes: nodes.filter(n => n.id !== nodeId),
        edges: edges.filter(e => e.source !== nodeId && e.target !== nodeId),
    };
}
