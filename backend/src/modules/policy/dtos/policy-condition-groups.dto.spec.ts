/**
 * Hunt 04 F11: a condition group with no conditions passed validation, and the engine evaluates
 * an AND group as `[].every(...)`, which is true: such a policy, once activated, granted its
 * actions to every identity. A group must hold at least one condition.
 */
import { CreatePolicySchema } from './create-policy.dto';
import { UpdatePolicySchema } from './update-policy.dto';

const condition = { id: 'c1', field: 'department', operator: 'equals', value: 'IT' };
const group = (conditions: unknown[]) => ({ id: 'g1', join: 'AND', conditions });

describe('Policy DTOs: condition groups', () => {
  it.each([
    ['create', CreatePolicySchema, { name: 'IT staff', actions: [] }],
    ['update', UpdatePolicySchema, {}],
  ] as const)('%s refuses a group without conditions', (_op, schema, base) => {
    const parsed = schema.safeParse({ ...base, conditionGroups: [group([])] });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('conditions');
  });

  it.each([
    ['create', CreatePolicySchema, { name: 'IT staff', actions: [] }],
    ['update', UpdatePolicySchema, {}],
  ] as const)('%s takes a group with a condition', (_op, schema, base) => {
    expect(schema.safeParse({ ...base, conditionGroups: [group([condition])] }).success).toBe(true);
  });
});
