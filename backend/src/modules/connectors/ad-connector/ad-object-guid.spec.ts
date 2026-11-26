/**
 * AdService.listUsers gives each account its objectGUID, against a mocked ldapts Client. Orphan
 * detection names an AD orphan by it in orphan.detected (audit resourceId, webhook aggregateId):
 * the account's id is its DN, whose CN is the person's name. Untested against a live domain
 * controller.
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
// objectGUID as AD stores it: the first three groups of the GUID little-endian
const GUID_BYTES = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

function setup(entries: Array<Record<string, unknown>>) {
  const ldap = {
    bind: jest.fn().mockResolvedValue(undefined),
    unbind: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue({ searchEntries: entries }),
  };
  (Client as unknown as jest.Mock).mockImplementation(() => ldap);
  return { service: new AdService(new AdClient()), ldap };
}

describe('AdService.listUsers objectGUID', () => {
  it('reads objectGUID as bytes and gives it in the form AD shows it', async () => {
    const { service, ldap } = setup([
      { dn: USER_DN, objectGUID: GUID_BYTES, userAccountControl: '512' },
    ]);

    const [account] = await service.listUsers(config);

    expect(account.id).toBe(USER_DN);
    expect(account.objectGuid).toBe('33221100-5544-7766-8899-aabbccddeeff');
    expect(ldap.search).toHaveBeenCalledWith(
      'DC=acme,DC=test',
      expect.objectContaining({
        attributes: expect.arrayContaining(['objectGUID']),
        explicitBufferAttributes: ['objectGUID'],
      }),
    );
  });

  it('leaves objectGuid out for an entry without one', async () => {
    const { service } = setup([{ dn: USER_DN, objectGUID: [], userAccountControl: '512' }]);

    const [account] = await service.listUsers(config);

    expect(account.id).toBe(USER_DN);
    expect(account.objectGuid).toBeUndefined();
  });
});
