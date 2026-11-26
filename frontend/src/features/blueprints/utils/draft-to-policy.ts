/**
 * Transform policy draft nodes/edges to backend Policy format for simulation.
 * POST /api/v1/policy/simulate expects { policy: Partial<Policy> }.
 */
import type { PolicyNode, PolicyEdge } from '@stores/policy-draft-store';

export interface DraftPolicy {
  name: string;
  description: string;
  conditionGroups: Array<{
    id: string;
    join: 'AND' | 'OR';
    conditions: Array<{
      id: string;
      field: string;
      operator: string;
      value: string | string[];
    }>;
  }>;
  actions: Array<{
    id: string;
    type: string;
    target: string;
    params: Record<string, unknown>;
  }>;
}

export function draftToPolicy(
  draftNodes: PolicyNode[],
  draftEdges: PolicyEdge[]
): DraftPolicy {
  const conditionNodes = draftNodes.filter((n) => n.type === 'condition');
  const actionNodes = draftNodes.filter((n) => n.type === 'action');

  const reachableActionIds = new Set<string>();
  for (const edge of draftEdges) {
    const sourceNode = draftNodes.find((n) => n.id === edge.source);
    const targetNode = draftNodes.find((n) => n.id === edge.target);
    if (sourceNode?.type === 'condition' && targetNode?.type === 'action') {
      reachableActionIds.add(edge.target);
    }
  }

  const conditions = conditionNodes.map((n): { id: string; field: string; operator: string; value: string | string[] } => {
    const v = n.data.value;
    return {
      id: n.id,
      field: String(n.data.field || 'department'),
      operator: String(n.data.operator || 'equals'),
      value: typeof v === 'string' ? v : Array.isArray(v) ? v : String(v ?? ''),
    };
  });

  const actions = actionNodes
    .filter((n) => reachableActionIds.has(n.id))
    .map((n) => ({
      id: n.id,
      type: String(n.data.actionType || 'assign_group'),
      target: String(n.data.targetSystem || 'all'),
      params: (n.data.params as Record<string, unknown>) || {},
    }));

  return {
    name: 'Draft Policy',
    description: 'Visual policy from canvas',
    conditionGroups:
      conditions.length > 0
        ? [{ id: 'cg1', join: 'AND' as const, conditions }]
        : [],
    actions,
  };
}
