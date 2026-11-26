/**
 * Edge Condition Evaluator
 *
 * Evaluates whether a user matches the conditions defined on a
 * Brain-to-Connector edge in the Design Studio canvas. This is used
 * during provisioning workflows to filter which users flow to each
 * target system.
 *
 * Reuses the same condition logic as the Policy Engine but operates
 * on EdgeConditionGroup structures stored in edge.data.
 */

// ── Types (mirror frontend edge-condition.types.ts) ──────────────────

/** Operators evaluateCondition() implements; POST /blueprints/save accepts only these. */
export const EDGE_CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'starts_with',
  'ends_with',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
] as const;

export interface EdgeCondition {
  id: string;
  field: string;
  operator: string; // equals, not_equals, contains, in, etc.
  value: string | string[];
}

export interface EdgeConditionGroup {
  id: string;
  join: 'AND' | 'OR';
  conditions: EdgeCondition[];
}

export interface EdgeFlowData {
  label?: string;
  conditionGroups?: EdgeConditionGroup[];
  conditionsEnabled?: boolean;
}

// ── Evaluator ────────────────────────────────────────────────────────

/**
 * Evaluate whether a user matches all condition groups of an edge.
 * If conditions are not enabled or empty, returns true (no filter).
 */
export function evaluateEdgeConditions(
  user: Record<string, unknown>,
  edgeData: EdgeFlowData,
): boolean {
  // No conditions or disabled = allow through
  if (!edgeData?.conditionsEnabled) return true;
  if (!edgeData.conditionGroups?.length) return true;

  // All groups must pass (AND between groups)
  return edgeData.conditionGroups.every((group) => evaluateGroup(user, group));
}

function evaluateGroup(user: Record<string, unknown>, group: EdgeConditionGroup): boolean {
  if (!group.conditions?.length) return true;

  const results = group.conditions.map((c) => evaluateCondition(user, c));

  return group.join === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

function evaluateCondition(user: Record<string, unknown>, condition: EdgeCondition): boolean {
  const rawValue = resolveField(user, condition.field);

  if (condition.operator === 'is_empty') {
    return rawValue === undefined || rawValue === null || rawValue === '';
  }
  if (condition.operator === 'is_not_empty') {
    return rawValue !== undefined && rawValue !== null && rawValue !== '';
  }

  if (rawValue === undefined || rawValue === null) return false;

  const userStr = String(rawValue).toLowerCase();
  const condValue = condition.value;

  switch (condition.operator) {
    case 'equals':
      return userStr === String(condValue).toLowerCase();
    case 'not_equals':
      return userStr !== String(condValue).toLowerCase();
    case 'contains':
      return userStr.includes(String(condValue).toLowerCase());
    case 'starts_with':
      return userStr.startsWith(String(condValue).toLowerCase());
    case 'ends_with':
      return userStr.endsWith(String(condValue).toLowerCase());
    case 'in':
      if (Array.isArray(condValue)) {
        return condValue.map((v) => String(v).toLowerCase()).includes(userStr);
      }
      return userStr === String(condValue).toLowerCase();
    case 'not_in':
      if (Array.isArray(condValue)) {
        return !condValue.map((v) => String(v).toLowerCase()).includes(userStr);
      }
      return userStr !== String(condValue).toLowerCase();
    default:
      return false;
  }
}

/**
 * Resolve user field, supporting frontend aliases (department -> departmentName).
 */
function resolveField(user: Record<string, unknown>, field: string): unknown {
  const aliasMap: Record<string, string[]> = {
    department: ['departmentName', 'departmentCode', 'department'],
    location: ['location', 'officeLocation', 'officeName', 'city'],
    country: ['countryCode', 'country'],
  };

  const candidates = aliasMap[field] || [field];
  for (const key of candidates) {
    const v = user[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return user[field];
}
