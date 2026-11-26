/**
 * Per-source user counts for the canvas badges and HR-feed edge labels.
 *
 * Hub identities carry the `sourceSystem` their HR connector wrote: the
 * connector's configured "Source System Name", else its id ('csv-hr',
 * 'json-api-hr'). A source node is matched on the same value, so each node
 * counts only its own users. A node with no resolvable source system gets no
 * entry (and no badge).
 */
import { Node } from '@xyflow/react';
import { CONNECTOR_REGISTRY } from '../shared/connector-registry';

/** The `sourceSystem` value identities from this source node carry, if it can be told. */
export function sourceSystemOfNode(node: Node): string | undefined {
    const configured = (node.data?.config as { sourceSystem?: unknown } | undefined)?.sourceSystem;
    if (typeof configured === 'string' && configured.trim()) return configured.trim();
    if (typeof node.data?.type === 'string' && node.data.type) return node.data.type;
    const id = node.id.toLowerCase();
    return CONNECTOR_REGISTRY.find(
        (c) => c.direction === 'source' && c.idPatterns.some((p) => id.includes(p.toLowerCase())),
    )?.id;
}

/**
 * Count `users` per source node id. Returns no counts when `total` says `users`
 * is only a page of the hub, since a partial count would understate every source.
 */
export function countUsersPerSource(
    nodes: Node[],
    users: Array<{ sourceSystem?: string }>,
    total?: number,
): Record<string, number> {
    if (total != null && total > users.length) return {};
    const bySystem = new Map<string, number>();
    for (const u of users) {
        if (u.sourceSystem) bySystem.set(u.sourceSystem, (bySystem.get(u.sourceSystem) ?? 0) + 1);
    }
    const counts: Record<string, number> = {};
    for (const node of nodes) {
        if (node.data?.role !== 'source') continue;
        const system = sourceSystemOfNode(node);
        if (system) counts[node.id] = bySystem.get(system) ?? 0;
    }
    return counts;
}
