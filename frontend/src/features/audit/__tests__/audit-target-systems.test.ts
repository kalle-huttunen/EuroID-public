import { describe, it, expect } from 'vitest';
import { targetSystemOptions } from '../audit-target-systems';

const connectors = [
  { id: 'entra-id', name: 'Entra ID' },
  { id: 'okta', name: 'Okta' },
];

describe('targetSystemOptions', () => {
  // The options used to come from the loaded page only: a system absent from page 1 could not be
  // chosen.
  it('offers every registered connector, whatever the page shows', () => {
    expect(targetSystemOptions(connectors, [], undefined)).toEqual([
      { value: 'entra-id', label: 'Entra ID' },
      { value: 'okta', label: 'Okta' },
    ]);
  });

  it('keeps a system name from the page that no connector is registered under', () => {
    const values = targetSystemOptions(connectors, ['active-directory', 'entra-id', undefined]).map(
      (o) => o.value,
    );
    expect(values).toEqual(['active-directory', 'entra-id', 'okta']);
  });

  it('keeps the value the filter already holds', () => {
    const values = targetSystemOptions([], [], 'servicenow').map((o) => o.value);
    expect(values).toEqual(['servicenow']);
  });
});
