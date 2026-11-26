/**
 * SSRF guard: checks for outbound URLs and hosts, and a DNS lookup for HTTP agents that connects
 * only to addresses the guard allows.
 *
 * - URLs: https only.
 * - Host names: cloud metadata names and localhost are refused by name.
 * - Addresses (isBlockedAddress): an IP literal, and every address a host name resolves to, must
 *   be public unicast. Each address is parsed (node:net) and checked against the special-purpose
 *   ranges of both families; an IPv6 form that embeds an IPv4 address (IPv4-mapped, -compatible,
 *   -translated, NAT64 64:ff9b::/96, 6to4 2002::/16) is judged by the IPv4 address it embeds.
 *   Non-canonical IPv4 hosts (decimal, hex, octal, short forms) are normalised by the URL parser
 *   before they are judged.
 *
 * A check before a request does not decide where the request connects: the HTTP client resolves
 * the host again, and the answer can change in between (DNS rebinding). A client that must not
 * reach a private address connects through createSsrfSafeHttpsAgent, whose lookup checks the
 * addresses it hands the socket. Node connects to an IP literal without a lookup, so such a
 * client checks the URL itself too (validateUrlForFetch, or checkUrlWithoutDns when it checks at
 * send time and leaves the name to the agent).
 *
 * Refusals name no connector: every client uses the guard, and its caller says which one.
 */

import * as dns from 'dns';
import * as https from 'https';
import { BlockList, isIP, isIPv4, isIPv6, type LookupFunction } from 'net';

/** IPv4 ranges that are not public unicast (IANA special-purpose registry, multicast, reserved). */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"; 0.0.0.0 reaches the local host
  ['10.0.0.0', 8], // private (RFC 1918)
  ['100.64.0.0', 10], // carrier-grade NAT (RFC 6598)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private (RFC 1918)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private (RFC 1918)
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, with 255.255.255.255 (broadcast)
];

/**
 * IPv6 ranges that are not public unicast. Anything outside 2000::/3 (global unicast) is refused
 * as well, so the ranges listed outside it document what that rule covers.
 */
const BLOCKED_IPV6_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local-use IPv4/IPv6 translation
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment routing SIDs
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

const BLOCKED = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4_RANGES) BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of BLOCKED_IPV6_RANGES) BLOCKED.addSubnet(network, prefix, 'ipv6');

const GLOBAL_UNICAST_IPV6 = new BlockList();
GLOBAL_UNICAST_IPV6.addSubnet('2000::', 3, 'ipv6');

/** Cloud metadata names, and localhost (RFC 6761: it and its subdomains are the local host). */
const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.internal', 'localhost']);

function isBlockedHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return BLOCKED_HOSTNAMES.has(name) || name.endsWith('.localhost');
}

const ipv4ToNumber = (address: string) =>
  address.split('.').reduce((value, part) => value * 256 + Number(part), 0);

const numberToIpv4 = (value: number) =>
  [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');

/** The eight 16-bit groups of a valid IPv6 address (no zone id). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const embedded = ipv4ToNumber(dotted[2]!);
    text = `${dotted[1]}${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...new Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.map((group) => parseInt(group, 16));
}

/** The IPv4 address an IPv6 address embeds by a standard mapping or translation, if any. */
function embeddedIpv4(groups: number[]): string | undefined {
  const zero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  const low32 = numberToIpv4(groups[6]! * 0x10000 + groups[7]!);
  if (zero(0, 5) && groups[5] === 0xffff) return low32; // ::ffff:0:0/96 IPv4-mapped
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return low32; // IPv4-translated
  if (zero(0, 6)) return low32; // ::/96 IPv4-compatible (deprecated)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return low32; // NAT64
  if (groups[0] === 0x2002) return numberToIpv4(groups[1]! * 0x10000 + groups[2]!); // 6to4
  return undefined;
}

/**
 * Whether EuroID must not connect to this address: anything but a public unicast IPv4 or IPv6
 * address, and anything that is not an IP address at all. IPv6 may carry a zone id (`%eth0`).
 */
export function isBlockedAddress(address: string): boolean {
  if (isIPv4(address)) return BLOCKED.check(address, 'ipv4');
  const plain = address.split('%')[0]!;
  if (!isIPv6(plain)) return true;
  if (BLOCKED.check(plain, 'ipv6')) return true;
  const embedded = embeddedIpv4(ipv6Groups(plain));
  if (embedded !== undefined) return BLOCKED.check(embedded, 'ipv4');
  return !GLOBAL_UNICAST_IPV6.check(plain, 'ipv6');
}

/** The address of an IP literal host (IPv6 with or without brackets), or undefined for a name. */
function ipLiteral(host: string): string | undefined {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(bare) ? bare : undefined;
}

/** Every address the host resolves to, as a connection would resolve it (getaddrinfo). */
function lookupAll(hostname: string): Promise<dns.LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    );
  });
}

