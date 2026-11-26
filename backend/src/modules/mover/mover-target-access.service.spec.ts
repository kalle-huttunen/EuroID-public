/**
 * The mover's change per target, against mocked connector services: which account is the
 * identity's (its target account record, else the identifiers provisioning used, never an HR
 * source's id), what is already as the policies want it, and the memberships EuroID refuses to
 * change. Entra ID keeps its provisioning path with the profile read here.
 */
import { HttpStatus } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import type { MoverAccessOperation } from '@shared/types/mover';
import type { ConfigActivities } from '../../activities/config.activities';
import type { EntraActivities } from '../../activities/entra.activities';
import type { AdService } from '../connectors/ad-connector/ad.service';
import type { OktaService } from '../connectors/okta-connector/okta.service';
import type { SCIMService } from '../connectors/scim-connector/scim.service';
import type { IdentityService } from '../identity/identity.service';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { MoverTargetAccessService } from './mover-target-access.service';

const TENANT = 'tenant-a';
const EMAIL = 'ada@acme.test';
const AD_CONFIG = { host: 'ldap.acme.test', baseDn: 'DC=acme,DC=test' };
const SCIM_CONFIG = { baseUrl: 'https://scim.acme.test/v2', authType: 'bearer' };
const USER_DN = 'CN=Ada Lovelace,OU=Users,DC=acme,DC=test';
const SALES_DN = 'CN=Sales,OU=Groups,DC=acme,DC=test';
const ENG_DN = 'CN=Engineering,OU=Groups,DC=acme,DC=test';

const remove = (targetId: string): MoverAccessOperation => ({
  type: 'group',
  action: 'remove',
  targetId,
});
const add = (targetId: string): MoverAccessOperation => ({
  type: 'group',
  action: 'add',
  targetId,
});

function identity(sources: Array<Record<string, unknown>> = []): IdentityDocument {
  return {
    _id: 'id-1',
    profile: { email: EMAIL, userPrincipalName: 'ada@corp.acme.test', departmentName: 'Eng' },
    sources: [
      // An HR source never names a target account, even with a matching name
      { sourceName: 'okta', externalId: 'E-1001', sourceRole: 'primary-hr' },
      ...sources,
    ],
  } as unknown as IdentityDocument;
}

const target = (sourceName: string, externalId: string) => ({
  sourceName,
  externalId,
  sourceRole: 'target',
});

function setup() {
  const identityService = {
    buildProfileWithContractsForPolicy: jest.fn(async () => ({
      email: EMAIL,
      departmentName: 'Eng',
    })),
  };
  const configs: Record<string, unknown> = {
    'entra-id': { tenantId: 'entra-tenant' },
    ad: AD_CONFIG,
    scim: SCIM_CONFIG,
  };
  const configActivities = {
    getConnectorConfig: jest.fn(async (id: string) => configs[id] ?? null),
  };
  const entraActivities = { provisionUserToEntra: jest.fn(async () => ({ success: true })) };
  const adService = {
    getUserGroupDns: jest.fn(async (_c: unknown, dn: string) =>
      dn === USER_DN ? [SALES_DN] : null,
    ),
    getUserByEmail: jest.fn(async () => null as { id: string } | null),
    addUserToGroup: jest.fn(async () => undefined),
    removeGroupMember: jest.fn(async () => 'removed' as const),
  };
  const oktaService = {
    listUserGroups: jest.fn(async (id: string) =>
      id === '00u1'
        ? [
            { id: '00g-sales', type: 'OKTA_GROUP', profile: { name: 'Sales' } },
            { id: '00g-app', type: 'APP_GROUP', profile: { name: 'App' } },
          ]
        : null,
    ),
    findUserIdByLogin: jest.fn(async () => null as string | null),
    addGroupMember: jest.fn(async () => undefined),
    removeGroupMember: jest.fn(async () => undefined),
  };
  const scimService = {
    getUserGroups: jest.fn(
      async (_c: unknown, id: string) =>
        (id === 'scim-1' ? [{ value: 'grp-sales', type: 'direct' }] : null) as
          | Array<{ value: string; type?: string }>
          | null
          | undefined,
    ),
    findUserIdByIdentifiers: jest.fn(async () => null as string | null),
    addGroupMember: jest.fn(async () => 'added' as const),
    removeGroupMember: jest.fn(async () => 'removed' as const),
  };
  const service = new MoverTargetAccessService(
    identityService as unknown as IdentityService,
    configActivities as unknown as ConfigActivities,
    entraActivities as unknown as EntraActivities,
    adService as unknown as AdService,
    oktaService as unknown as OktaService,
    scimService as unknown as SCIMService,
  );
  return {
    service,
    identityService,
    configs,
    configActivities,
    entraActivities,
    adService,
    oktaService,
    scimService,
  };
}

