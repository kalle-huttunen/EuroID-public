/**
 * Which policy operations an access review exclusion takes out of an identity's intent: the
 * revoked entitlement in the reviewed system, named as a policy names it (id, display name, an AD
 * group's DN or first RDN, the group, role or license in the params), never another system's or
 * another kind of entitlement, and never a removal. An account exclusion takes every grant in its
 * system.
 */
import type { ProvisioningOperation } from './policy-engine.service';
import {
  SUPPRESSED_BY_ACCESS_REVIEW,
  exclusionKey,
  suppresses,
  withoutReviewExclusions,
  type ReviewExclusionMatch,
} from './review-exclusion-match';

const op = (over: Partial<ProvisioningOperation>): ProvisioningOperation => ({
  type: 'group',
  action: 'add',
  target: 'entra-id',
  targetId: 'SG-Sales',
  sourcePolicy: 'Sales baseline',
  ...over,
});

const exclusion = (over: Partial<ReviewExclusionMatch>): ReviewExclusionMatch => ({
  id: 'ex-1',
  campaignId: 'camp-1',
  systemKey: 'entraid',
  scope: 'entitlement',
  entitlementType: 'group',
  entitlementName: 'SG-Sales',
  entitlementId: '8d0f6c1e-0000-4000-8000-000000000001',
  ...over,
});

describe('suppresses', () => {
  it.each([
    ['the display name, in any case', op({ targetId: 'sg-sales ' })],
    ['the object id', op({ targetId: '8D0F6C1E-0000-4000-8000-000000000001' })],
    ['the system under another name', op({ target: 'entra' })],
    ['a group named in the params', op({ targetId: 'x', params: { groupName: 'SG-Sales' } })],
    ['an operation on every system', op({ target: 'all' })],
  ])('takes an Entra ID group the review revoked, by %s', (_label, operation) => {
    expect(suppresses(exclusion({}), operation)).toBe(true);
  });

  it.each([
    ['another group', op({ targetId: 'SG-Sales-Leads' })],
    ['the same name in another system', op({ target: 'ad' })],
    ['a license of that name', op({ type: 'license' })],
    ['a removal', op({ action: 'remove' })],
  ])('keeps %s', (_label, operation) => {
    expect(suppresses(exclusion({}), operation)).toBe(false);
  });

  const adGroup = exclusion({
    systemKey: 'ad',
    entitlementName: 'Sales Team',
    entitlementId: 'CN=Sales Team,OU=Groups,DC=corp,DC=example',
  });

  it.each([
    ['its DN, spaced and cased differently', 'cn=Sales Team, ou=Groups, dc=corp, dc=example'],
    ['its first RDN', 'CN=Sales Team'],
    ['its name', 'Sales Team'],
  ])('takes an AD group by %s', (_label, targetId) => {
    expect(suppresses(adGroup, op({ target: 'active-directory', targetId }))).toBe(true);
  });

  it('keeps a group of the same name in another OU', () => {
    const other = 'CN=Sales Team,OU=Archive,DC=corp,DC=example';
    expect(suppresses(adGroup, op({ target: 'ad', targetId: other }))).toBe(false);
  });

  it('takes an Entra ID directory role as a role, by name or by the role in the params', () => {
    const role = exclusion({
      entitlementType: 'directory-role',
      entitlementName: 'Helpdesk Administrator',
      entitlementId: 'dir-role-object-id',
    });
    expect(suppresses(role, op({ type: 'role', targetId: 'Helpdesk Administrator' }))).toBe(true);
    expect(
      suppresses(
        role,
        op({
          type: 'role',
          targetId: '729827e3-9c14-49f7-bb1b-9608f156bbb8',
          params: { roleName: 'Helpdesk Administrator' },
        }),
      ),
    ).toBe(true);
    expect(suppresses(role, op({ type: 'group', targetId: 'Helpdesk Administrator' }))).toBe(false);
  });

  it('takes no operation for an entitlement no policy grants (an administrative unit)', () => {
    const unit = exclusion({ entitlementType: 'administrative-unit', entitlementName: 'SG-Sales' });
    expect(suppresses(unit, op({}))).toBe(false);
  });

  describe('an account exclusion', () => {
    const github = exclusion({
      systemKey: 'github',
      scope: 'account',
      entitlementType: 'account',
      entitlementName: 'Account',
      entitlementId: undefined,
    });

    it('takes every grant in its system', () => {
      expect(suppresses(github, op({ target: 'github', targetId: 'team-a' }))).toBe(true);
      expect(suppresses(github, op({ target: 'github', type: 'attribute', action: 'set' }))).toBe(
        true,
      );
    });

    it('keeps other systems, operations on every system, and removals', () => {
      expect(suppresses(github, op({ target: 'entra-id' }))).toBe(false);
      expect(suppresses(github, op({ target: 'all' }))).toBe(false);
      expect(suppresses(github, op({ target: 'github', action: 'remove' }))).toBe(false);
    });
  });
});

describe('withoutReviewExclusions', () => {
  it('leaves the suppressed operations out and says which exclusion took them', () => {
    const sales = op({});
    const eng = op({ targetId: 'SG-Eng', sourcePolicy: 'Engineering' });
    const result = withoutReviewExclusions([sales, eng], [exclusion({})]);

    expect(result.operations).toEqual([eng]);
    expect(result.suppressed).toEqual([
      {
        ...sales,
        suppressedBy: {
          reason: SUPPRESSED_BY_ACCESS_REVIEW,
          exclusionId: 'ex-1',
          campaignId: 'camp-1',
        },
      },
    ]);
    expect(SUPPRESSED_BY_ACCESS_REVIEW).toBe('Suppressed by access review');
  });

  it('only ever takes operations away', () => {
    const ops = [op({}), op({ action: 'remove' }), op({ targetId: 'SG-Eng' })];
    const result = withoutReviewExclusions(ops, [exclusion({})]);
    expect(result.operations.every((o) => ops.includes(o))).toBe(true);
    expect(result.operations.length + result.suppressed.length).toBe(ops.length);
    expect(result.operations).toContainEqual(op({ action: 'remove' }));
  });

  it('returns the operations as they are without exclusions', () => {
    const ops = [op({})];
    expect(withoutReviewExclusions(ops, [])).toEqual({ operations: ops, suppressed: [] });
  });
});

describe('exclusionKey', () => {
  it('is the id (else the name) for an entitlement and one key for an account', () => {
    expect(
      exclusionKey({ scope: 'entitlement', entitlementId: 'CN=A, DC=x', entitlementName: 'A' }),
    ).toBe('cn=a,dc=x');
    expect(exclusionKey({ scope: 'entitlement', entitlementName: ' SG-Sales ' })).toBe('sg-sales');
    expect(exclusionKey({ scope: 'account', entitlementName: 'Account' })).toBe('*');
  });
});
