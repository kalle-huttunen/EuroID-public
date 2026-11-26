/**
 * Which revoked review entitlements EuroID removes through a connector, and which it records
 * as manual action: a membership kind EuroID cannot remove must never be reported as revoked.
 */
import { routeRevocation, summarizeRevocations } from './review-revocation';

describe('routeRevocation', () => {
  it.each([
    ['entra-id', 'group', 'entra'],
    ['entra', 'Group', 'entra'], // items from the pre-patch gatherer and legacy spelling
    ['ad', 'group', 'ad'],
    ['active-directory', 'group', 'ad'],
    ['okta', 'group', 'okta'],
    ['scim', 'group', 'scim'],
  ])('removes a %s %s membership through %s', (system, type, connector) => {
    expect(routeRevocation({ system, type })).toEqual({ connector });
  });

  it.each([
    ['entra-id', 'directory-role', /directory role/],
    ['entra-id', 'administrative-unit', /administrative unit/],
    ['okta', 'app-group', /APP_GROUP/],
    ['okta', 'other-group', /OKTA_GROUP/],
    ['scim', 'indirect-group', /Nested membership/],
    ['euroid-scim', 'license', /SCIM token scope/],
    ['euroid-admin', 'group', /admin role/],
  ])('records %s %s as manual action with what to do', (system, type, reason) => {
    const route = routeRevocation({ system, type });
    expect(route).toEqual({ manual: expect.stringMatching(reason) });
  });

  it('records any other system or kind as manual action naming both', () => {
    expect(routeRevocation({ system: 'github', type: 'team' })).toEqual({
      manual: expect.stringContaining('"team" access in "github"'),
    });
    expect(routeRevocation({ system: 'ad', type: 'license' })).toEqual({
      manual: expect.stringContaining('"license" access in "ad"'),
    });
  });

  it.each(['github', 'servicenow', 'file-outbound', 'custom-crm'])(
    'removes an account item in %s as an account in runs that revoke accounts',
    (system) => {
      expect(routeRevocation({ system, type: 'account' }, { accounts: true })).toEqual({
        account: true,
      });
    },
  );

  it('records an account item as manual action in runs from before account revocation', () => {
    expect(routeRevocation({ system: 'github', type: 'account' })).toEqual({
      manual: expect.stringContaining('"account" access in "github"'),
    });
  });

  it('never removes an account in a target whose memberships are reviewed', () => {
    // Entra ID, AD, Okta and SCIM are reviewed per membership: an account item there is not
    // generated, and one found is not a reason to delete the user
    for (const system of ['entra-id', 'ad', 'okta', 'scim']) {
      expect(routeRevocation({ system, type: 'account' }, { accounts: true })).toEqual({
        manual: expect.any(String),
      });
    }
  });
});

describe('summarizeRevocations', () => {
  it('counts each outcome over every entitlement', () => {
    expect(
      summarizeRevocations([
        {
          entitlements: [
            { revocation: { outcome: 'removed' } },
            { revocation: { outcome: 'failed' } },
          ],
        },
        { entitlements: [{ revocation: { outcome: 'already-gone' } }] },
        { entitlements: [{ revocation: { outcome: 'manual-action-needed' } }, {}] },
        { entitlements: [{ revocation: { outcome: 'removed' } }] },
      ]),
    ).toEqual({ removed: 2, alreadyGone: 1, manualActionNeeded: 1, failed: 1 });
  });

  it('is null when nothing was revoked, so a campaign without revocations shows no counts', () => {
    expect(summarizeRevocations([{ entitlements: [{}] }, {}])).toBeNull();
  });
});