/**
 * The first address of the host that the guard blocks. A host that does not resolve has none:
 * there is nothing to connect to, and a connection that resolves it later goes through the same
 * check when it uses ssrfSafeLookup.
 */
async function firstBlockedAddress(hostname: string): Promise<string | undefined> {
  const addresses = await lookupAll(hostname).catch(() => [] as dns.LookupAddress[]);
  return addresses.find((entry) => isBlockedAddress(entry.address))?.address;
}

/**
 * The checks of validateUrlForFetch that need no DNS: https, a host, no blocked name, no blocked
 * IP literal. Throws for a URL the guard refuses; answers the host name still to be resolved, or
 * undefined when the host is an IP literal (judged here).
 */
export function checkUrlWithoutDns(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:') {
    throw new Error(`Only HTTPS URLs are allowed for remote fetches. Got: ${protocol}`);
  }

  // The URL parser has normalised the host: IPv4 in dotted decimal, IPv6 compressed in brackets.
  const hostname = parsed.hostname;
  if (!hostname) {
    throw new Error('URL must have a hostname');
  }
  if (isBlockedHostname(hostname)) {
    throw new Error(`URL targets a blocked hostname (cloud metadata or localhost): ${hostname}`);
  }

  const ip = ipLiteral(hostname);
  if (ip === undefined) return hostname;
  if (isBlockedAddress(ip)) {
    throw new Error(
      `URL targets a blocked IP range (private, loopback, link-local, metadata or reserved): ${hostname}`,
    );
  }
  return undefined;
}

/**
 * Validates a URL for safe outbound fetch. Throws if the URL would lead to
 * private/internal resources (SSRF risk).
 *
 * - Only https:// protocol allowed
 * - Resolves hostname and blocks private IPs, loopback, link-local, cloud metadata, reserved
 */
export async function validateUrlForFetch(url: string): Promise<void> {
  const hostname = checkUrlWithoutDns(url);
  if (hostname === undefined) return;

  const blocked = await firstBlockedAddress(hostname);
  if (blocked !== undefined) {
    throw new Error(`URL resolves to blocked IP ${blocked} (${hostname})`);
  }
}

/**
 * A raw host as a connection would read it: an IP literal as it is, anything else normalised by
 * the URL parser (non-canonical IPv4 such as `2130706433` becomes `127.0.0.1`, as getaddrinfo
 * reads it). A host with a port, user or path is refused: the guard would judge another host.
 */
function canonicalHost(host: string): string {
  const literal = ipLiteral(host);
  if (literal !== undefined) return literal;
  let parsed: URL | undefined;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    parsed = undefined;
  }
  const bare =
    parsed &&
    parsed.host === parsed.hostname &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname === '/' &&
    !parsed.search &&
    !parsed.hash;
  if (!parsed || !bare) {
    throw new Error(`Connector: Host is not a host name or IP address: ${host}`);
  }
  return ipLiteral(parsed.hostname) ?? parsed.hostname;
}

/**
 * Validates a host (hostname or IP) for safe outbound connect (LDAP, etc.).
 * Throws if the host resolves to or is a private/internal IP (SSRF risk).
 *
 * Used by AD connector and other non-HTTP connectors.
 */
