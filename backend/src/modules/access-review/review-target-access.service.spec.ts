/**
 * Access reviews in Entra ID, AD, Okta and SCIM: gathering records the account each membership
 * was found on, and revocation removes the membership of exactly that account, reporting
 * removed / already gone / manual action honestly. Connector services are mocked; the vendor
 * calls they make are covered by the connector specs.
 */
import { HttpStatus, Logger } from '@nestjs/common';
import {
  ReviewTargetAccessService,
  firstRdnValue,
  type ReviewTargets,
} from './review-target-access.service';
import type { AdConfig } from '../connectors/ad-connector/ad.interface';
import type { SCIMConnectorConfig } from '../connectors/scim-connector/scim.interface';
import type { ConfigActivities } from '../../activities/config.activities';
import type { EntraService } from '../connectors/entra-connector/entra.service';
import type { AdService } from '../connectors/ad-connector/ad.service';
import type { OktaService } from '../connectors/okta-connector/okta.service';
import type { SCIMService } from '../connectors/scim-connector/scim.service';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';

const TENANT = 'tenant-a';
const EMAIL = 'ada@acme.test';
const adConfig: AdConfig = {
  host: 'dc.acme.test',
  rootBaseDn: 'DC=acme,DC=test',
  serviceAccount: 's',
  password: 'p',
};
const scimConfig: SCIMConnectorConfig = {
  baseUrl: 'https://scim.acme.test/v2',
  authType: 'bearer',
};
const USER_DN = 'CN=Ada Lovelace,OU=Users,DC=acme,DC=test';
const GROUP_DN = 'CN=Finance\\, Ledger,OU=Groups,DC=acme,DC=test';

function setup() {
  const config = {
    getActiveTargetSystems: jest.fn().mockResolvedValue(['entra', 'ad', 'okta', 'scim']),
    getConnectorConfig: jest.fn(
      async (id: string): Promise<Record<string, unknown> | null> =>
        id === 'ad' ? { ...adConfig } : id === 'scim' ? { ...scimConfig } : null,
    ),
  };
  const entra = {
    isConfiguredForTenant: jest.fn().mockResolvedValue(true),
    checkUserExists: jest.fn().mockResolvedValue(null),
    getUserByEmail: jest.fn().mockResolvedValue(null),
    listUserMemberships: jest.fn().mockResolvedValue([]),
    removeGroupMember: jest.fn().mockResolvedValue('removed'),
  };
  const ad = {
    getUserGroupDns: jest.fn().mockResolvedValue(null),
    getUserByEmail: jest.fn().mockResolvedValue(null),
    removeGroupMember: jest.fn().mockResolvedValue('removed'),
  };
  const okta = {
    listUserGroups: jest.fn().mockResolvedValue(null),
    findUserIdByLogin: jest.fn().mockResolvedValue(null),
    removeGroupMember: jest.fn().mockResolvedValue(undefined),
  };
  const scim = {
    getUserGroups: jest.fn().mockResolvedValue(null),
    findUserIdByIdentifiers: jest.fn().mockResolvedValue(null),
    removeGroupMember: jest.fn().mockResolvedValue('removed'),
  };
  const service = new ReviewTargetAccessService(
    config as unknown as ConfigActivities,
    entra as unknown as EntraService,
    ad as unknown as AdService,
    okta as unknown as OktaService,
    scim as unknown as SCIMService,
  );
  return { service, config, entra, ad, okta, scim };
}

/** HTTP status of the rejection (ConnectorException), or undefined when it resolved. */
async function rejectionStatus(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
  } catch (e: unknown) {
    return (e as ConnectorException).getStatus();
  }
  return undefined;
}

const onlyTargets = (t: Partial<ReviewTargets>): ReviewTargets => ({
  entra: false,
  okta: false,
  ...t,
});

