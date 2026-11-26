/**
 * AdClient reads LDAP attributes in the shape ldapts gives them, against a mocked ldapts Client:
 * an attribute with one value as that value (a string, or a Buffer for a binary attribute), one
 * with several values as an array, a requested attribute the entry lacks as []. The client read
 * every attribute as an array and took `[0]`, so a single-valued mail, userPrincipalName,
 * sAMAccountName, userAccountControl, pwdLastSet, cn or name became its first character:
 * reconciliation compared a one-letter email, saw every account enabled, and orphan detection
 * could not match an AD account by its UPN or mail. Untested against a live domain controller.
 */
jest.mock('ldapts', () => ({
  ...jest.requireActual('ldapts'),
  Client: jest.fn(),
}));
jest.mock('@infrastructure/url-validation/ssrf-guard', () => ({
  // AdClient connects to the address the guard answers; these specs need no DNS
  resolveHostForConnect: jest.fn(async (host: string) => ({ address: host })),
}));

import { Client } from 'ldapts';
import { AdClient } from './ad.client';
import { AdService } from './ad.service';
import type { AdConfig } from './ad.interface';

const config: AdConfig = {
  host: 'dc.acme.test',
  rootBaseDn: 'DC=acme,DC=test',
  serviceAccount: 'CN=svc,DC=acme,DC=test',
  password: 'secret',
};
const USER_DN = 'CN=Ada Lovelace,OU=Users,DC=acme,DC=test';

function setup(entries: Array<Record<string, unknown>>) {
  const ldap = {
    bind: jest.fn().mockResolvedValue(undefined),
    unbind: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue({ searchEntries: entries }),
  };
  (Client as unknown as jest.Mock).mockImplementation(() => ldap);
  const client = new AdClient();
  return { client, service: new AdService(client) };
}

