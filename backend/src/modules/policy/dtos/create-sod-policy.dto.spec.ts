import { CreateSodPolicySchema } from './create-sod-policy.dto';

const policy = (
  conflictingEntitlements: Array<{ system: string; type: string; targetId: string }>,
) => ({
  name: 'Payments vs approvals',
  conflictingEntitlements,
});

const messagesOf = (body: unknown) => {
  const result = CreateSodPolicySchema.safeParse(body);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('CreateSodPolicySchema', () => {
  it('accepts distinct entitlements', () => {
    expect(
      messagesOf(
        policy([
          { system: 'entra-id', type: 'group', targetId: 'Payables' },
          { system: 'entra-id', type: 'group', targetId: 'Approvers' },
        ]),
      ),
    ).toEqual([]);
  });

  it('refuses an entitlement listed twice, naming both entries', () => {
    expect(
      messagesOf(
        policy([
          { system: 'entra-id', type: 'group', targetId: 'Payables' },
          { system: 'entra-id', type: 'group', targetId: 'Approvers' },
          { system: 'entra-id', type: 'group', targetId: 'Payables' },
        ]),
      ),
    ).toEqual([
      'conflictingEntitlements.2: repeats conflictingEntitlements.0 (same system, type and id). ' +
        'List each entitlement once: a policy that names one entitlement twice matches anyone who holds it.',
    ]);
  });

  it('compares system and type as the check does: case-insensitively, a directory role as `role`', () => {
    const issues = messagesOf(
      policy([
        { system: 'Entra-ID', type: 'DirectoryRole', targetId: 'role-1' },
        { system: 'entra-id', type: 'role', targetId: 'role-1' },
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^conflictingEntitlements\.1: repeats conflictingEntitlements\.0 /);
  });

  it('compares systems as the check does: `entra` is entra-id, `active-directory` is ad', () => {
    const issues = messagesOf(
      policy([
        { system: 'entra', type: 'group', targetId: 'Payables' },
        { system: 'ad', type: 'group', targetId: 'Payables' },
        { system: 'entra-id', type: 'group', targetId: 'Payables' },
        { system: 'Active-Directory', type: 'group', targetId: 'Payables' },
      ]),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^conflictingEntitlements\.2: repeats conflictingEntitlements\.0 /);
    expect(issues[1]).toMatch(/^conflictingEntitlements\.3: repeats conflictingEntitlements\.1 /);
  });

  it('keeps ids that differ only in case apart (ids are compared exactly)', () => {
    expect(
      messagesOf(
        policy([
          { system: 'entra-id', type: 'group', targetId: 'payables' },
          { system: 'entra-id', type: 'group', targetId: 'Payables' },
        ]),
      ),
    ).toEqual([]);
  });
});
