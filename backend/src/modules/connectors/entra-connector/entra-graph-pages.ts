import type { EntraClient } from './entra.client';
import type { EntraConfig } from './entra.interface';

/** One page of a Graph list. */
export interface GraphPage<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

/**
 * Every entry of a Graph list: the first page from `endpoint`, then each `@odata.nextLink`
 * (EntraClient.getByUrl checks it with the SSRF guard) until a page has none. Graph pages lists
 * (100 entries by default), so reading the first page alone truncates a large tenant's list.
 */
export async function everyGraphPage<T>(
  client: Pick<EntraClient, 'get' | 'getByUrl'>,
  endpoint: string,
  config: EntraConfig | undefined,
): Promise<T[]> {
  return followGraphPages(client, await client.get<GraphPage<T>>(endpoint, config), config);
}

/** The entries of `first` and of every page its `@odata.nextLink` chain leads to. */
export async function followGraphPages<T>(
  client: Pick<EntraClient, 'getByUrl'>,
  first: GraphPage<T>,
  config: EntraConfig | undefined,
): Promise<T[]> {
  const entries: T[] = [];
  let page = first;
  for (;;) {
    entries.push(...(page?.value ?? []));
    const next = page?.['@odata.nextLink'];
    if (!next) return entries;
    page = await client.getByUrl<GraphPage<T>>(next, config);
  }
}
