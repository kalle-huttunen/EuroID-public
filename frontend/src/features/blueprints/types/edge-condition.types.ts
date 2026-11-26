/**
 * Edge condition types for Design Studio flow-scoped filters.
 * Conditions filter which users flow through a specific Brain-to-Connector edge.
 */
import type { ConditionOperator, ConditionJoinType } from '../../../components/policy-engine/types';

export interface EdgeCondition {
  id: string;
  field: string;
  operator: ConditionOperator;
  value: string | string[];
}

export interface EdgeConditionGroup {
  id: string;
  join: ConditionJoinType;
  conditions: EdgeCondition[];
}

/** Extended edge data stored on ReactFlow edges */
export interface EdgeFlowData extends Record<string, unknown> {
  /** Human-readable label shown on the edge (e.g., "Provisioning") */
  label?: string;
  /** Conditions that filter which users flow through this edge */
  conditionGroups?: EdgeConditionGroup[];
  /** Whether conditions are active */
  conditionsEnabled?: boolean;
}
