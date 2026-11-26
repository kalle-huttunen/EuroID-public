/**
 * computeUserDelta: what the policy intent does to a person in one target system, for the impact
 * analysis (POST /blueprints/impact-analysis).
 */
import { computeUserDelta } from './impact-delta.util';
import { createMockUser } from '@testing/mock-factories';

describe('computeUserDelta', () => {
  const policy = {
    operations: [
      { target: 'entra-id', targetId: 'grp-finance', type: 'group' },
      { target: 'entra-id', targetId: 'role-reader', type: 'role' },
      { target: 'entra-id', targetId: 'ENTERPRISEPACK', type: 'license' },
    ],
  };

  // HX-F2 follow-up: every operation but a license was typed group, so a directory role
  // appeared among the groups of the Entra ID preview
  it('types each entitlement change as the policy does: group, role or license', () => {
    const delta = computeUserDelta(createMockUser(), policy, [], 'entra-id');

    expect(delta.entitlementChanges.map((c) => [c.type, c.targetId])).toEqual([
      ['group', 'grp-finance'],
      ['role', 'role-reader'],
      ['license', 'ENTERPRISEPACK'],
    ]);
  });

  it('shows the UPN the person has, else their email, never one on an invented domain', () => {
    const withUpn = computeUserDelta(
      createMockUser({ userPrincipalName: 'ada@corp.test' }),
      policy,
      [],
      'entra-id',
    );
    const withoutUpn = computeUserDelta(
      createMockUser({ userPrincipalName: undefined, email: 'ada@other.test' }),
      policy,
      [],
      'entra-id',
    );

    expect(withUpn.upn).toBe('ada@corp.test');
    expect(withoutUpn.upn).toBe('ada@other.test');
  });
});