export async function validateHostForConnect(host: string): Promise<void> {
  const hostname = checkHostWithoutDns(host);
  if (isIP(hostname)) return;

  const blocked = await firstBlockedAddress(hostname);
  if (blocked !== undefined) {
    throw new Error(`Connector: Host ${hostname} resolves to blocked IP ${blocked}`);
  }
}

/** The checks of validateHostForConnect that need no DNS; answers the canonical host. */
function checkHostWithoutDns(host: string): string {
  const raw = host?.trim();
  if (!raw) {
    throw new Error('Connector: Host is required');
  }

  const hostname = canonicalHost(raw);
  if (isBlockedHostname(hostname)) {
    throw new Error(
      `Connector: Host targets a blocked hostname (cloud metadata or localhost): ${hostname}`,
    );
  }

  if (isIP(hostname) && isBlockedAddress(hostname)) {
    throw new Error(
      `Connector: Host targets a blocked IP range (private, loopback, link-local, metadata or reserved): ${raw}`,
    );
  }
  return hostname;
}

/**
 * Where to connect for a raw host (an LDAP server): the checks of validateHostForConnect, then
 * one address the host resolves to, all of whose addresses the guard allows. The caller connects
 * to `address`, never to the name again, so a DNS answer that changes between this check and the
 * connect (rebinding) cannot reach a blocked address. `servername` is the host name to check a TLS
 * certificate against (undefined for an IP literal, which TLS does not take as a server name). A
 * host that does not resolve is refused: there is nothing to connect to. Errors start with
 * "Connector: ".
 */
export async function resolveHostForConnect(
  host: string,
): Promise<{ address: string; servername?: string }> {
  const hostname = checkHostWithoutDns(host);
  if (isIP(hostname)) return { address: hostname };
  const addresses = await lookupAll(hostname).catch(() => [] as dns.LookupAddress[]);
  if (addresses.length === 0) {
    throw new Error(`Connector: Host ${hostname} could not be resolved`);
  }
  const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
  if (blocked) {
    throw new Error(`Connector: Host ${hostname} resolves to blocked IP ${blocked.address}`);
  }
  return { address: addresses[0].address, servername: hostname };
}

/**
 * DNS lookup for an HTTP agent (`new https.Agent({ lookup })`): resolves the host as the default
 * lookup does and hands the socket only addresses the guard allows. When any address the host
 * resolves to is blocked, the connection fails. The check and the connect use the same answer,
 * so an answer that changed since an earlier check (DNS rebinding) cannot reach a blocked
 * address. The error names the host, never the address it resolved to.
 */
export const ssrfSafeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '');
      return;
    }
    if (addresses.length === 0) {
      callback(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }),
        '',
      );
      return;
    }
    if (addresses.some((entry) => isBlockedAddress(entry.address))) {
      const refused: NodeJS.ErrnoException = new Error(
        `Refused to connect to ${hostname}: it resolves to a private, loopback, link-local, cloud metadata or reserved address`,
      );
      refused.code = 'ERR_SSRF_BLOCKED';
      callback(refused, '');
      return;
    }
    if (options.all) {
      callback(null, addresses);
      return;
    }
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/**
 * An HTTPS agent whose connections go only to addresses the guard allows (ssrfSafeLookup). TLS
 * still verifies the certificate against the URL's host name. A connection to an IP literal is
 * not looked up: check the URL first (validateUrlForFetch or checkUrlWithoutDns).
 */
export function createSsrfSafeHttpsAgent(): https.Agent {
  return new https.Agent({ lookup: ssrfSafeLookup });
}

/**
 * Returns true if local file paths are allowed (dev/demo mode).
 * In production, local paths are rejected unless ALLOW_JSON_API_LOCAL_FILES=true.
 */
export function isLocalFileAllowed(): boolean {
  if (process.env.ALLOW_JSON_API_LOCAL_FILES === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}
