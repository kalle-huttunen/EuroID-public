/**
 * The root `npm run temporal` script starts the local Temporal dev server the README's quick start
 * uses without Compose. Every workflow the API starts carries the TenantId search attribute, and
 * Temporal refuses a start whose attribute is not registered, so the dev server must register it
 * (as Compose's temporal-init does). It did not: every workflow start failed against it.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { TENANT_SEARCH_ATTRIBUTE } from './tenant-search-attribute';

const ROOT_PACKAGE = resolve(__dirname, '../../../../package.json');

describe('the root npm run temporal dev server', () => {
  it('registers the tenant search attribute every workflow start carries, as Keyword', () => {
    const { scripts } = JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(scripts.temporal).toMatch(/^temporal server start-dev\b/);
    expect(scripts.temporal.split(/\s+/)).toEqual(
      expect.arrayContaining(['--search-attribute', `${TENANT_SEARCH_ATTRIBUTE}=Keyword`]),
    );
  });
});
