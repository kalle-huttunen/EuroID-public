import { policyTimeConstraint, targetOperations } from './onboarding-target-operations';

const op = (target: string, type: string, durationDays?: number) => ({
  target,
  type,
  action: 'add',
  targetId: `${target}-${type}`,
  ...(durationDays !== undefined ? { timeConstraint: { durationDays } } : {}),
});

describe('targetOperations', () => {
  const ops = [
    op('entra-id', 'group'),
    op('entra', 'role'),
    op('all', 'license'),
    op('all', 'app'),
    op('active-directory', 'group'),
    op('ad', 'role'),
    op('github', 'team'),
    op('github-id', 'team'),
    op('okta', 'group'),
  ];

  it("gives Entra ID its groups, directory roles and licenses, its own and 'all'", () => {
    expect(targetOperations(ops, 'entra').map((o) => o.targetId)).toEqual([
      'entra-id-group',
      'entra-role',
      'all-license',
    ]);
  });

  it('gives AD its groups and licenses, never a directory role', () => {
    expect(targetOperations(ops, 'ad').map((o) => o.targetId)).toEqual([
      'all-license',
      'active-directory-group',
    ]);
  });

  it("gives any other system every operation named for it, for '<system>-id' or 'all'", () => {
    expect(targetOperations(ops, 'github').map((o) => o.targetId)).toEqual([
      'all-license',
      'all-app',
      'github-team',
      'github-id-team',
    ]);
  });
});

describe('policyTimeConstraint', () => {
  const now = new Date('2026-11-25T12:00:00.000Z');

  it('ends the access after the shortest positive durationDays, granted by policy', () => {
    expect(
      policyTimeConstraint(
        [op('all', 'group', 30), op('all', 'group', 7), op('all', 'group')],
        now,
      ),
    ).toEqual({ expiresAt: new Date('2026-12-02T12:00:00.000Z'), grantedBy: 'policy' });
  });

  it('is undefined when no operation limits the access', () => {
    expect(policyTimeConstraint([op('all', 'group'), op('all', 'group', 0)], now)).toBeUndefined();
    expect(policyTimeConstraint([], now)).toBeUndefined();
  });
});
