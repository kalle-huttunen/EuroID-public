import { tenantVisibilityQuery } from './tenant-search-attribute';

/** The visibility query of one tenant's workflows: the tenant id can never change the query. */
describe('tenantVisibilityQuery', () => {
  it('matches the TenantId search attribute', () => {
    expect(tenantVisibilityQuery('tenant-a')).toBe('TenantId = "tenant-a"');
  });

  it('escapes a double quote and a backslash, so the id stays one string literal', () => {
    // An IdP-supplied tenant claim like this would otherwise widen the query to every tenant.
    expect(tenantVisibilityQuery('x" OR TenantId != "')).toBe(
      'TenantId = "x\\" OR TenantId != \\""',
    );
    expect(tenantVisibilityQuery('a\\" OR 1=1 OR "')).toBe('TenantId = "a\\\\\\" OR 1=1 OR \\""');
  });
});
