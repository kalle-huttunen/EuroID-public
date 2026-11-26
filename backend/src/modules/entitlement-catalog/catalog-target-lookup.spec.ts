/**
 * The catalog entry a policy target stands for. A role-based rule (or an SoD policy) names a group
 * as it likes, often by display name, while the catalog, access requests and the access graph key
 * it by its native id. Intelligence (HeldAccessService) and the access graph (resync, event sync,
 * SoD check) resolve a target through this one rule, so a group is one entitlement however it was
 * granted (FOLLOWUPS 2026-11-25, graph-resync.service.ts:242).
 */
import { catalogTargetLookup, loadCatalogTargetLookup } from './catalog-target-lookup';

const entry = (system: string, nativeId: string, name: string) => ({ system, nativeId, name });

describe('catalogTargetLookup', () => {
  const lookup = catalogTargetLookup([
    entry('entra-id', 'guid-sales', 'SG-Sales'),
    entry('entra-id', 'guid-shared-1', 'SG-Shared'),
    entry('entra-id', 'guid-shared-2', 'SG-Shared'),
    entry('okta', 'okta-sales', 'SG-Sales'),
    // One entry's native id is another entry's name
    entry('entra-id', 'CRM users', 'CRM (legacy)'),
    entry('entra-id', 'guid-crm', 'CRM users'),
    entry('ad', 'sid-admins', 'GG-Admins'),
  ]);

  it('takes every name of one system as that system: entra and entraid as entra-id, active-directory as ad', () => {
    // A rule's target is free text; SodService and the PAM filter read these names as one system
    expect(lookup({ system: 'entra', targetId: 'SG-Sales' })?.nativeId).toBe('guid-sales');
    expect(lookup({ system: 'EntraID', targetId: 'guid-sales' })?.nativeId).toBe('guid-sales');
    expect(lookup({ system: 'active-directory', targetId: 'GG-Admins' })?.nativeId).toBe(
      'sid-admins',
    );
    expect(lookup({ system: 'Okta', targetId: 'SG-Sales' })?.nativeId).toBe('okta-sales');
  });

  it('finds the entry that has the target id as its native id on the system', () => {
    expect(lookup({ system: 'entra-id', targetId: 'guid-sales' })).toEqual(
      entry('entra-id', 'guid-sales', 'SG-Sales'),
    );
  });

  it('else the one entry that has the target id as its name on the system', () => {
    expect(lookup({ system: 'entra-id', targetId: 'SG-Sales' })).toEqual(
      entry('entra-id', 'guid-sales', 'SG-Sales'),
    );
    expect(lookup({ system: 'okta', targetId: 'SG-Sales' })?.nativeId).toBe('okta-sales');
  });

  it('takes the native id before a name', () => {
    expect(lookup({ system: 'entra-id', targetId: 'CRM users' })?.nativeId).toBe('CRM users');
  });

  it('finds none for a name two entries have, a target it does not know, or another system', () => {
    expect(lookup({ system: 'entra-id', targetId: 'SG-Shared' })).toBeUndefined();
    expect(lookup({ system: 'entra-id', targetId: 'SG-Unknown' })).toBeUndefined();
    expect(lookup({ system: 'ad', targetId: 'SG-Sales' })).toBeUndefined();
  });
});

describe('loadCatalogTargetLookup', () => {
  it("reads only the tenant's entries with a native id that the targets can resolve to", async () => {
    const find = jest.fn((_filter: Record<string, unknown>) => ({
      select: () => ({
        lean: () => ({ exec: async () => [entry('entra-id', 'guid-sales', 'SG-Sales')] }),
      }),
    }));

    const lookup = await loadCatalogTargetLookup({ find } as never, 'tenant-a', [
      { system: 'entra-id', targetId: 'SG-Sales' },
      { system: 'entra-id', targetId: 'guid-crm' },
      { system: 'okta', targetId: 'SG-Sales' },
    ]);

    expect(find).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      system: { $in: ['entra-id', 'okta'] },
      nativeId: { $type: 'string', $ne: '' },
      $or: [
        { nativeId: { $in: ['SG-Sales', 'guid-crm'] } },
        { name: { $in: ['SG-Sales', 'guid-crm'] } },
      ],
    });
    expect(lookup({ system: 'entra-id', targetId: 'SG-Sales' })?.nativeId).toBe('guid-sales');
    expect(lookup({ system: 'okta', targetId: 'SG-Sales' })).toBeUndefined();
  });

  it('reads the catalog under the name it stores for a system a rule names otherwise', async () => {
    const find = jest.fn((_filter: Record<string, unknown>) => ({
      select: () => ({
        lean: () => ({ exec: async () => [entry('entra-id', 'guid-sales', 'SG-Sales')] }),
      }),
    }));

    const lookup = await loadCatalogTargetLookup({ find } as never, 'tenant-a', [
      { system: 'entra', targetId: 'SG-Sales' },
      { system: 'active-directory', targetId: 'GG-Admins' },
    ]);

    expect(find.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        system: { $in: expect.arrayContaining(['entra-id', 'ad']) },
      }),
    );
    expect(lookup({ system: 'entra', targetId: 'SG-Sales' })?.nativeId).toBe('guid-sales');
  });

  it('reads nothing without a target', async () => {
    const find = jest.fn();

    const lookup = await loadCatalogTargetLookup({ find } as never, 'tenant-a', []);

    expect(find).not.toHaveBeenCalled();
    expect(lookup({ system: 'entra-id', targetId: 'SG-Sales' })).toBeUndefined();
  });
});
