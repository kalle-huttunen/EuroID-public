/**
 * The HR source nodes of a Design studio canvas: source nodes whose connector type contains one of
 * the tenant's HR source tags, with the settings that rank them (ingest priority, 999 when unset;
 * Contract Tag) and the fields the node masters, sorted by ingest priority.
 *
 * Pure: BlueprintsService reads the saved canvas with it (the priorities reconcile merges by), and
 * the contract-critical mastery check (identity) the canvas being saved.
 */

export interface CanvasHrSource {
  name: string;
  ingestPriority: number;
  contractTag?: string;
  masteryFields?: string[];
}

interface CanvasNodeLike {
  data?: { role?: unknown; type?: unknown; config?: unknown };
}

export function canvasHrSources(
  nodes: readonly unknown[] | undefined,
  hrSourceTags: string[],
): CanvasHrSource[] {
  if (hrSourceTags.length === 0) return [];
  const result: CanvasHrSource[] = [];
  for (const node of (nodes ?? []) as CanvasNodeLike[]) {
    const type = node?.data?.type;
    if (node?.data?.role !== 'source' || typeof type !== 'string' || !type) continue;
    if (!hrSourceTags.some((id) => type.toLowerCase().includes(id))) continue;
    const config = node.data.config;
    const cfg = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
    result.push({
      name: type,
      ingestPriority: (cfg.ingestPriority as number) ?? 999,
      contractTag: cfg.contractTag as string | undefined,
      masteryFields: cfg.masteryFields as string[] | undefined,
    });
  }
  return result.sort((a, b) => a.ingestPriority - b.ingestPriority);
}
