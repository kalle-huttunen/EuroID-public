/** The DRAFT policy an accepted suggestion creates (PolicySuggestionService.accept). */
import { RiskLevel, type Policy } from '../policy/schemas/policy.schema';
import type { SuggestedPolicy } from './schemas/suggestion.schema';

export function suggestedPolicyToPolicy(sp: SuggestedPolicy): Partial<Policy> {
  return {
    name: sp.name,
    conditionGroups: (sp.conditionGroups || []).map((g) => ({
      id: g.id,
      join: g.join,
      conditions: (g.conditions || []).map((c) => ({
        id: c.id,
        field: c.field,
        operator: c.operator,
        value: c.value,
      })),
    })),
    actions: (sp.actions || []).map((a) => ({
      id: a.id,
      type: a.type,
      target: a.target,
      params: a.params || {},
      label: a.label,
      description: a.description,
    })),
    risk: (sp.risk as RiskLevel) || RiskLevel.LOW,
    tags: [],
  };
}
