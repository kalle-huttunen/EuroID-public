/**
 * The Entra ID part of the live impact analysis (POST /blueprints/impact-analysis). Its licenses
 * ("O365_E3, 250 available"), groups ("All-Staff"), Microsoft 365 groups and conditional access
 * policies were hard-coded, so operators saw invented data as an impact preview (r2-05 N9). They
 * now come from the policy intent the analysis computed (the entra-id delta's entitlement
 * changes), with names and license availability from the entitlement catalog, and the answer
 * says what EuroID does not know.
 */
import type { Model } from 'mongoose';
import { ImpactEntraMetadataService } from './impact-entra-metadata.service';
import type { BlueprintsService } from './blueprints.service';
import type { EntraService } from '../connectors/entra-connector/entra.service';
import type { EntitlementCatalogDocument } from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import type { ImpactDelta } from './impact-analysis.types';
import { withTestTenant } from '@testing/test-helpers';

const FINANCE = '0b3c1a52-1d2e-4f60-8a71-2b3c4d5e6f70';
const READER = 'f2ef992c-3afb-46b9-b7cf-a126ee74c451';

const CATALOG = [
  { system: 'entra-id', nativeId: FINANCE, name: 'Finance Team', type: 'Group' },
  {
    system: 'entra-id',
    nativeId: 'ENTERPRISEPACK',
    name: 'ENTERPRISEPACK',
    type: 'License',
    licenseUnits: { consumed: 95, enabled: 100, observedAt: new Date('2026-11-25') },
  },
  { system: 'entra-id', nativeId: 'POWER_BI_PRO', name: 'POWER_BI_PRO', type: 'License' },
  { system: 'entra-id', nativeId: READER, name: 'Global Reader', type: 'DirectoryRole' },
];

const ada = {
  _id: 'identity-ada',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@corp.example',
};
const bob = {
  _id: 'identity-bob',
  firstName: 'Bob',
  lastName: 'Builder',
  email: 'bob@corp.example',
};

const delta = (userId: string, targetSystem: string, changes: ImpactDelta['entitlementChanges']) =>
  ({
    userId,
    email: '',
    upn: '',
    displayName: '',
    operation: 'CREATE',
    targetSystem,
    changes: [],
    entitlementChanges: changes,
    riskLevel: 'low',
    riskReasons: [],
  }) as ImpactDelta;

const add = (type: 'group' | 'license' | 'role', targetId: string) => ({
  type,
  action: 'add' as const,
  targetId,
  targetName: targetId,
});

describe('ImpactEntraMetadataService', () => {
  const find = jest.fn();
  const catalogModel = { find };
  const service = new ImpactEntraMetadataService(
    {
      getConnectorConfigForImpact: jest.fn().mockResolvedValue(null),
    } as unknown as BlueprintsService,
    {} as EntraService,
    catalogModel as unknown as Model<EntitlementCatalogDocument>,
  );

  beforeEach(() => {
    find.mockReset().mockReturnValue({
      select: () => ({ lean: () => ({ exec: () => Promise.resolve(CATALOG) }) }),
    });
  });

  it('gives each person the groups and licenses the policy assigns them in Entra ID', async () => {
    const deltas = [
      delta('identity-ada', 'entra-id', [
        add('group', FINANCE),
        add('group', 'Contractors'),
        add('license', 'ENTERPRISEPACK'),
        add('license', 'POWER_BI_PRO'),
      ]),
      // Another target's intent is not Entra ID's
      delta('identity-ada', 'ad', [add('group', 'CN=Domain Users')]),
    ];

    const [meta] = await withTestTenant(() => service.generate([ada], true, deltas));

    expect(meta.groups).toEqual(['Finance Team', 'Contractors']);
    expect(meta.licenses).toEqual([
      { sku: 'ENTERPRISEPACK', name: 'ENTERPRISEPACK', assigned: true, available: 5 },
      { sku: 'POWER_BI_PRO', name: 'POWER_BI_PRO', assigned: true, available: null },
    ]);
    expect(meta).not.toHaveProperty('conditionalAccessPolicies');
    expect(meta).not.toHaveProperty('o365Groups');
    expect(meta).not.toHaveProperty('securityGroups');
    expect(meta.notKnown).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/conditional access/i),
        expect.stringMatching(/POWER_BI_PRO.*discovery/),
        expect.stringMatching(/Contractors.*not in the entitlement catalog/),
      ]),
    );
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ system: 'entra-id' }));
  });

  it('gives a person the policy assigns nothing in Entra ID no groups and no licenses', async () => {
    const [meta] = await withTestTenant(() =>
      service.generate([bob], true, [delta('identity-ada', 'entra-id', [add('group', FINANCE)])]),
    );

    expect(meta.groups).toEqual([]);
    expect(meta.licenses).toEqual([]);
    expect(meta.roles).toEqual([]);
    expect(meta.notKnown).toEqual([
      expect.stringMatching(/^UPN: not known/),
      expect.stringMatching(/conditional access/i),
    ]);
  });

  // HX-F2 follow-up: computeUserDelta typed every operation but a license as a group, so a
  // directory role the policy assigns was listed among the groups.
  it('lists the directory roles the policy assigns in their own list, not among the groups', async () => {
    const deltas = [
      delta('identity-ada', 'entra-id', [
        add('group', FINANCE),
        add('role', READER),
        add('role', 'Billing Administrator'),
      ]),
    ];

    const [meta] = await withTestTenant(() => service.generate([ada], true, deltas));

    expect(meta.groups).toEqual(['Finance Team']);
    expect(meta.roles).toEqual(['Global Reader', 'Billing Administrator']);
    expect(meta.notKnown).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /Directory role Billing Administrator.*not in the entitlement catalog/,
        ),
      ]),
    );
  });

  // HX-F2 follow-up: without an Entra ID config the preview showed firstname.lastname@euroid.com,
  // an invented domain, as the person's UPN, marked valid.
  it('shows the UPN as not known without an Entra ID config, never on an invented domain', async () => {
    const [meta] = await withTestTenant(() => service.generate([ada], false, []));

    expect(meta.upn).toBeNull();
    expect(meta.upnStatus).toBe('unknown');
    expect(meta.notKnown).toEqual(
      expect.arrayContaining([expect.stringMatching(/^UPN: not known/)]),
    );
    expect(JSON.stringify(meta)).not.toContain('euroid.com');
  });

  it('shows the UPN on the default domain of the Entra ID config in a dry run', async () => {
    const configured = new ImpactEntraMetadataService(
      {
        getConnectorConfigForImpact: jest.fn().mockResolvedValue({ defaultDomain: 'corp.example' }),
      } as unknown as BlueprintsService,
      {} as EntraService,
      catalogModel as unknown as Model<EntitlementCatalogDocument>,
    );

    const [meta] = await withTestTenant(() => configured.generate([ada], true, []));

    expect(meta.upn).toBe('ada.lovelace@corp.example');
    expect(meta.notKnown).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^UPN: not known/)]),
    );
  });
});
