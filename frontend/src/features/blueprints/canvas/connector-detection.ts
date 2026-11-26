/**
 * Active connector detection -- extracts connector names from canvas nodes.
 * Uses the shared connector registry for ID parsing.
 */
import React from 'react';
import { Node } from '@xyflow/react';
import { parseConnectorNameFromNodeId } from '../shared';
import { CONNECTOR_REGISTRY } from '../shared/connector-registry';

export interface ActiveConnectorInfo {
  name: string;
  type: 'source' | 'target';
  label: string;
}

/**
 * Given canvas nodes, returns full connector info for mastery dropdowns.
 * Includes both source and target connectors on the canvas.
 */
export function deriveActiveConnectorsForMastery(nodes: Node[]): ActiveConnectorInfo[] {
  const seen = new Set<string>();
  const result: ActiveConnectorInfo[] = [];
  for (const node of nodes) {
    const meta = CONNECTOR_REGISTRY.find((c) =>
      c.idPatterns.some((p) => node.id.toLowerCase().includes(p.toLowerCase())),
    );
    if (meta) {
      const id = meta.id ?? meta.name.toLowerCase().replace(/\s+/g, '-');
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({
        name: id,
        type: meta.direction,
        label: meta.name,
      });
    }
  }
  return result;
}

/**
 * Given the current canvas nodes, returns a list of active target connector names.
 * Used by SimulationDrawer and for passing to ConfigDrawer's field mapping tabs.
 */
export function detectActiveConnectors(nodes: Node[]): string[] {
  return nodes
    .filter((n) => n.id.includes('target'))
    .map((n) => {
      const nodeLabel = n.data?.label;
      if (typeof nodeLabel === 'string') return nodeLabel.trim();

      // Extract text from React elements (e.g. <Space><Icon /> Name</Space>)
      if (nodeLabel && typeof nodeLabel === 'object' && React.isValidElement(nodeLabel)) {
        const el = nodeLabel as React.ReactElement<{ children?: unknown }>;
        const children = el.props?.children;
        if (Array.isArray(children)) {
          // Collect ALL string children, trim, and filter out empty ones
          // This handles both <Space><Icon /> Name</Space> (children: [icon, " Name"])
          // and <Space>{icon} {name}</Space> (children: [icon, " ", name])
          const texts = (children as unknown[])
            .filter((c): c is string => typeof c === 'string')
            .map((c: string) => c.trim())
            .filter((c: string) => c.length > 0);
          if (texts.length > 0) return texts.join(' ');
        }
        if (typeof children === 'string') return children.trim();
      }

      // Fallback: parse from node ID using the registry
      return parseConnectorNameFromNodeId(n.id);
    })
    .filter((val): val is string => val !== '');
}

/**
 * The labels of the HR source nodes other than `selectedId` whose saved contract tag is PRIMARY
 * (what the backend reads from the canvas). Two Primary sources give every identity the same
 * primary HR source, by ingest priority, then Recon Config source order, then source name.
 */
export function otherPrimarySources(nodes: Node[], selectedId?: string): string[] {
  return nodes
    .filter((n) => n.id !== selectedId && n.data?.role === 'source')
    .filter(
      (n) => (n.data?.config as { contractTag?: unknown } | undefined)?.contractTag === 'PRIMARY',
    )
    .map((n) =>
      typeof n.data?.label === 'string' ? n.data.label : parseConnectorNameFromNodeId(n.id),
    );
}
