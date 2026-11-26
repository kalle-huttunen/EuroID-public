/**
 * The access graph's key of an entitlement (hunt 06 F3): the catalog is unique on tenant, system
 * and native id, so the graph keys an entitlement by its system and native id. A native id alone
 * ("admin", a numeric group id) can name entitlements in two systems.
 */
import { EntitlementNodeIdSchema, entitlementNodeId } from './entitlement-node-id';

describe('entitlementNodeId', () => {
  it('keys an entitlement by its system, as the catalog names it, and its id there', () => {
    expect(entitlementNodeId('ad', 'admin')).toBe('ad::admin');
    expect(entitlementNodeId('okta', 'admin')).toBe('okta::admin');
    // A rule or a provisioning event may name Entra ID or AD otherwise
    expect(entitlementNodeId('entra', 'grp-1')).toBe('entra-id::grp-1');
    expect(entitlementNodeId('active-directory', 'admin')).toBe('ad::admin');
  });

  it('accepts a key in the API and refuses a bare native id, naming the form', () => {
    expect(EntitlementNodeIdSchema.parse('entra-id::grp-1')).toBe('entra-id::grp-1');
    expect(EntitlementNodeIdSchema.parse('ad::CN=Admins,OU=Groups')).toBe(
      'ad::CN=Admins,OU=Groups',
    );
    const refused = EntitlementNodeIdSchema.safeParse('grp-1');
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0].message).toBe(
      'must be <system>::<id in that system>, as the graph answers it, e.g. entra-id::<group object id>',
    );
    expect(EntitlementNodeIdSchema.safeParse('::grp-1').success).toBe(false);
    expect(EntitlementNodeIdSchema.safeParse('ad::').success).toBe(false);
  });
});