describe('ReviewTargetAccessService.loadTargets', () => {
  it('reviews the canvas targets with their configs, and Entra ID when the tenant has an Entra config', async () => {
    const { service, config } = setup();
    await expect(service.loadTargets(TENANT)).resolves.toEqual({
      entra: true,
      ad: adConfig,
      scim: scimConfig,
      okta: true,
    });
    expect(config.getConnectorConfig).toHaveBeenCalledWith('ad', TENANT);
  });

  it('leaves out a target that is not on the canvas or has no usable config', async () => {
    const { service, config, entra } = setup();
    config.getActiveTargetSystems.mockResolvedValue(['ad']);
    config.getConnectorConfig.mockResolvedValue({ rootBaseDn: 'DC=x' }); // no host
    entra.isConfiguredForTenant.mockResolvedValue(false);
    await expect(service.loadTargets(TENANT)).resolves.toEqual({ entra: false, okta: false });
  });
});

describe('ReviewTargetAccessService.gather', () => {
  it('Entra ID: groups and directory roles of the written-back account, told apart', async () => {
    const { service, entra } = setup();
    entra.listUserMemberships.mockResolvedValue([
      { id: 'g-1', displayName: 'Finance', odataType: '#microsoft.graph.group' },
      {
        id: 'r-1',
        displayName: 'Helpdesk Administrator',
        odataType: '#microsoft.graph.directoryRole',
      },
    ]);
    const result = await service.gather(
      { email: EMAIL, sources: [{ sourceName: 'entra-id', externalId: 'obj-1' }] },
      onlyTargets({ entra: true }),
    );
    expect(entra.checkUserExists).not.toHaveBeenCalled();
    expect(entra.listUserMemberships).toHaveBeenCalledWith('obj-1');
    expect(result).toEqual([
      expect.objectContaining({
        system: 'entra-id',
        type: 'group',
        nativeId: 'g-1',
        name: 'Finance',
        accountId: 'obj-1',
      }),
      expect.objectContaining({
        system: 'entra-id',
        type: 'directory-role',
        nativeId: 'r-1',
        accountId: 'obj-1',
      }),
    ]);
  });

  it('Entra ID: without a written-back id, the email as UPN (as before)', async () => {
    const { service, entra } = setup();
    entra.checkUserExists.mockResolvedValue('obj-2');
    entra.listUserMemberships.mockResolvedValue([{ id: 'g-1', displayName: 'Finance' }]);
    const [ent] = await service.gather({ email: EMAIL }, onlyTargets({ entra: true }));
    expect(entra.checkUserExists).toHaveBeenCalledWith(EMAIL);
    expect(ent).toEqual(expect.objectContaining({ type: 'group', accountId: 'obj-2' }));
  });

  it('AD: direct groups of the written-back DN, named by their CN', async () => {
    const { service, ad } = setup();
    ad.getUserGroupDns.mockResolvedValue([GROUP_DN]);
    const result = await service.gather(
      { email: EMAIL, sources: [{ sourceName: 'ad', externalId: USER_DN }] },
      onlyTargets({ ad: adConfig }),
    );
    expect(ad.getUserByEmail).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({
        system: 'ad',
        type: 'group',
        name: 'Finance, Ledger',
        nativeId: GROUP_DN,
        accountId: USER_DN,
      }),
    ]);
  });

  it('AD: a written-back DN that no longer exists falls back to the mail/UPN search', async () => {
    const { service, ad } = setup();
    const movedDn = 'CN=Ada Lovelace,OU=Moved,DC=acme,DC=test';
    ad.getUserGroupDns.mockImplementation(async (_c: unknown, dn: string) =>
      dn === movedDn ? [GROUP_DN] : null,
    );
    ad.getUserByEmail.mockResolvedValue({ id: movedDn });
    const [ent] = await service.gather(
      { email: EMAIL, sources: [{ sourceName: 'ad', externalId: USER_DN }] },
      onlyTargets({ ad: adConfig }),
    );
    expect(ad.getUserByEmail).toHaveBeenCalledWith(adConfig, EMAIL);
    expect(ent.accountId).toBe(movedDn);
  });

  it('Okta: skips the built-in Everyone group and marks app groups', async () => {
    const { service, okta } = setup();
    okta.listUserGroups.mockResolvedValue([
      { id: '00g1', type: 'OKTA_GROUP', profile: { name: 'Sales' } },
      { id: '00g2', type: 'APP_GROUP', profile: { name: 'AD: Finance' } },
      { id: '00g3', type: 'BUILT_IN', profile: { name: 'Everyone' } },
    ]);
    const result = await service.gather(
      { email: EMAIL, sources: [{ sourceName: 'okta', externalId: '00u1' }] },
      onlyTargets({ okta: true }),
    );
    expect(result.map((e) => [e.nativeId, e.type, e.accountId])).toEqual([
      ['00g1', 'group', '00u1'],
      ['00g2', 'app-group', '00u1'],
    ]);
  });

  it('Okta: without a written-back id, the login (provisioning sets login = email)', async () => {
    const { service, okta } = setup();
    okta.findUserIdByLogin.mockResolvedValue('00u9');
    okta.listUserGroups.mockResolvedValue([
      { id: '00g1', type: 'OKTA_GROUP', profile: { name: 'Sales' } },
    ]);
    const [ent] = await service.gather({ email: EMAIL }, onlyTargets({ okta: true }));
    expect(okta.findUserIdByLogin).toHaveBeenCalledWith(EMAIL);
    expect(ent.accountId).toBe('00u9');
  });

  it('SCIM: direct and nested memberships from the user, found by UPN when no id is stored', async () => {
    const { service, scim } = setup();
    scim.findUserIdByIdentifiers.mockResolvedValue('scim-1');
    scim.getUserGroups.mockImplementation(async (_c: unknown, id: string) =>
      id === 'scim-1'
        ? [
            { value: 'grp-1', display: 'Engineering', type: 'direct' },
            { value: 'grp-2', display: 'All staff', type: 'indirect' },
          ]
        : null,
    );
    const result = await service.gather(
      { email: EMAIL, userPrincipalName: 'ada@corp.test' },
      onlyTargets({ scim: scimConfig }),
    );
    expect(scim.findUserIdByIdentifiers).toHaveBeenCalledWith(scimConfig, {
      userNames: ['ada@corp.test', EMAIL],
      emails: [EMAIL],
    });
    expect(result.map((e) => [e.nativeId, e.type, e.accountId])).toEqual([
      ['grp-1', 'group', 'scim-1'],
      ['grp-2', 'indirect-group', 'scim-1'],
    ]);
  });

  it("SCIM: a target that does not return users' groups yields no items", async () => {
    const { service, scim } = setup();
    scim.getUserGroups.mockResolvedValue(undefined);
    await expect(
      service.gather(
        { email: EMAIL, sources: [{ sourceName: 'scim', externalId: 'scim-1' }] },
        onlyTargets({ scim: scimConfig }),
      ),
    ).resolves.toEqual([]);
  });

  it('skips a failing target with a masked warning and still gathers the others', async () => {
    const { service, ad, okta } = setup();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    ad.getUserByEmail.mockRejectedValue(new Error('LDAP down'));
    okta.findUserIdByLogin.mockResolvedValue('00u1');
    okta.listUserGroups.mockResolvedValue([
      { id: '00g1', type: 'OKTA_GROUP', profile: { name: 'Sales' } },
    ]);
    const result = await service.gather(
      { email: EMAIL },
      onlyTargets({ ad: adConfig, okta: true }),
    );
    expect(result).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('LDAP down'));
    expect(warn.mock.calls.join(' ')).not.toContain(EMAIL);
    warn.mockRestore();
  });
});