describe('AdClient attribute values as ldapts gives them', () => {
  it('reads single-valued user attributes whole', async () => {
    const { client } = setup([
      {
        dn: USER_DN,
        sAMAccountName: 'ada.lovelace',
        mail: 'ada.lovelace@acme.test',
        userPrincipalName: 'ada@acme.test',
        userAccountControl: '514',
        objectGUID: [],
      },
    ]);

    await expect(client.searchUsers(config, 'DC=acme,DC=test')).resolves.toEqual([
      {
        dn: USER_DN,
        sAMAccountName: 'ada.lovelace',
        mail: 'ada.lovelace@acme.test',
        userPrincipalName: 'ada@acme.test',
        userAccountControl: '514',
      },
    ]);
  });

  it('takes the first value of a multi-valued attribute and nothing of an absent one', async () => {
    const { client } = setup([
      {
        dn: USER_DN,
        sAMAccountName: [],
        mail: ['ada.lovelace@acme.test', 'ada@old.acme.test'],
        userPrincipalName: [],
        userAccountControl: '512',
      },
    ]);

    const [entry] = await client.searchUsers(config, 'DC=acme,DC=test');

    expect(entry.mail).toBe('ada.lovelace@acme.test');
    expect(entry.sAMAccountName).toBeUndefined();
    expect(entry.userPrincipalName).toBeUndefined();
  });

  it('gives reconciliation the whole UPN and the real enabled state (AdService)', async () => {
    const { service } = setup([
      {
        dn: USER_DN,
        mail: 'ada.lovelace@acme.test',
        userPrincipalName: 'ada@acme.test',
        userAccountControl: '514',
      },
    ]);

    await expect(service.getUserByEmail(config, 'ada@acme.test')).resolves.toEqual({
      id: USER_DN,
      userPrincipalName: 'ada@acme.test',
      mail: 'ada.lovelace@acme.test',
      displayName: undefined,
      accountEnabled: false,
    });
  });

  // Hunt 2026-11-25 (01 F4): enabled was `uac !== 514 && uac !== 546`, so a disabled account
  // with another flag (66050: disabled and password never expires, common for service accounts)
  // read as enabled in reconciliation and orphan lists. ACCOUNTDISABLE is bit 0x2.
  it.each([
    ['66050', false],
    ['514', false],
    ['546', false],
    ['66048', true],
    ['512', true],
  ])(
    'reads userAccountControl %s as enabled=%s in listUsers and getUserByEmail',
    async (uac, enabled) => {
      const { service } = setup([
        {
          dn: USER_DN,
          mail: 'ada@acme.test',
          userPrincipalName: 'ada@acme.test',
          userAccountControl: uac,
        },
      ]);

      const [listed] = await service.listUsers(config);
      const found = await service.getUserByEmail(config, 'ada@acme.test');

      expect(listed.accountEnabled).toBe(enabled);
      expect(found?.accountEnabled).toBe(enabled);
    },
  );

  it('reads pwdLastSet and userAccountControl whole for the credential state', async () => {
    const { client } = setup([
      { dn: USER_DN, pwdLastSet: '133795872000000000', userAccountControl: '66048' },
    ]);

    await expect(client.getCredentialState(config, USER_DN)).resolves.toEqual({
      pwdLastSet: '133795872000000000',
      userAccountControl: '66048',
    });
  });

  it('reads group names whole and keeps a single objectSid Buffer', async () => {
    const sid = Buffer.from('010500000000000515000000', 'hex');
    const { client } = setup([
      { dn: 'CN=Finance,OU=Groups,DC=acme,DC=test', cn: 'Finance', name: [], objectSid: sid },
    ]);

    await expect(client.searchGroups(config, 'DC=acme,DC=test')).resolves.toEqual([
      {
        dn: 'CN=Finance,OU=Groups,DC=acme,DC=test',
        cn: 'Finance',
        name: 'Finance',
        objectSid: sid,
      },
    ]);
  });

  // Hunt 2026-11-25 (r2-01 N10): disableUser replaced userAccountControl with 514, which dropped
  // flags such as DONT_EXPIRE_PASSWORD (0x10000) that a later enable could not bring back. It
  // now sets ACCOUNTDISABLE on the value the entry has, as enableUser clears it.
  it.each([
    ['66048', '66050'],
    ['512', '514'],
    [undefined, '514'],
  ])('disables an account with userAccountControl %s by writing %s', async (current, written) => {
    const modify = jest.fn().mockResolvedValue(undefined);
    const ldap = {
      bind: jest.fn().mockResolvedValue(undefined),
      unbind: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue({
        searchEntries: [{ dn: USER_DN, ...(current ? { userAccountControl: current } : {}) }],
      }),
      modify,
    };
    (Client as unknown as jest.Mock).mockImplementation(() => ldap);

    await new AdClient().disableUser(config, USER_DN);

    const change = modify.mock.calls[0][1] as { modification: { type: string; values: string[] } };
    expect(change.modification.type).toBe('userAccountControl');
    expect(change.modification.values).toEqual([written]);
  });

  // Hunt 2026-11-25 (01 F8): when the add succeeded and the password modify failed (no LDAPS, a
  // password the policy refuses), the entry stayed without a password, and the retry found it
  // (LDAP 68, or the own-account lookup) and answered success. The entry is deleted again.
  describe('addUser when setting the password fails', () => {
    const attributes = { objectClass: ['user'], userPrincipalName: 'ada@acme.test' } as never;
    function ldapWith(modifyError: Error, delError?: Error) {
      const ldap = {
        bind: jest.fn().mockResolvedValue(undefined),
        unbind: jest.fn().mockResolvedValue(undefined),
        add: jest.fn().mockResolvedValue(undefined),
        modify: jest.fn().mockRejectedValue(modifyError),
        del: delError
          ? jest.fn().mockRejectedValue(delError)
          : jest.fn().mockResolvedValue(undefined),
      };
      (Client as unknown as jest.Mock).mockImplementation(() => ldap);
      return ldap;
    }

    it('deletes the entry it created and fails with the password error', async () => {
      const refused = Object.assign(new Error('0000052D: password policy'), { code: 19 });
      const ldap = ldapWith(refused);

      await expect(new AdClient().addUser(config, USER_DN, attributes, 'P@ss')).rejects.toBe(
        refused,
      );
      expect(ldap.del).toHaveBeenCalledWith(USER_DN);
    });

    it('still fails with the password error when the delete fails too', async () => {
      const refused = Object.assign(new Error('unwillingToPerform'), { code: 53 });
      const ldap = ldapWith(refused, new Error('connection reset'));

      await expect(new AdClient().addUser(config, USER_DN, attributes, 'P@ss')).rejects.toBe(
        refused,
      );
      expect(ldap.unbind).toHaveBeenCalled();
    });
  });
});
