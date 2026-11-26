/**
 * Review items for targets whose memberships EuroID cannot read: the item is the account, one
 * per target the identity has an account in by the mover's rule (hasProvisionedAccount), so a
 * campaign over GitHub, ServiceNow or File outbound has something to certify or revoke.
 */
import { accountEntitlements } from './review-account-items';

const target = (sourceName: string, externalId: string) => ({
  sourceName,
  externalId,
  sourceRole: 'target' as const,
});

describe('accountEntitlements', () => {
  it('gives one account item per target without readable memberships the identity has an account in', () => {
    expect(
      accountEntitlements({
        provisioning: [
          { targetSystem: 'github', status: 'SYNCED' },
          { targetSystem: 'file-outbound', status: 'SYNCED', writebackComplete: true },
          { targetSystem: 'servicenow', status: 'SYNCED', grantedBy: 'request' },
        ],
        sources: [
          { sourceName: 'csv-hr', externalId: 'E100', sourceRole: 'primary-hr' },
          target('github', 'github-user-42'),
        ],
      }),
    ).toEqual([
      {
        system: 'github',
        type: 'account',
        name: 'Account',
        accountId: 'github-user-42',
        policyManaged: true,
      },
      { system: 'file-outbound', type: 'account', name: 'Account', policyManaged: true },
      { system: 'servicenow', type: 'account', name: 'Account', policyManaged: false },
    ]);
  });

  it('gives none for targets whose memberships the campaign reads (Entra ID, AD, Okta, SCIM)', () => {
    expect(
      accountEntitlements({
        provisioning: ['entra', 'entra-id', 'ad', 'active-directory', 'okta', 'scim'].map(
          (targetSystem) => ({ targetSystem, status: 'SYNCED' as const }),
        ),
      }),
    ).toEqual([]);
  });

  it('follows the mover rule: provisioned once until a deprovision, never an account not created', () => {
    const systems = accountEntitlements({
      provisioning: [
        // deprovisioned (offboarded, expired, revoked in an earlier review)
        { targetSystem: 'github', status: 'DEPROVISIONED' },
        // a later run failed, the account is still there
        { targetSystem: 'servicenow', status: 'ERROR', provisionedAt: new Date('2026-11-01') },
        // onboarding failed before the target answered with an account
        { targetSystem: 'google-sheets', status: 'ERROR' },
        { targetSystem: 'discord-webhook', status: 'PENDING' },
        // deprovisioned, not synced since
        { targetSystem: 'file-outbound', status: 'SYNCING', provisionedAt: null },
      ],
    }).map((e) => e.system);
    expect(systems).toEqual(['servicenow']);
  });

  it('gives none for an identity without provisioning entries', () => {
    expect(accountEntitlements({})).toEqual([]);
  });
});