async function expect422(promise: Promise<unknown>, text: string) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConnectorException);
  expect((error as ConnectorException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  expect((error as Error).message).toContain(text);
}

describe('MoverTargetAccessService', () => {
  describe('Entra ID', () => {
    it('runs the Entra provisioning path with the policy profile it reads and the canvas config', async () => {
      const { service, entraActivities, identityService } = setup();
      const ops = [
        remove('g-sales'),
        add('g-eng'),
        { type: 'license', action: 'add', targetId: 'E5' },
      ];
      // What Entra ID did with each change: the counts follow it
      entraActivities.provisionUserToEntra.mockResolvedValueOnce({
        success: true,
        operations: [
          { ...remove('g-sales'), outcome: 'applied' },
          { ...add('g-eng'), outcome: 'unchanged' },
          { type: 'license', action: 'add', targetId: 'E5', outcome: 'applied' },
        ],
      } as never);

      await expect(
        service.apply('entra', identity(), ops as MoverAccessOperation[], TENANT, 'wf-1'),
      ).resolves.toEqual({ changed: 2, unchanged: 1 });

      expect(identityService.buildProfileWithContractsForPolicy).toHaveBeenCalled();
      // With the identity's id, so the provisioning events go under it (timeline, 2.8a)
      expect(entraActivities.provisionUserToEntra).toHaveBeenCalledWith(
        { email: EMAIL, departmentName: 'Eng', _id: 'id-1' },
        { operations: ops },
        { tenantId: 'entra-tenant' },
        TENANT,
        'wf-1',
        undefined, // no Entra ID account record: the activity finds the account itself
        true, // the identity has an account there: found, never created
      );
    });

    // The sync PATCH /identity/:id?syncToEntra=true asked for, in a run that changes no access
    it('updates only the account with the current profile when there is no change', async () => {
      const { service, entraActivities } = setup();
      entraActivities.provisionUserToEntra.mockResolvedValueOnce({ success: true } as never);

      await expect(service.apply('entra', identity(), [], TENANT, 'wf-1')).resolves.toEqual({
        changed: 0,
        unchanged: 0,
      });
      expect(entraActivities.provisionUserToEntra).toHaveBeenCalledWith(
        { email: EMAIL, departmentName: 'Eng', _id: 'id-1' },
        { operations: [] },
        { tenantId: 'entra-tenant' },
        TENANT,
        'wf-1',
        undefined,
        true,
      );
    });

    it("names the account by the identity's written-back object id", async () => {
      const { service, entraActivities } = setup();
      entraActivities.provisionUserToEntra.mockResolvedValueOnce({ success: true } as never);

      await service.apply('entra', identity([target('entra-id', 'obj-7')]), [], TENANT, 'wf-1');

      expect(entraActivities.provisionUserToEntra).toHaveBeenCalledWith(
        { email: EMAIL, departmentName: 'Eng', _id: 'id-1' },
        { operations: [] },
        { tenantId: 'entra-tenant' },
        TENANT,
        'wf-1',
        'obj-7',
        true,
      );
    });

    it('fails when Entra ID did not make a change (the activity throws), never counting it', async () => {
      const { service, entraActivities } = setup();
      const refused = new Error('entra-id: 1 of 1 changes failed (remove group g-sales: denied)');
      entraActivities.provisionUserToEntra.mockRejectedValueOnce(refused);

      await expect(
        service.apply('entra', identity(), [remove('g-sales')], TENANT, 'wf-1'),
      ).rejects.toBe(refused);
    });
  });

  describe('Active Directory', () => {
    it('changes the memberships of the account DN onboarding recorded', async () => {
      const { service, adService } = setup();

      const result = await service.apply(
        'ad',
        identity([target('ad', USER_DN)]),
        [remove(SALES_DN), add(ENG_DN)],
        TENANT,
      );

      expect(result).toEqual({ changed: 2, unchanged: 0 });
      expect(adService.removeGroupMember).toHaveBeenCalledWith(AD_CONFIG, USER_DN, SALES_DN);
      expect(adService.addUserToGroup).toHaveBeenCalledWith(AD_CONFIG, USER_DN, ENG_DN);
      expect(adService.getUserByEmail).not.toHaveBeenCalled();
    });

    it('leaves what is already as wanted (DNs compared without case and spacing)', async () => {
      const { service, adService } = setup();

      const result = await service.apply(
        'ad',
        identity([target('active-directory', USER_DN)]),
        [remove(ENG_DN), add('cn=sales, ou=groups, dc=acme, dc=test')],
        TENANT,
      );

      expect(result).toEqual({ changed: 0, unchanged: 2 });
      expect(adService.removeGroupMember).not.toHaveBeenCalled();
      expect(adService.addUserToGroup).not.toHaveBeenCalled();
    });

    it('finds the account by email when the recorded DN no longer exists', async () => {
      const { service, adService } = setup();
      adService.getUserByEmail.mockResolvedValue({ id: USER_DN });

      await service.apply(
        'ad',
        identity([target('ad', 'CN=Old,OU=Users,DC=acme,DC=test')]),
        [add(ENG_DN)],
        TENANT,
      );

      expect(adService.getUserByEmail).toHaveBeenCalledWith(AD_CONFIG, EMAIL);
      expect(adService.addUserToGroup).toHaveBeenCalledWith(AD_CONFIG, USER_DN, ENG_DN);
    });

    it('fails without changing anything when no account is found, or without a config', async () => {
      const { service, adService, configs } = setup();
      await expect422(service.apply('ad', identity(), [add(ENG_DN)], TENANT), 'No AD account');
      delete configs.ad;
      await expect(service.apply('ad', identity(), [add(ENG_DN)], TENANT)).rejects.toThrow(
        'AD connector config not found',
      );
      expect(adService.addUserToGroup).not.toHaveBeenCalled();
    });
  });

  describe('Okta', () => {
    it('adds and removes OKTA_GROUP memberships of the recorded account', async () => {
      const { service, oktaService } = setup();

      const result = await service.apply(
        'okta',
        identity([target('okta', '00u1')]),
        [remove('00g-sales'), remove('00g-gone'), add('00g-eng')],
        TENANT,
      );

      expect(result).toEqual({ changed: 2, unchanged: 1 });
      expect(oktaService.listUserGroups).toHaveBeenCalledWith('00u1');
      expect(oktaService.removeGroupMember).toHaveBeenCalledWith('00g-sales', '00u1');
      expect(oktaService.addGroupMember).toHaveBeenCalledWith('00g-eng', '00u1');
      expect(oktaService.findUserIdByLogin).not.toHaveBeenCalled();
    });

    it('finds the account by login (the email) without a recorded id, never by an HR id', async () => {
      const { service, oktaService } = setup();
      oktaService.findUserIdByLogin.mockResolvedValue('00u1');

      await service.apply('okta', identity(), [add('00g-eng')], TENANT);

      expect(oktaService.listUserGroups).not.toHaveBeenCalledWith('E-1001');
      expect(oktaService.findUserIdByLogin).toHaveBeenCalledWith(EMAIL);
      expect(oktaService.addGroupMember).toHaveBeenCalledWith('00g-eng', '00u1');
    });

    it('refuses to remove a membership Okta does not let the Groups API change', async () => {
      const { service, oktaService } = setup();
      await expect422(
        service.apply('okta', identity([target('okta', '00u1')]), [remove('00g-app')], TENANT),
        'APP_GROUP',
      );
      expect(oktaService.removeGroupMember).not.toHaveBeenCalled();
    });

    it('fails when Okta has no account for the identity', async () => {
      const { service, oktaService } = setup();
      await expect422(
        service.apply('okta', identity(), [add('00g-eng')], TENANT),
        'No Okta account',
      );
      expect(oktaService.addGroupMember).not.toHaveBeenCalled();
    });
  });

  describe('SCIM', () => {
    it("changes the recorded user's memberships, leaving what is already as wanted", async () => {
      const { service, scimService } = setup();

      const result = await service.apply(
        'scim',
        identity([target('scim', 'scim-1')]),
        [remove('grp-sales'), remove('grp-gone'), add('grp-eng'), add('grp-sales')],
        TENANT,
      );

      expect(result).toEqual({ changed: 2, unchanged: 2 });
      expect(scimService.removeGroupMember).toHaveBeenCalledTimes(1);
      expect(scimService.removeGroupMember).toHaveBeenCalledWith(
        SCIM_CONFIG,
        'grp-sales',
        'scim-1',
      );
      expect(scimService.addGroupMember).toHaveBeenCalledTimes(1);
      expect(scimService.addGroupMember).toHaveBeenCalledWith(SCIM_CONFIG, 'grp-eng', 'scim-1');
    });

    it('asks the groups when the target does not return memberships on the user', async () => {
      const { service, scimService } = setup();
      scimService.getUserGroups.mockResolvedValue(undefined);
      scimService.removeGroupMember.mockResolvedValue('not-member' as never);

      const result = await service.apply(
        'scim',
        identity([target('scim', 'scim-1')]),
        [remove('grp-sales'), add('grp-eng')],
        TENANT,
      );

      expect(result).toEqual({ changed: 1, unchanged: 1 });
      expect(scimService.removeGroupMember).toHaveBeenCalled();
      expect(scimService.addGroupMember).toHaveBeenCalled();
    });

    it('finds the user by the identifiers provisioning used without a recorded id', async () => {
      const { service, scimService } = setup();
      scimService.findUserIdByIdentifiers.mockResolvedValue('scim-1');

      await service.apply('scim', identity(), [add('grp-eng')], TENANT);

      expect(scimService.findUserIdByIdentifiers).toHaveBeenCalledWith(SCIM_CONFIG, {
        userNames: ['ada@corp.acme.test', EMAIL],
        emails: [EMAIL],
      });
      expect(scimService.addGroupMember).toHaveBeenCalledWith(SCIM_CONFIG, 'grp-eng', 'scim-1');
    });

    it('refuses to remove a nested membership, and fails without an account', async () => {
      const { service, scimService } = setup();
      scimService.getUserGroups.mockResolvedValue([{ value: 'grp-sales', type: 'indirect' }]);
      await expect422(
        service.apply('scim', identity([target('scim', 'scim-1')]), [remove('grp-sales')], TENANT),
        'Nested membership',
      );
      scimService.getUserGroups.mockResolvedValue(null);
      await expect422(
        service.apply('scim', identity(), [add('grp-eng')], TENANT),
        'No SCIM account',
      );
      expect(scimService.removeGroupMember).not.toHaveBeenCalled();
      expect(scimService.addGroupMember).not.toHaveBeenCalled();
    });
  });
});
