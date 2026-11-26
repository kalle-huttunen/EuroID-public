/**
 * Graph answers a list one page at a time (100 entries by default) with `@odata.nextLink` to the
 * next one. Hunt 2026-11-25 (r2-01 N3): entitlement discovery read the first page of groups and
 * getUserGroupMemberships the first page of memberships, so a tenant with more than 100 groups
 * had a truncated catalog, and anomaly detection and policy suggestions saw at most 100
 * memberships. Both now follow every nextLink (EntraClient.getByUrl, SSRF-checked). The client
 * is mocked at the HTTP boundary.
 */
import type { ConfigService } from '@nestjs/config';
import type { EntraClient } from './entra.client';
import { EntraDiscoveryService } from './entra-discovery.service';
import { EntraEntitlementsService } from './entra-entitlements.service';

const NEXT = 'https://graph.microsoft.com/v1.0/next-page';

function pagedClient(firstPath: string, pages: Array<Array<Record<string, unknown>>>) {
  const pageAt = (i: number) => ({
    value: pages[i],
    ...(i + 1 < pages.length ? { '@odata.nextLink': `${NEXT}?page=${i + 1}` } : {}),
  });
  return {
    get: jest.fn(async (endpoint: string) => {
      if (endpoint === firstPath) return pageAt(0);
      return { value: [] };
    }),
    getByUrl: jest.fn(async (url: string) => pageAt(Number(new URL(url).searchParams.get('page')))),
  };
}

const items = (prefix: string, from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${from + i}`,
    displayName: `${prefix} ${from + i}`,
  }));

describe('Entra ID lists read to the last page', () => {
  it('discovers every group', async () => {
    const client = pagedClient('/groups?$select=id,displayName', [
      items('g', 1, 100),
      items('g', 101, 100),
      items('g', 201, 7),
    ]);
    const discovery = new EntraDiscoveryService(
      client as unknown as EntraClient,
      { get: () => undefined } as unknown as ConfigService,
    );

    const entitlements = await discovery.discoverEntitlements();

    const groups = entitlements.filter((e) => e.type === 'Group');
    expect(groups).toHaveLength(207);
    expect(client.getByUrl).toHaveBeenCalledTimes(2);
  });

  // The license forecast starts from the units in use (HX-F report follow-up)
  it('gives each license the units Entra ID reports in use and enabled', async () => {
    const client = {
      get: jest.fn(async (endpoint: string) =>
        endpoint === '/subscribedSkus'
          ? {
              value: [
                {
                  skuPartNumber: 'ENTERPRISEPACK',
                  consumedUnits: 95,
                  prepaidUnits: { enabled: 100 },
                },
                { skuPartNumber: 'FLOW_FREE' },
              ],
            }
          : { value: [] },
      ),
      getByUrl: jest.fn(),
    };
    const discovery = new EntraDiscoveryService(
      client as unknown as EntraClient,
      { get: () => undefined } as unknown as ConfigService,
    );

    const licenses = (await discovery.discoverEntitlements()).filter((e) => e.type === 'License');

    expect(licenses.map((l) => [l.name, l.licenseUnits])).toEqual([
      ['ENTERPRISEPACK', { consumed: 95, enabled: 100 }],
      ['FLOW_FREE', undefined],
    ]);
  });

  it("reads every one of a user's memberships", async () => {
    const client = pagedClient('/users/u-1/memberOf?$select=id,displayName', [
      items('m', 1, 100),
      items('m', 101, 30),
    ]);
    const entitlements = new EntraEntitlementsService(
      client as unknown as EntraClient,
      { get: () => undefined } as unknown as ConfigService,
    );

    const memberships = await entitlements.getUserGroupMemberships('u-1');

    expect(memberships).toHaveLength(130);
    expect(memberships[129]).toEqual({ id: 'm130', displayName: 'm 130' });
  });
});
