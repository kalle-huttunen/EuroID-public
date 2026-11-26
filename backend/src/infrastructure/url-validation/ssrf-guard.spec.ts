/**
 * The SSRF guard decides which addresses EuroID may connect to for a webhook, an HR feed or
 * another connector. A miss lets a tenant admin point the server at loopback, the cloud
 * metadata service or the internal network (and read the answer's status as a port scan).
 *
 * Before 2.0dx the IPv6 check matched only the dotted IPv4-mapped form, which the URL parser
 * never produces (`[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`), so `https://[::ffff:127.0.0.1]/`,
 * `https://[::ffff:169.254.169.254]/` and `https://[::]/` were allowed. The guard now parses every
 * address and judges an IPv6 form that embeds an IPv4 address by that IPv4 address.
 *
 * DNS is stubbed throughout: no test resolves a real name or connects anywhere.
 */
import * as dns from 'dns';
import type { LookupAddress } from 'dns';
import { stubOutboundConnections, v4, v6 } from '@testing/stub-outbound-connect';
import {
  isBlockedAddress,
  ssrfSafeLookup,
  validateHostForConnect,
  validateUrlForFetch,
} from './ssrf-guard';

let answerDns: ReturnType<typeof stubOutboundConnections>['answerDns'];

beforeEach(() => {
  // A test that reaches DNS without stubbing an answer fails instead of querying the network.
  ({ answerDns } = stubOutboundConnections());
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('SSRF guard: address literals in a URL', () => {
  /**
   * [URL as configured, the host the URL parser turns it into, why it is blocked]. The guard sees
   * only the parsed host, so the non-canonical IPv4 forms (decimal, hex, octal, short) and the
   * IPv6 spellings are asserted to reach it in their canonical form.
   */
  const BLOCKED: Array<[string, string, string]> = [
    ['https://127.0.0.1/', '127.0.0.1', 'loopback'],
    ['https://127.255.255.254/', '127.255.255.254', 'loopback'],
    ['https://0.0.0.0/', '0.0.0.0', 'this host'],
    ['https://0.1.2.3/', '0.1.2.3', '"this network"'],
    ['https://10.0.0.5/', '10.0.0.5', 'private'],
    ['https://172.16.0.1/', '172.16.0.1', 'private'],
    ['https://172.31.255.255/', '172.31.255.255', 'private'],
    ['https://192.168.1.1/', '192.168.1.1', 'private'],
    ['https://169.254.169.254/', '169.254.169.254', 'cloud metadata (link-local)'],
    ['https://169.254.0.1/', '169.254.0.1', 'link-local'],
    ['https://100.64.0.1/', '100.64.0.1', 'carrier-grade NAT'],
    ['https://100.127.255.254/', '100.127.255.254', 'carrier-grade NAT'],
    ['https://192.0.0.8/', '192.0.0.8', 'IETF protocol assignments'],
    ['https://192.0.2.10/', '192.0.2.10', 'documentation'],
    ['https://198.51.100.7/', '198.51.100.7', 'documentation'],
    ['https://203.0.113.7/', '203.0.113.7', 'documentation'],
    ['https://198.18.0.1/', '198.18.0.1', 'benchmarking'],
    ['https://198.19.255.254/', '198.19.255.254', 'benchmarking'],
    ['https://192.88.99.1/', '192.88.99.1', '6to4 relay anycast'],
    ['https://224.0.0.1/', '224.0.0.1', 'multicast'],
    ['https://239.255.255.250/', '239.255.255.250', 'multicast'],
    ['https://240.0.0.1/', '240.0.0.1', 'reserved'],
    ['https://255.255.255.255/', '255.255.255.255', 'broadcast'],
    // Non-canonical IPv4: the URL parser normalises them before the guard sees the host.
    ['https://2130706433/', '127.0.0.1', 'loopback, decimal'],
    ['https://0x7f000001/', '127.0.0.1', 'loopback, hex'],
    ['https://0x7f.0.0.1/', '127.0.0.1', 'loopback, hex first part'],
    ['https://0177.0.0.1/', '127.0.0.1', 'loopback, octal first part'],
    ['https://017700000001/', '127.0.0.1', 'loopback, octal'],
    ['https://127.1/', '127.0.0.1', 'loopback, two parts'],
    ['https://127.0.1/', '127.0.0.1', 'loopback, three parts'],
    ['https://127.0.0.1./', '127.0.0.1', 'loopback, trailing dot'],
    ['https://0/', '0.0.0.0', 'this host, decimal'],
    ['https://2852039166/', '169.254.169.254', 'cloud metadata, decimal'],
    ['https://0xa9fea9fe/', '169.254.169.254', 'cloud metadata, hex'],
    ['https://0251.0376.0251.0376/', '169.254.169.254', 'cloud metadata, octal'],
    ['https://169.254.43518/', '169.254.169.254', 'cloud metadata, three parts'],
    ['https://10.1/', '10.0.0.1', 'private, two parts'],
    ['https://0x0a.0.0.5/', '10.0.0.5', 'private, hex first part'],
    // IPv6
    ['https://[::1]/', '[::1]', 'loopback'],
    ['https://[0:0:0:0:0:0:0:1]/', '[::1]', 'loopback, uncompressed'],
    ['https://[::]/', '[::]', 'unspecified'],
    ['https://[::ffff:127.0.0.1]/', '[::ffff:7f00:1]', 'IPv4-mapped loopback'],
    ['https://[::ffff:7f00:1]/', '[::ffff:7f00:1]', 'IPv4-mapped loopback, hex'],
    ['https://[0:0:0:0:0:ffff:127.0.0.1]/', '[::ffff:7f00:1]', 'IPv4-mapped, uncompressed'],
    ['https://[::ffff:169.254.169.254]/', '[::ffff:a9fe:a9fe]', 'IPv4-mapped cloud metadata'],
    ['https://[::ffff:10.0.0.5]/', '[::ffff:a00:5]', 'IPv4-mapped private'],
    ['https://[::127.0.0.1]/', '[::7f00:1]', 'IPv4-compatible loopback'],
    ['https://[::2]/', '[::2]', 'IPv4-compatible 0.0.0.2'],
    ['https://[::ffff:0:127.0.0.1]/', '[::ffff:0:7f00:1]', 'IPv4-translated loopback'],
    ['https://[64:ff9b::127.0.0.1]/', '[64:ff9b::7f00:1]', 'NAT64 of loopback'],
    ['https://[64:ff9b::a9fe:a9fe]/', '[64:ff9b::a9fe:a9fe]', 'NAT64 of cloud metadata'],
    ['https://[64:ff9b:1::a00:5]/', '[64:ff9b:1::a00:5]', 'local-use NAT64'],
    ['https://[2002:7f00:1::]/', '[2002:7f00:1::]', '6to4 of loopback'],
    ['https://[2002:a9fe:a9fe::1]/', '[2002:a9fe:a9fe::1]', '6to4 of cloud metadata'],
    ['https://[2002:c0a8:101::1]/', '[2002:c0a8:101::1]', '6to4 of 192.168.1.1'],
    ['https://[fe80::1]/', '[fe80::1]', 'link-local'],
    ['https://[FE80::1]/', '[fe80::1]', 'link-local, upper case'],
    ['https://[febf:ffff::1]/', '[febf:ffff::1]', 'link-local, top of fe80::/10'],
    ['https://[fc00::1]/', '[fc00::1]', 'unique local'],
    ['https://[fd12:3456:789a::1]/', '[fd12:3456:789a::1]', 'unique local'],
    ['https://[fd00:ec2::254]/', '[fd00:ec2::254]', 'AWS IPv6 metadata (unique local)'],
    ['https://[fec0::1]/', '[fec0::1]', 'site-local (deprecated)'],
    ['https://[ff02::1]/', '[ff02::1]', 'multicast'],
    ['https://[ff05::fb]/', '[ff05::fb]', 'multicast'],
    ['https://[100::1]/', '[100::1]', 'discard-only'],
    ['https://[2001::1]/', '[2001::1]', 'Teredo'],
    ['https://[2001:2::1]/', '[2001:2::1]', 'benchmarking'],
    ['https://[2001:db8::1]/', '[2001:db8::1]', 'documentation'],
    ['https://[3fff::1]/', '[3fff::1]', 'documentation'],
    ['https://[5f00::1]/', '[5f00::1]', 'segment routing, outside 2000::/3'],
    ['https://[4000::1]/', '[4000::1]', 'outside global unicast 2000::/3'],
  ];

  it.each(BLOCKED)('refuses %s (parsed host %s: %s)', async (url, host) => {
    expect(new URL(url).hostname).toBe(host);

    await expect(validateUrlForFetch(url)).rejects.toThrow(/blocked/);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  /** Public addresses next to blocked ranges, and IPv6 forms that embed a public IPv4 address. */
  const ALLOWED: Array<[string, string]> = [
    ['https://8.8.8.8/', '8.8.8.8'],
    ['https://1.1.1.1/', '1.1.1.1'],
    ['https://11.0.0.1/', '11.0.0.1'],
    ['https://100.63.255.255/', '100.63.255.255'],
    ['https://100.128.0.1/', '100.128.0.1'],
    ['https://172.15.255.255/', '172.15.255.255'],
    ['https://172.32.0.1/', '172.32.0.1'],
    ['https://169.253.255.255/', '169.253.255.255'],
    ['https://169.255.0.1/', '169.255.0.1'],
    ['https://192.167.255.255/', '192.167.255.255'],
    ['https://192.169.0.1/', '192.169.0.1'],
    ['https://198.17.255.255/', '198.17.255.255'],
    ['https://198.20.0.1/', '198.20.0.1'],
    ['https://223.255.255.254/', '223.255.255.254'],
    ['https://134744072/', '8.8.8.8'],
    ['https://[2606:4700:4700::1111]/', '[2606:4700:4700::1111]'],
    ['https://[2001:4860:4860::8888]/', '[2001:4860:4860::8888]'],
    ['https://[2a00:1450:4001:80b::200e]/', '[2a00:1450:4001:80b::200e]'],
    ['https://[2001:200::1]/', '[2001:200::1]'],
    ['https://[::ffff:8.8.8.8]/', '[::ffff:808:808]'],
    ['https://[64:ff9b::8.8.8.8]/', '[64:ff9b::808:808]'],
    ['https://[2002:808:808::1]/', '[2002:808:808::1]'],
  ];

  it.each(ALLOWED)('allows the public address %s (parsed host %s)', async (url, host) => {
    expect(new URL(url).hostname).toBe(host);

    await expect(validateUrlForFetch(url)).resolves.toBeUndefined();
    expect(dns.lookup).not.toHaveBeenCalled();
  });
});

describe('SSRF guard: isBlockedAddress (addresses as DNS answers them)', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '169.254.169.254',
    '100.64.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::a00:5',
    '2002:a00:5::1',
    'fe80::1',
    'fe80::1%eth0',
    'fd00:ec2::254',
    'ff02::1',
    // Not an address at all: nothing safe to connect to.
    'localhost',
    '2130706433',
    '',
  ])('blocks %p', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808', '64:ff9b::808:808'])(
    'allows %p',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('SSRF guard: host names in a URL', () => {
  it.each([
    'https://localhost/hook',
    'https://LOCALHOST./hook',
    'https://api.localhost/hook',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://metadata.internal/',
  ])('refuses %s by name, without resolving it', async (url) => {
    await expect(validateUrlForFetch(url)).rejects.toThrow(/blocked hostname/);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('refuses http', async () => {
    await expect(validateUrlForFetch('http://hooks.example/')).rejects.toThrow(/Only HTTPS/);
  });

  // Every refusal began with "JsonApiHrConnector:", also for SCIM, Entra ID, ServiceNow, Okta and
  // Discord (FOLLOWUPS 2026-11-24, ssrf-guard.ts): the caller names the connector
  it.each(['not a url', 'http://hooks.example/', 'https://localhost/', 'https://10.0.0.5/'])(
    'names no connector when it refuses %s',
    async (url) => {
      const refusal = await validateUrlForFetch(url).catch((e: unknown) => e as Error);
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).not.toMatch(/Connector/);
    },
  );

  it('allows a name whose every address is public', async () => {
    answerDns([v4('93.184.215.14'), v6('2606:2800:21f:cb07:6820:80da:af6b:8b2c')]);

    await expect(validateUrlForFetch('https://hooks.example/euroid')).resolves.toBeUndefined();
    expect(dns.lookup).toHaveBeenCalledWith(
      'hooks.example',
      expect.objectContaining({ all: true }),
      expect.any(Function),
    );
  });

  it.each([
    ['a private address', [v4('10.0.0.5')]],
    ['the cloud metadata address', [v4('169.254.169.254')]],
    ['one private address among public ones', [v4('93.184.215.14'), v4('192.168.0.10')]],
    ['an IPv4-mapped loopback address', [v6('::ffff:7f00:1')]],
    ['a link-local IPv6 address', [v4('93.184.215.14'), v6('fe80::1')]],
  ])('refuses a name that resolves to %s', async (_label, answer) => {
    answerDns(answer);

    await expect(validateUrlForFetch('https://intranet.example/hook')).rejects.toThrow(
      /resolves to blocked/,
    );
  });

  // Unchanged behaviour: the connection resolves the name again and finds nothing either. A
  // caller that connects later than it checks uses ssrfSafeLookup, which checks that answer.
  it('lets a name that does not resolve pass', async () => {
    answerDns(
      Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.example'), { code: 'ENOTFOUND' }),
    );

    await expect(validateUrlForFetch('https://nowhere.example/')).resolves.toBeUndefined();
  });
});

describe('SSRF guard: validateHostForConnect (a raw host, such as an LDAP server)', () => {
  // No URL parser in front: the guard normalises the host itself, as the connection's resolver
  // (getaddrinfo) would read it.
  it.each([
    '127.0.0.1',
    '2130706433',
    '0x7f.0.0.1',
    '0177.0.0.1',
    '127.1',
    '10.1',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '[::ffff:a9fe:a9fe]',
    '::',
    'fe80::1%eth0',
    'localhost',
    'metadata.google.internal',
    'dc01.corp.example:636',
    'user@dc01.corp.example',
  ])('refuses %p without resolving it', async (host) => {
    await expect(validateHostForConnect(host)).rejects.toThrow(/^Connector: /);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('refuses a name that resolves to a private address', async () => {
    answerDns([v4('10.0.0.5')]);

    await expect(validateHostForConnect('dc01.corp.example')).rejects.toThrow(
      /resolves to blocked IP 10\.0\.0\.5/,
    );
  });

  it('allows a public address and a name that resolves to one', async () => {
    answerDns([v4('93.184.215.14')]);

    await expect(validateHostForConnect('8.8.8.8')).resolves.toBeUndefined();
    await expect(validateHostForConnect('ldap.example.com')).resolves.toBeUndefined();
  });
});

describe('SSRF guard: ssrfSafeLookup (the lookup an HTTP agent connects with)', () => {
  const resolveWith = (
    options: dns.LookupOptions,
  ): Promise<{
    err: NodeJS.ErrnoException | null;
    address: LookupAddress[] | string;
    family?: number;
  }> =>
    new Promise((resolve) =>
      ssrfSafeLookup('hooks.example', options, (err, address, family) =>
        resolve({ err, address, family }),
      ),
    );

  it('hands the socket the addresses it checked, in one resolution', async () => {
    const answer = [v4('93.184.215.14'), v6('2606:4700:4700::1111')];
    answerDns(answer);

    // Node asks for every address when it races IPv4 and IPv6 (autoSelectFamily).
    await expect(resolveWith({ all: true, hints: dns.ADDRCONFIG })).resolves.toEqual({
      err: null,
      address: answer,
      family: undefined,
    });
    await expect(resolveWith({ family: 4 })).resolves.toEqual({
      err: null,
      address: '93.184.215.14',
      family: 4,
    });
    expect(dns.lookup).toHaveBeenCalledTimes(2);
    expect(dns.lookup).toHaveBeenLastCalledWith(
      'hooks.example',
      { family: 4, all: true },
      expect.any(Function),
    );
  });

  it.each([
    ['a private address', [v4('10.0.0.5')]],
    ['one private address among public ones', [v4('93.184.215.14'), v4('10.0.0.5')]],
    ['an IPv4-mapped metadata address', [v6('::ffff:a9fe:a9fe')]],
  ])('fails the connection when the name resolves to %s, without naming it', async (_l, answer) => {
    answerDns(answer);

    const { err } = await resolveWith({ all: true });

    expect(err?.code).toBe('ERR_SSRF_BLOCKED');
    expect(err?.message).toContain('hooks.example');
    expect(err?.message).not.toMatch(/10\.0\.0\.5|a9fe/);
  });

  // DNS rebinding: the name was public when checked, then answers a private address.
  it('checks every resolution, so an answer that changes after a check cannot pass', async () => {
    answerDns([v4('93.184.215.14')], [v4('169.254.169.254')]);

    await expect(validateUrlForFetch('https://hooks.example/hook')).resolves.toBeUndefined();
    const { err } = await resolveWith({ all: true });

    expect(err?.code).toBe('ERR_SSRF_BLOCKED');
  });

  it('passes a DNS failure through', async () => {
    answerDns(
      Object.assign(new Error('getaddrinfo ENOTFOUND hooks.example'), { code: 'ENOTFOUND' }),
    );

    const { err } = await resolveWith({ all: true });

    expect(err?.code).toBe('ENOTFOUND');
  });
});
