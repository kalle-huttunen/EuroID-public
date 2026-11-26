/**
 * AD group membership for access reviews, against a mocked ldapts Client: memberOf of a DN
 * (null when the DN no longer exists) and a member removal that tells "removed" from the
 * directory's "not a member" answers (OpenLDAP noSuchAttribute, AD 00000561). Untested against
 * a live domain controller.
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
const GROUP_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';

/** An LDAP result error as ldapts raises it: a code and the server's diagnostic message. */
const ldapError = (code: number, message: string) =>
  Object.assign(new Error(`${message} Code: 0x${code.toString(16)}`), { code });

function setup() {
  const ldap = {
    bind: jest.fn().mockResolvedValue(undefined),
    unbind: jest.fn().mockResolvedValue(undefined),
    search: jest.fn(),
    modify: jest.fn().mockResolvedValue(undefined),
  };
  (Client as unknown as jest.Mock).mockImplementation(() => ldap);
  const client = new AdClient();
  return { client, service: new AdService(client), ldap };
}

describe('AdService.getUserGroupDns', () => {
  it("reads the DN's memberOf with a base search", async () => {
    const { service, ldap } = setup();
    ldap.search.mockResolvedValue({
      searchEntries: [{ dn: USER_DN, memberOf: [GROUP_DN, 'CN=B,DC=x'] }],
    });
    await expect(service.getUserGroupDns(config, USER_DN)).resolves.toEqual([
      GROUP_DN,
      'CN=B,DC=x',
    ]);
    expect(ldap.search).toHaveBeenCalledWith(
      USER_DN,
      expect.objectContaining({ scope: 'base', attributes: ['memberOf'] }),
    );
    expect(ldap.unbind).toHaveBeenCalled();
  });

  it('reads a single memberOf value and an entry without groups', async () => {
    const { service, ldap } = setup();
    ldap.search.mockResolvedValueOnce({ searchEntries: [{ dn: USER_DN, memberOf: GROUP_DN }] });
    await expect(service.getUserGroupDns(config, USER_DN)).resolves.toEqual([GROUP_DN]);
    ldap.search.mockResolvedValueOnce({ searchEntries: [{ dn: USER_DN }] });
    await expect(service.getUserGroupDns(config, USER_DN)).resolves.toEqual([]);
  });

  it('is null when no entry has the DN (deleted, moved or renamed)', async () => {
    const { service, ldap } = setup();
    ldap.search.mockRejectedValue(
      ldapError(32, '0000208D: NameErr: DSID-0310028D, problem 2001 (NO_OBJECT)'),
    );
    await expect(service.getUserGroupDns(config, USER_DN)).resolves.toBeNull();
  });
});

describe('AdService.removeGroupMember', () => {
  it("deletes the user's DN from the group's member attribute", async () => {
    const { service, ldap } = setup();
    await expect(service.removeGroupMember(config, USER_DN, GROUP_DN)).resolves.toBe('removed');
    const [dn, change] = ldap.modify.mock.calls[0];
    expect(dn).toBe(GROUP_DN);
    expect(change.operation).toBe('delete');
    expect(change.modification.type).toBe('member');
    expect(change.modification.values).toEqual([USER_DN]);
  });

  it.each([
    ['OpenLDAP noSuchAttribute', 16, 'modify/delete: member: no such value'],
    [
      'AD ERROR_MEMBER_NOT_IN_GROUP',
      53,
      '00000561: SvcErr: DSID-031A1021, problem 5003 (WILL_NOT_PERFORM), data 0',
    ],
  ])(
    'a directory saying "not a member" (%s) is not-member, not removed',
    async (_name, code, message) => {
      const { service, ldap } = setup();
      ldap.modify.mockRejectedValue(ldapError(code, message));
      await expect(service.removeGroupMember(config, USER_DN, GROUP_DN)).resolves.toBe(
        'not-member',
      );
    },
  );

  it.each([
    [
      'other unwillingToPerform',
      53,
      '0000209A: SvcErr: DSID-031A1021, problem 5003 (WILL_NOT_PERFORM)',
    ],
    [
      'insufficientAccessRights',
      50,
      '00002098: SecErr: DSID-03150F94, problem 4003 (INSUFF_ACCESS_RIGHTS)',
    ],
  ])('propagates %s', async (_name, code, message) => {
    const { service, ldap } = setup();
    ldap.modify.mockRejectedValue(ldapError(code, message));
    await expect(service.removeGroupMember(config, USER_DN, GROUP_DN)).rejects.toThrow(message);
    expect(ldap.unbind).toHaveBeenCalled();
  });

  it('refuses a config without a base DN', async () => {
    const { service } = setup();
    await expect(
      service.removeGroupMember({ ...config, rootBaseDn: undefined }, USER_DN, GROUP_DN),
    ).rejects.toThrow('AD config invalid');
  });
});
