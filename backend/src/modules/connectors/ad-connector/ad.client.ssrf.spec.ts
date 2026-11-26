/**
 * SSRF: the AD client binds to the tenant's LDAP host. The real guard refuses a blocked host
 * before any LDAP client is made: the error reaches the caller, nothing binds, and the health
 * check reports the refusal (the other AD client specs mock the guard). DNS is stubbed, and
 * ldapts is mocked so that nothing could leave the process even if the guard let a host through.
 */
jest.mock('ldapts', () => ({
  ...jest.requireActual('ldapts'),
  Client: jest.fn(),
}));

import { Client } from 'ldapts';
import * as dns from 'dns';
import { stubOutboundConnections, v4, v6 } from '@testing/stub-outbound-connect';
import { AdClient } from './ad.client';
import type { AdConfig } from './ad.interface';

const MockedClient = Client as unknown as jest.Mock;

const at = (host: string): AdConfig => ({
  host,
  rootBaseDn: 'DC=acme,DC=test',
  serviceAccount: 'CN=svc,DC=acme,DC=test',
  password: 'secret',
});

describe('AdClient: the SSRF guard on the LDAP host', () => {
  let answerDns: ReturnType<typeof stubOutboundConnections>['answerDns'];
  const client = new AdClient();

  beforeEach(() => {
    ({ answerDns } = stubOutboundConnections());
    MockedClient.mockReset();
    MockedClient.mockImplementation(() => ({
      bind: jest.fn().mockResolvedValue(undefined),
      unbind: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue({ searchEntries: [] }),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['169.254.169.254', '127.0.0.1', 'localhost', '[::1]'])(
    'refuses the host %s before making an LDAP client',
    async (host) => {
      await expect(client.searchUsers(at(host), 'DC=acme,DC=test')).rejects.toThrow(/blocked/);
      expect(MockedClient).not.toHaveBeenCalled();
    },
  );

  it('refuses a host that resolves to a private address', async () => {
    answerDns([v4('10.0.0.5')]);

    await expect(client.searchUsers(at('dc.acme.test'), 'DC=acme,DC=test')).rejects.toThrow(
      'Connector: Host dc.acme.test resolves to blocked IP 10.0.0.5',
    );
    expect(MockedClient).not.toHaveBeenCalled();
  });

  it('refuses it on a plain bind too', async () => {
    await expect(client.bind(at('169.254.169.254'))).rejects.toThrow(/blocked/);
    expect(MockedClient).not.toHaveBeenCalled();
  });

  // Hunt 2026-11-25 (01 F9): the answer quoted the guard ("resolves to blocked IP 10.0.0.5"),
  // so an operator could map internal names to addresses through POST .../ad/health-check. The
  // answer is now one connection message; the log keeps the reason.
  it('reports the refusal in the health check without the address, and without binding', async () => {
    answerDns([v4('10.0.0.5')]);

    const result = await client.healthCheckEnriched(at('dc.acme.test'));

    expect(result).toEqual({
      connected: false,
      error: expect.stringMatching(/^Could not connect to the directory/),
    });
    expect(result.error).not.toMatch(/10\.0\.0\.5|blocked/);
    expect(MockedClient).not.toHaveBeenCalled();
  });

  it('tells a refused service account sign-in apart, without the directory diagnostics', async () => {
    answerDns([v4('93.184.216.34')]);
    const { InvalidCredentialsError } = jest.requireActual('ldapts');
    MockedClient.mockImplementation(() => ({
      bind: jest
        .fn()
        .mockRejectedValue(
          new InvalidCredentialsError('80090308: LdapErr: DSID-0C09042A, data 52e, v4563'),
        ),
      unbind: jest.fn().mockResolvedValue(undefined),
    }));

    const result = await client.healthCheckEnriched(at('dc.acme.test'));

    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/refused the service account sign-in/);
    expect(result.error).not.toMatch(/DSID|52e/);
  });

  // Hunt 01 F17 (DNS rebinding): the guard resolved the host, then ldapts resolved it again, so a
  // name that answered a public address to the guard and a private one to ldapts reached the
  // private address with the service account's bind. The client now connects to the address the
  // guard vetted, and LDAPS checks the certificate against the host name (TLS servername).
  describe('connects to the address the guard vetted', () => {
    const optionsOfClient = () => MockedClient.mock.calls[0][0] as Record<string, unknown>;

    it('resolves the host once, and LDAPS checks the certificate against the host name', async () => {
      answerDns([v4('93.184.216.34')], [v4('10.0.0.5')]);

      await client.searchUsers(at('dc.acme.test'), 'DC=acme,DC=test');

      expect(optionsOfClient()).toMatchObject({
        url: 'ldaps://93.184.216.34:636',
        tlsOptions: { servername: 'dc.acme.test' },
      });
      expect(dns.lookup).toHaveBeenCalledTimes(1);
    });

    it('brackets an IPv6 address and keeps the configured port', async () => {
      answerDns([v6('2606:4700:4700::1111')]);

      await client.bind({ ...at('dc.acme.test'), port: 3269 });

      expect(optionsOfClient()).toMatchObject({ url: 'ldaps://[2606:4700:4700::1111]:3269' });
    });

    it('gives plain LDAP no TLS options (ldapts would switch to TLS)', async () => {
      answerDns([v4('93.184.216.34')]);

      await client.searchUsers({ ...at('dc.acme.test'), useLdaps: false }, 'DC=acme,DC=test');

      expect(optionsOfClient().url).toBe('ldap://93.184.216.34:389');
      expect(optionsOfClient()).not.toHaveProperty('tlsOptions');
    });

    it('connects to an IP literal as it is, with no TLS server name', async () => {
      await client.searchUsers(at('93.184.216.34'), 'DC=acme,DC=test');

      expect(optionsOfClient().url).toBe('ldaps://93.184.216.34:636');
      expect(optionsOfClient()).not.toHaveProperty('tlsOptions');
      expect(dns.lookup).not.toHaveBeenCalled();
    });

    it('refuses a host that does not resolve, before making an LDAP client', async () => {
      answerDns(
        Object.assign(new Error('getaddrinfo ENOTFOUND dc.acme.test'), { code: 'ENOTFOUND' }),
      );

      await expect(client.searchUsers(at('dc.acme.test'), 'DC=acme,DC=test')).rejects.toThrow(
        /could not be resolved/,
      );
      expect(MockedClient).not.toHaveBeenCalled();
    });
  });
});
