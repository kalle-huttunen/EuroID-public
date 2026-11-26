/**
 * Outbound connections without a network, for SSRF tests. dns.lookup answers what the test says
 * (an unexpected lookup throws), and every TLS connect stops right after the HTTP agent's own
 * lookup, recording the host, the TLS server name and the addresses the socket would have
 * connected to. A connect with the default lookup (an agent without its own) or to an IP literal
 * (which net never looks up) is stopped and recorded as well, so no test reaches a real address.
 *
 * Call it in beforeEach; `jest.restoreAllMocks()` in afterEach undoes it.
 */
import * as dns from 'dns';
import type { LookupAddress } from 'dns';
import { isIP, type LookupFunction } from 'net';
import * as tls from 'tls';

export interface OutboundConnect {
  host: string;
  servername?: string;
  rejectUnauthorized?: boolean;
  /** What the agent's lookup handed the socket; absent when it refused. */
  addresses?: LookupAddress[] | string;
  error?: string;
}

/** The error a connect fails with once the agent's lookup let it through. */
export const STOPPED_BEFORE_CONNECT = 'test: stopped before connecting';

export const v4 = (address: string): LookupAddress => ({ address, family: 4 });
export const v6 = (address: string): LookupAddress => ({ address, family: 6 });

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  addresses: LookupAddress[] | string,
  family?: number,
) => void;

export function stubOutboundConnections() {
  const connects: OutboundConnect[] = [];
  jest.spyOn(dns, 'lookup').mockImplementation(((host: string) => {
    throw new Error(`unexpected DNS lookup of ${host}`);
  }) as unknown as typeof dns.lookup);

  const realConnect = tls.connect;
  jest.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) => {
    const host = options.host ?? '';
    const seen = {
      host,
      servername: options.servername,
      rejectUnauthorized: options.rejectUnauthorized,
    };
    if (isIP(host)) {
      connects.push({ ...seen, error: 'IP literal' });
      throw new Error('test: refused to connect to an IP literal');
    }
    const agentLookup = options.lookup;
    const stopAfterLookup: LookupFunction = (name, lookupOptions, callback) => {
      if (!agentLookup) {
        connects.push({ ...seen, error: 'default lookup' });
        callback(new Error('test: the agent connects with the default lookup'), '');
        return;
      }
      agentLookup(name, lookupOptions, (err, addresses) => {
        connects.push({ ...seen, ...(err ? { error: err.message } : { addresses }) });
        callback(
          err ?? Object.assign(new Error(STOPPED_BEFORE_CONNECT), { code: 'ETESTSTOP' }),
          '',
        );
      });
    };
    return realConnect({ ...options, lookup: stopAfterLookup });
  }) as unknown as typeof tls.connect);

  /** dns.lookup answers these, one per call, the last one repeating. An Error is a DNS failure. */
  const answerDns = (...answers: Array<LookupAddress[] | NodeJS.ErrnoException>) => {
    let call = 0;
    (dns.lookup as unknown as jest.Mock).mockImplementation(
      (_host: string, _options: unknown, callback: LookupCallback) => {
        const answer = answers[Math.min(call++, answers.length - 1)]!;
        setImmediate(() =>
          answer instanceof Error ? callback(answer, []) : callback(null, answer),
        );
      },
    );
  };

  return { connects, answerDns };
}