describe('ReviewTargetAccessService.revoke', () => {
  const holder = { email: EMAIL };

  describe('Entra ID', () => {
    it('removes the group membership of the recorded account', async () => {
      const { service, entra } = setup();
      entra.listUserMemberships.mockResolvedValue([
        { id: 'g-1', odataType: '#microsoft.graph.group' },
      ]);
      await expect(
        service.revoke('entra', { nativeId: 'g-1', accountId: 'obj-1' }, holder, TENANT),
      ).resolves.toEqual({ outcome: 'removed', detail: 'removed from group' });
      expect(entra.removeGroupMember).toHaveBeenCalledWith('obj-1', 'g-1');
    });

    it('is already gone when the account is no longer a member, without a delete', async () => {
      const { service, entra } = setup();
      entra.listUserMemberships.mockResolvedValue([{ id: 'g-other' }]);
      await expect(
        service.revoke('entra', { nativeId: 'g-1', accountId: 'obj-1' }, holder, TENANT),
      ).resolves.toEqual(expect.objectContaining({ outcome: 'already-gone' }));
      expect(entra.removeGroupMember).not.toHaveBeenCalled();
    });

    it('a directory role reviewed as a group (pre-patch items) needs manual action, never "already gone"', async () => {
      const { service, entra } = setup();
      entra.listUserMemberships.mockResolvedValue([
        { id: 'r-1', odataType: '#microsoft.graph.directoryRole' },
      ]);
      await expect(
        service.revoke('entra', { nativeId: 'r-1', accountId: 'obj-1' }, holder, TENANT),
      ).resolves.toEqual(expect.objectContaining({ outcome: 'manual-action-needed' }));
      expect(entra.removeGroupMember).not.toHaveBeenCalled();
    });

    it('an item without a recorded account finds it by the email; none found fails for an admin', async () => {
      const { service, entra } = setup();
      expect(
        await rejectionStatus(service.revoke('entra', { nativeId: 'g-1' }, holder, TENANT)),
      ).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(entra.checkUserExists).toHaveBeenCalledWith(EMAIL);
      expect(entra.getUserByEmail).toHaveBeenCalledWith(EMAIL);
    });

    it('fails when Entra ID is not configured', async () => {
      const { service, entra } = setup();
      entra.isConfiguredForTenant.mockResolvedValue(false);
      await expect(
        service.revoke('entra', { nativeId: 'g-1', accountId: 'obj-1' }, holder, TENANT),
      ).rejects.toBeInstanceOf(ConnectorException);
    });
  });

  describe('Active Directory', () => {
    it('removes the recorded DN from the group (DNs compared case- and space-insensitively)', async () => {
      const { service, ad } = setup();
      ad.getUserGroupDns.mockResolvedValue([GROUP_DN.toUpperCase().replace(/,/g, ', ')]);
      await expect(
        service.revoke('ad', { nativeId: GROUP_DN, accountId: USER_DN }, holder, TENANT),
      ).resolves.toEqual({ outcome: 'removed', detail: 'removed from group' });
      expect(ad.removeGroupMember).toHaveBeenCalledWith(adConfig, USER_DN, GROUP_DN);
    });

    it('is already gone when the user is no longer in the group, without a modify', async () => {
      const { service, ad } = setup();
      ad.getUserGroupDns.mockResolvedValue([]);
      await expect(
        service.revoke('ad', { nativeId: GROUP_DN, accountId: USER_DN }, holder, TENANT),
      ).resolves.toEqual(expect.objectContaining({ outcome: 'already-gone' }));
      expect(ad.removeGroupMember).not.toHaveBeenCalled();
    });

    it('the directory answering "not a member" at removal is already gone', async () => {
      const { service, ad } = setup();
      ad.getUserGroupDns.mockResolvedValue([GROUP_DN]);
      ad.removeGroupMember.mockResolvedValue('not-member');
      await expect(
        service.revoke('ad', { nativeId: GROUP_DN, accountId: USER_DN }, holder, TENANT),
      ).resolves.toEqual(expect.objectContaining({ outcome: 'already-gone' }));
    });

    it('a recorded DN that is gone with no account by email fails for an admin to check', async () => {
      const { service } = setup();
      expect(
        await rejectionStatus(
          service.revoke('ad', { nativeId: GROUP_DN, accountId: USER_DN }, holder, TENANT),
        ),
      ).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    });

    it('fails without the AD connector config on the canvas', async () => {
      const { service, config } = setup();
      config.getConnectorConfig.mockResolvedValue(null);
      await expect(
        service.revoke('ad', { nativeId: GROUP_DN, accountId: USER_DN }, holder, TENANT),
      ).rejects.toThrow('AD connector config not found on the canvas');
    });
  });

  describe('Okta', () => {
    it('removes an OKTA_GROUP membership', async () => {
      const { service, okta } = setup();
      okta.listUserGroups.mockResolvedValue([
        { id: '00g1', type: 'OKTA_GROUP', profile: { name: 'Sales' } },
      ]);
      await expect(
        service.revoke('okta', { nativeId: '00g1', accountId: '00u1' }, holder, TENANT),
      ).resolves.toEqual({ outcome: 'removed', detail: 'removed from group' });
      expect(okta.removeGroupMember).toHaveBeenCalledWith('00g1', '00u1');
    });

    it('an APP_GROUP membership needs manual action and is not touched', async () => {
      const { service, okta } = setup();
      okta.listUserGroups.mockResolvedValue([
        { id: '00g2', type: 'APP_GROUP', profile: { name: 'AD: Finance' } },
      ]);
      await expect(
        service.revoke('okta', { nativeId: '00g2', accountId: '00u1' }, holder, TENANT),
      ).resolves.toEqual(expect.objectContaining({ outcome: 'manual-action-needed' }));
      expect(okta.removeGroupMember).not.toHaveBeenCalled();
    });

    it('a deleted user or a non-member is already gone', async () => {
      const { service, okta } = setup();
      await expect(
        service.revoke('okta', { nativeId: '00g1', accountId: '00u1' }, holder, TENANT),
      ).resolves.toEqual({ outcome: 'already-gone', detail: 'no such Okta user any more' });
      okta.listUserGroups.mockResolvedValue([]);
      await expect(
        service.revoke('okta', { nativeId: '00g1', accountId: '00u1' }, holder, TENANT),
      ).resolves.toEqual(expect.objectContaining({ outcome: 'already-gone' }));
      expect(okta.removeGroupMember).not.toHaveBeenCalled();
    });
  });

  describe('SCIM', () => {
    it('removes a direct membership', async () => {
      const { service, scim } = setup();
      scim.getUserGroups.mockResolvedValue([{ value: 'grp-1', type: 'direct' }]);
      await expect(
        service.revoke('scim', { nativeId: 'grp-1', accountId: 'scim-1' }, holder, TENANT),
      ).resolves.toEqual({ outcome: 'removed', detail: 'removed from group' });
      expect(scim.removeGroupMember).toHaveBeenCalledWith(scimConfig, 'grp-1', 'scim-1');
    });

    it('a nested membership needs manual action and is not touched', async () => {
      const { service, scim } = setup();
      scim.getUserGroups.mockResolvedValue([{ value: 'grp-1', type: 'indirect' }]);
      await expect(
        service.revoke('scim', { nativeId: 'grp-1', accountId: 'scim-1' }, holder, TENANT),
      ).resolves.toEqual(expect.objectContaining({ outcome: 'manual-action-needed' }));
      expect(scim.removeGroupMember).not.toHaveBeenCalled();
    });

    it('without a groups attribute it patches the group; "no such member" is already gone', async () => {
      const { service, scim } = setup();
      scim.getUserGroups.mockResolvedValue(undefined);
      scim.removeGroupMember.mockResolvedValue('not-member');
      await expect(
        service.revoke('scim', { nativeId: 'grp-1', accountId: 'scim-1' }, holder, TENANT),
      ).resolves.toEqual(expect.objectContaining({ outcome: 'already-gone' }));
      expect(scim.removeGroupMember).toHaveBeenCalled();
    });

    it('fails without a recorded account rather than guessing one', async () => {
      const { service, scim } = setup();
      expect(
        await rejectionStatus(service.revoke('scim', { nativeId: 'grp-1' }, holder, TENANT)),
      ).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(scim.removeGroupMember).not.toHaveBeenCalled();
    });
  });
});

describe('firstRdnValue', () => {
  it('reads the CN with escaped commas', () => {
    expect(firstRdnValue(GROUP_DN)).toBe('Finance, Ledger');
    expect(firstRdnValue('not a dn')).toBe('not a dn');
  });
});
