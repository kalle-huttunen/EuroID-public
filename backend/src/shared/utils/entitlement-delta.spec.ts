import {
  computeEntitlementDelta,
  isAppliedByMover,
  moverConnectorOf,
  moverSystemPlan,
  operationsForSystem,
  withoutRequestGrants,
} from './entitlement-delta';

const op = (target: string, targetId: string, action = 'add', type = 'group') => ({
  type,
  action,
  target,
  targetId,
});

describe('entitlement delta', () => {
  it('adds what only the new evaluation grants and removes what only the old one granted', () => {
    const delta = computeEntitlementDelta(
      [op('entra-id', 'g-sales'), op('entra-id', 'g-all')],
      [op('entra-id', 'g-eng'), op('entra-id', 'g-all')],
    );
    expect(delta).toEqual({
      toAdd: [op('entra-id', 'g-eng')],
      toRemove: [op('entra-id', 'g-sales', 'remove')],
    });
  });

  describe('operations for a target system', () => {
    const ops = [
      op('entra-id', 'e1'),
      op('entra', 'e2'),
      op('ad', 'a1'),
      op('active-directory', 'a2'),
      op('okta', 'o1'),
      op('all', 'x1'),
    ];

    it('matches Entra ID and AD by alias and takes the all-systems operations', () => {
      expect(operationsForSystem(ops, 'entra-id').map((o) => o.targetId)).toEqual([
        'e1',
        'e2',
        'x1',
      ]);
      expect(operationsForSystem(ops, 'ad').map((o) => o.targetId)).toEqual(['a1', 'a2', 'x1']);
      expect(operationsForSystem(ops, 'okta').map((o) => o.targetId)).toEqual(['o1', 'x1']);
    });
  });

  it('the mover updates Entra ID, Active Directory, Okta and SCIM', () => {
    expect(
      ['entra-id', 'entra', 'ad', 'active-directory', 'okta', 'scim'].map(moverConnectorOf),
    ).toEqual(['entra', 'entra', 'ad', 'ad', 'okta', 'scim']);
    expect(['github', 'servicenow', 'file-outbound', ''].map(moverConnectorOf)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('applies groups everywhere, roles and licenses in Entra ID only', () => {
    expect(isAppliedByMover(op('okta', 'o1'))).toBe(true);
    expect(isAppliedByMover(op('scim', 's1'))).toBe(true);
    expect(isAppliedByMover(op('entra-id', 'E5', 'add', 'license'))).toBe(true);
    expect(isAppliedByMover(op('ad', 'L1', 'add', 'license'))).toBe(false);
    expect(isAppliedByMover(op('okta', 'app-1', 'add', 'app'))).toBe(false);
    expect(isAppliedByMover(op('github', 'team-1'))).toBe(false);
    expect(isAppliedByMover(op('all', 'x1'))).toBe(true);
    expect(isAppliedByMover(op('all', 'x2', 'add', 'notification'))).toBe(false);
  });

  it('plans removals before additions and keeps what the connector does not apply apart', () => {
    const delta = {
      toAdd: [op('okta', 'okta-eng'), op('okta', 'app-eng', 'add', 'app'), op('ad', 'ad-eng')],
      toRemove: [op('okta', 'okta-sales', 'remove')],
    };

    expect(moverSystemPlan(delta, 'okta')).toEqual({
      connector: 'okta',
      operations: [
        { type: 'group', action: 'remove', targetId: 'okta-sales' },
        { type: 'group', action: 'add', targetId: 'okta-eng' },
      ],
      applied: { added: ['okta-eng'], removed: ['okta-sales'] },
      notApplied: { added: ['app-eng'], removed: [] },
    });
    expect(moverSystemPlan(delta, 'github')).toEqual({
      connector: null,
      operations: [],
      applied: { added: [], removed: [] },
      notApplied: { added: [], removed: [] },
    });
    expect(moverSystemPlan({ toAdd: [op('github', 'team-1')], toRemove: [] }, 'github')).toEqual(
      expect.objectContaining({ operations: [], notApplied: { added: ['team-1'], removed: [] } }),
    );
  });
});

describe('withoutRequestGrants', () => {
  const removals = [
    op('entra-id', 'g-sales', 'remove'),
    op('entra-id', 'g-finance', 'remove'),
    op('all', 'E3', 'remove', 'license'),
    op('ad', 'CN=Sales', 'remove'),
  ];

  it('keeps the access an active access request also grants, in a system the removal is for', () => {
    const kept = withoutRequestGrants(removals, [
      { system: 'entra-id', type: 'group', nativeId: 'g-sales' },
      { system: 'entra', type: 'license', nativeId: 'E3' },
    ]);

    expect(kept.map((o) => o.targetId)).toEqual(['g-finance', 'CN=Sales']);
  });

  it('still removes an entitlement a request grants in another system or as another type', () => {
    const kept = withoutRequestGrants(removals, [
      { system: 'okta', type: 'group', nativeId: 'g-sales' },
      { system: 'entra-id', type: 'role', nativeId: 'g-finance' },
    ]);

    expect(kept).toEqual(removals);
  });

  it('removes everything when no request grants anything', () => {
    expect(withoutRequestGrants(removals, [])).toEqual(removals);
  });
});
