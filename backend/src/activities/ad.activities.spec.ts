import { ApplicationFailure } from '@temporalio/common';
import { Test } from '@nestjs/testing';
import { AdActivities } from './ad.activities';
import { AdService } from '../modules/connectors/ad-connector/ad.service';
import { AdClient } from '../modules/connectors/ad-connector/ad.client';
import { AccountNameService } from '../modules/connectors/ad-connector/account-name.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import { CredentialGenerationService } from '@infrastructure/secrets/credential-generation.service';
import { createMockUser } from '@testing/mock-factories';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import type { AdConfig, ProvisioningIntent } from '../modules/connectors/ad-connector/ad.interface';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import type { DomainEventType } from '@infrastructure/events/event-types';

const mockAdConfig = {
  host: 'ldap.example.com',
  baseDn: 'ou=users,dc=example,dc=com',
  rootBaseDn: 'dc=example,dc=com',
  serviceAccount: 'CN=svc,OU=Users,DC=example,DC=com',
  password: 'test-password',
};

describe('AdActivities', () => {
  let activities: AdActivities;
  let adService: jest.Mocked<Partial<AdService>>;
  let eventEmitter: { emit: jest.Mock };
  let adClient: { healthCheckEnriched: jest.Mock; searchUsers: jest.Mock };

  beforeEach(async () => {
    adService = {
      provision: jest.fn(),
      addUserToGroup: jest.fn(),
      getUserGroupDns: jest.fn(),
      removeGroupMember: jest.fn(),
      healthCheck: jest.fn(),
      deprovision: jest.fn(),
      deprovisionUser: jest.fn(),
      discover: jest.fn(),
    };

    adClient = {
      healthCheckEnriched: jest.fn(),
      searchUsers: jest.fn().mockResolvedValue([]),
    };

    eventEmitter = { emit: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        AdActivities,
        AccountNameService,
        { provide: AdService, useValue: adService },
        { provide: AdClient, useValue: adClient },
        { provide: DomainEventEmitterService, useValue: eventEmitter },
        { provide: EntitlementCatalogService, useValue: { absorbDiscovered: jest.fn() } },
        {
          provide: CredentialGenerationService,
          useValue: { generatePassword: jest.fn().mockReturnValue('MockP@ss123!') },
        },
      ],
    }).compile();

    activities = module.get(AdActivities);
  });

  describe('provisionUserToAd', () => {
    it('should return success with objectId on happy path', async () => {
      const user = createMockUser();
      (adService.provision as jest.Mock).mockResolvedValue({
        targetUserId: 'cn=john,ou=users,dc=example,dc=com',
        generatedAttributes: { mail: 'john@example.com' },
      });

      const result = await activities.provisionUserToAd(
        user,
        undefined,
        mockAdConfig,
        TEST_TENANT_ID,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.objectId).toContain('cn=john');
        expect(result.skipped).toBe(false);
      }
    });

    it('should return skipped when config missing host or baseDn', async () => {
      const user = createMockUser();
      const invalidConfig = { host: '', baseDn: '' } as AdConfig;

      const result = await activities.provisionUserToAd(
        user,
        undefined,
        invalidConfig,
        TEST_TENANT_ID,
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.skipped).toBe(true);
        expect(result.error).toContain('AD config missing');
      }
    });

    it('should throw on LDAP error (Temporal retries)', async () => {
      const user = createMockUser();
      (adService.provision as jest.Mock).mockRejectedValue(new Error('LDAP bind failed'));

      await expect(
        activities.provisionUserToAd(user, undefined, mockAdConfig, TEST_TENANT_ID),
      ).rejects.toThrow('LDAP bind failed');
    });

    it('should emit PROVISIONING_FAILED event before throwing on error', async () => {
      const user = createMockUser();
      (adService.provision as jest.Mock).mockRejectedValue(new Error('Network timeout'));

      await expect(
        activities.provisionUserToAd(user, undefined, mockAdConfig, TEST_TENANT_ID),
      ).rejects.toThrow('Network timeout');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'provisioning.failed',
        'test-user-id-001',
        expect.objectContaining({
          identityId: 'test-user-id-001',
          connector: 'ad',
          error: 'Network timeout',
          retryable: true,
        }),
      );
    });

    it('reports a failure for a profile without an id under the connector, with no email', async () => {
      (adService.provision as jest.Mock).mockRejectedValue(
        new Error('UPN john.doe@example.com already in use'),
      );

      await expect(
        activities.provisionUserToAd(
          createMockUser({ _id: undefined }),
          undefined,
          mockAdConfig,
          TEST_TENANT_ID,
        ),
      ).rejects.toThrow();

      const [, aggregateId, payload] = eventEmitter.emit.mock.calls[0];
      expect(aggregateId).toBe('ad');
      expect(payload).not.toHaveProperty('identityId');
      expect(JSON.stringify(payload)).not.toContain('john.doe@example.com');
    });
  });

  describe("provisionUserToAd: the intent's group changes (plan 2.0dm for AD)", () => {
    const dn = 'CN=Ada Lovelace,OU=Users,DC=example,DC=com';
    const sales = 'CN=Sales,OU=Groups,DC=example,DC=com';
    const finance = 'CN=Finance,OU=Groups,DC=example,DC=com';
    const old = 'CN=Old Team,OU=Groups,DC=example,DC=com';
    const provision = (operations: ProvisioningIntent['operations']) =>
      activities.provisionUserToAd(createMockUser(), { operations }, mockAdConfig, TEST_TENANT_ID);

    beforeEach(() => {
      (adService.provision as jest.Mock).mockResolvedValue({
        targetUserId: dn,
        generatedAttributes: { distinguishedName: dn },
      });
      // The account's direct groups: Sales and the old team
      (adService.getUserGroupDns as jest.Mock).mockResolvedValue([sales, old.toLowerCase()]);
      (adService.removeGroupMember as jest.Mock).mockResolvedValue('removed');
    });

    it('applies the removals and reports each change: applied or already so', async () => {
      const result = await provision([
        { type: 'group', action: 'remove', targetId: old },
        { type: 'group', action: 'add', targetId: sales },
        { type: 'group', action: 'add', targetId: finance },
      ]);

      expect(adService.removeGroupMember).toHaveBeenCalledWith(mockAdConfig, dn, old);
      expect(adService.addUserToGroup).toHaveBeenCalledTimes(1);
      expect(adService.addUserToGroup).toHaveBeenCalledWith(mockAdConfig, dn, finance);
      expect(result.success && result.operations).toEqual([
        { type: 'group', action: 'remove', targetId: old, outcome: 'applied' },
        { type: 'group', action: 'add', targetId: sales, outcome: 'unchanged' },
        { type: 'group', action: 'add', targetId: finance, outcome: 'applied' },
      ]);
    });

    it('reports a removal of a group the account is not in as already so', async () => {
      const result = await provision([{ type: 'group', action: 'remove', targetId: finance }]);

      expect(adService.removeGroupMember).not.toHaveBeenCalled();
      expect(result.success && result.operations?.[0].outcome).toBe('unchanged');
    });

    it('emits provisioning.completed under the identity, without the DN', async () => {
      await provision([{ type: 'group', action: 'add', targetId: finance }]);

      const [type, aggregateId, payload] = eventEmitter.emit.mock.calls[0];
      expect(type).toBe('provisioning.completed');
      expect(aggregateId).toBe('test-user-id-001');
      expect(payload).toEqual({
        identityId: 'test-user-id-001',
        connector: 'ad',
        operations: [{ action: 'add', type: 'group', targetId: finance, success: true }],
        durationMs: expect.any(Number),
      });
      expect(JSON.stringify(payload)).not.toContain('Ada Lovelace');
      expect(EVENT_SCHEMAS['provisioning.completed' as DomainEventType]!.parse(payload)).toEqual(
        payload,
      );
    });

    it('fails the target when AD refuses a group add, after making the other changes', async () => {
      (adService.addUserToGroup as jest.Mock).mockRejectedValue(
        new Error(`Insufficient access rights to modify ${finance} for ${dn}`),
      );

      const error = await provision([
        { type: 'group', action: 'remove', targetId: old },
        { type: 'group', action: 'add', targetId: finance },
      ]).catch((e: unknown) => e);

      expect(adService.removeGroupMember).toHaveBeenCalledWith(mockAdConfig, dn, old);
      // An LDAP error has no HTTP status: retried by Temporal, the retry makes what is left
      expect(error).not.toBeInstanceOf(ApplicationFailure);
      expect((error as Error).message).toBe(
        `ad: 1 of 2 changes failed (add group ${finance}: Insufficient access rights to modify ` +
          'CN=•••,OU=Groups,DC=example,DC=com for CN=•••,OU=Users,DC=example,DC=com). The other ' +
          'changes were made or were already as requested.',
      );
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith('provisioning.failed', 'test-user-id-001', {
        identityId: 'test-user-id-001',
        connector: 'ad',
        error: (error as Error).message,
        retryable: true,
        partialFailure: true,
      });
    });

    it('fails without retry when a group change is refused with a client error', async () => {
      (adService.removeGroupMember as jest.Mock).mockRejectedValue(
        new ConnectorException('AD config invalid: missing host or base DN'),
      );

      const error = await provision([{ type: 'group', action: 'remove', targetId: old }]).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).nonRetryable).toBe(true);
      expect((error as ApplicationFailure).type).toBe('AdChangesFailed');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'provisioning.failed',
        'test-user-id-001',
        expect.objectContaining({ retryable: false, partialFailure: true }),
      );
    });
  });

  // A rerun for a person whose account exists picked "<sam>1" and wrote it back (FOLLOWUPS
  // 2026-11-24, ad.activities.ts resolveUniqueSam)
  describe('provisionUserToAd for a person whose AD account exists', () => {
    const own = {
      dn: 'CN=John Doe,DC=example,DC=com',
      sAMAccountName: 'johndoe',
      userPrincipalName: 'john.doe@example.com',
      mail: 'john.doe@example.com',
    };
    type Account = typeof own;
    /** AD answers each search with the accounts its filter names. */
    const directory = (...accounts: Account[]) =>
      adClient.searchUsers.mockImplementation(async (_c: unknown, _b: unknown, filter: string) =>
        accounts.filter(
          (a) =>
            filter.includes(`(sAMAccountName=${a.sAMAccountName})`) ||
            filter.includes(`(userPrincipalName=${a.userPrincipalName})`) ||
            filter.includes(`(distinguishedName=${a.dn})`),
        ),
      );

    beforeEach(() => {
      // As AdService on LDAP 68: the DN it would create exists, so it answers that DN with the
      // names it was given
      (adService.provision as jest.Mock).mockImplementation(
        async (_c: unknown, user: { samAccountName?: string; userPrincipalName?: string }) => ({
          targetUserId: own.dn,
          generatedAttributes: {
            samAccountName: user.samAccountName,
            userPrincipalName: user.userPrincipalName,
            distinguishedName: own.dn,
          },
        }),
      );
    });

    it('keeps the sAMAccountName and DN of the account an earlier attempt created', async () => {
      directory(own);

      const result = await activities.provisionUserToAd(
        createMockUser(),
        undefined,
        mockAdConfig,
        TEST_TENANT_ID,
      );

      expect(result.success && result.objectId).toBe(own.dn);
      expect(result.success && result.generatedAttributes).toEqual({
        mail: own.mail,
        userPrincipalName: own.userPrincipalName,
        samAccountName: 'johndoe',
        distinguishedName: own.dn,
      });
      expect(adService.provision).not.toHaveBeenCalled();
    });

    it('finds the account by its UPN at another DN and creates none', async () => {
      const renamed = { ...own, dn: 'CN=Johnny Doe,DC=example,DC=com' };
      directory(renamed);
      (adService.getUserGroupDns as jest.Mock).mockResolvedValue([]);
      const sales = 'CN=Sales,OU=Groups,DC=example,DC=com';

      const result = await activities.provisionUserToAd(
        createMockUser(),
        { operations: [{ type: 'group', action: 'add', targetId: sales }] },
        mockAdConfig,
        TEST_TENANT_ID,
      );

      expect(adService.provision).not.toHaveBeenCalled();
      expect(adService.addUserToGroup).toHaveBeenCalledWith(mockAdConfig, renamed.dn, sales);
      expect(result.success && result.generatedAttributes).toMatchObject({
        samAccountName: 'johndoe',
        distinguishedName: renamed.dn,
      });
    });

    it('adds a suffix only to a name that another person holds', async () => {
      directory({
        dn: 'CN=Johan Doe,DC=example,DC=com',
        sAMAccountName: 'johndoe',
        userPrincipalName: 'johan.doe@example.com',
        mail: 'johan.doe@example.com',
      });

      await activities.provisionUserToAd(createMockUser(), undefined, mockAdConfig, TEST_TENANT_ID);

      expect(adService.provision).toHaveBeenCalledWith(
        mockAdConfig,
        expect.objectContaining({
          samAccountName: 'johndoe1',
          userPrincipalName: 'john.doe@example.com',
        }),
        undefined,
        'MockP@ss123!',
        'John Doe',
      );
    });

    // LDAP 68 adopted whatever held the planned DN (CN = display name), so a namesake in the
    // same OU got the first person's account and groups (FOLLOWUPS 2026-11-24, ad.client.ts)
    describe('a namesake in the same OU', () => {
      const namesake: Account = {
        dn: 'CN=John Doe,dc=example,dc=com',
        sAMAccountName: 'johndoe',
        userPrincipalName: 'john.doe@other.example',
        mail: 'john.doe@other.example',
      };
      const sales = 'CN=Sales,OU=Groups,DC=example,DC=com';
      const provisionWithGroup = () =>
        activities
          .provisionUserToAd(
            createMockUser(),
            { operations: [{ type: 'group', action: 'add', targetId: sales }] },
            mockAdConfig,
            TEST_TENANT_ID,
          )
          .catch((e: unknown) => e);

      beforeEach(() => {
        (adService.getUserGroupDns as jest.Mock).mockResolvedValue([]);
      });

      it('gets an account of their own under a free CN and sAMAccountName', async () => {
        directory(namesake);
        // As AdService: the account is created under the CN it is given
        type ProvisionArgs = [unknown, { samAccountName?: string }, unknown, unknown, string];
        (adService.provision as jest.Mock).mockImplementation(async (...args: unknown[]) => {
          const [, user, , , cn] = args as ProvisionArgs;
          return {
            targetUserId: `CN=${cn},dc=example,dc=com`,
            generatedAttributes: { samAccountName: user.samAccountName },
          };
        });

        const result = await provisionWithGroup();

        expect(adService.provision).toHaveBeenCalledWith(
          mockAdConfig,
          expect.objectContaining({ samAccountName: 'johndoe1' }),
          { operations: [{ type: 'group', action: 'add', targetId: sales }] },
          'MockP@ss123!',
          'John Doe 1',
        );
        expect(result).toMatchObject({
          success: true,
          objectId: 'CN=John Doe 1,dc=example,dc=com',
        });
        expect(adService.addUserToGroup).toHaveBeenCalledWith(
          mockAdConfig,
          'CN=John Doe 1,dc=example,dc=com',
          sales,
        );
        expect(adService.addUserToGroup).not.toHaveBeenCalledWith(
          expect.anything(),
          namesake.dn,
          expect.anything(),
        );
      });

      it("refuses, without retry, the namesake's account LDAP 68 answers with", async () => {
        // The namesake's account appears between the name check and the create
        let created = false;
        adClient.searchUsers.mockImplementation(async (_c: unknown, _b: unknown, f: string) =>
          created && f.includes(`(distinguishedName=${namesake.dn})`) ? [namesake] : [],
        );
        (adService.provision as jest.Mock).mockImplementation(async () => {
          created = true;
          return { targetUserId: namesake.dn, generatedAttributes: {} };
        });

        const error = await provisionWithGroup();

        expect(error).toBeInstanceOf(ApplicationFailure);
        expect((error as ApplicationFailure).nonRetryable).toBe(true);
        expect((error as ApplicationFailure).type).toBe('AdAccountNameTaken');
        expect((error as Error).message).toBe(
          "ad: CN=•••,dc=example,dc=com is another person's account (its UPN differs), so it " +
            'was not used. Run provisioning again to create the account under a free name.',
        );
        expect(adService.addUserToGroup).not.toHaveBeenCalled();
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'provisioning.failed',
          'test-user-id-001',
          expect.objectContaining({ retryable: false }),
        );
      });
    });
  });

  // AD errors other than group changes reached workflow history and errorMsg unmasked
  // (FOLLOWUPS 2026-11-24, ad.activities.ts)
  describe('provisionUserToAd failures outside group changes', () => {
    const provision = () =>
      activities
        .provisionUserToAd(createMockUser(), undefined, mockAdConfig, TEST_TENANT_ID)
        .catch((e: unknown) => e);

    it('masks DN names and emails, keeping the step and the LDAP result code', async () => {
      const ldapError = Object.assign(
        new Error('Insufficient access to CN=John Doe,DC=example,DC=com (john.doe@example.com)'),
        { code: 50 },
      );
      (adService.provision as jest.Mock).mockRejectedValue(ldapError);

      const error = await provision();

      // The same error object: Temporal retries it as before
      expect(error).toBe(ldapError);
      expect((error as Error).message).toBe(
        'ad: create the account failed (LDAP result 50): Insufficient access to ' +
          'CN=•••,DC=example,DC=com (j•••@example.com)',
      );
      expect((error as Error).stack).not.toContain('John Doe');
      expect((error as Error).stack).not.toContain('john.doe@example.com');
    });

    it('names a failed account search as such', async () => {
      adClient.searchUsers.mockRejectedValue(
        Object.assign(new Error('Operations error'), { code: 1 }),
      );

      const error = await provision();

      expect((error as Error).message).toBe(
        'ad: find the account failed (LDAP result 1): Operations error',
      );
      expect(adService.provision).not.toHaveBeenCalled();
    });

    it('keeps a client error from the connector a client error (not retried)', async () => {
      (adService.provision as jest.Mock).mockRejectedValue(
        new ConnectorException('AD config invalid: missing host or base DN'),
      );

      const error = await provision();

      expect(error).toBeInstanceOf(ConnectorException);
      expect((error as ConnectorException).getStatus()).toBe(400);
      expect((error as Error).message).toBe(
        'ad: create the account failed: AD config invalid: missing host or base DN',
      );
    });
  });

  describe('disableAdUser', () => {
    it('should return false when config is missing (not an error)', async () => {
      const result = await activities.disableAdUser('some-dn', undefined, TEST_TENANT_ID);
      expect(result).toBe(false);
    });

    it('should return true when deprovision succeeds', async () => {
      (adService.deprovision as jest.Mock).mockResolvedValue(true);

      const result = await activities.disableAdUser(
        'CN=user,OU=Users,DC=example,DC=com',
        mockAdConfig,
        TEST_TENANT_ID,
      );

      expect(result).toBe(true);
    });

    it('should throw on LDAP error (Temporal retries)', async () => {
      (adService.deprovision as jest.Mock).mockRejectedValue(new Error('LDAP connection lost'));

      await expect(
        activities.disableAdUser(
          'CN=user,OU=Users,DC=example,DC=com',
          mockAdConfig,
          TEST_TENANT_ID,
        ),
      ).rejects.toThrow('LDAP connection lost');
    });
  });

  describe('deprovisionAdUser (offboarding)', () => {
    const dn = 'CN=Ada Lovelace,OU=Users,DC=example,DC=com';

    it('returns what the connector did: disabled, or already gone for no such object', async () => {
      (adService.deprovisionUser as jest.Mock).mockResolvedValue({
        outcome: 'already-gone',
        detail: 'no such object',
      });

      await expect(activities.deprovisionAdUser(dn, mockAdConfig, TEST_TENANT_ID)).resolves.toEqual(
        { outcome: 'already-gone', detail: 'no such object' },
      );
      expect(adService.deprovisionUser).toHaveBeenCalledWith(mockAdConfig, dn);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('records a disabled account for the audit log under the identity, without the DN', async () => {
      (adService.deprovisionUser as jest.Mock).mockResolvedValue({
        outcome: 'deprovisioned',
        detail: 'disabled',
      });

      await activities.deprovisionAdUser(dn, mockAdConfig, TEST_TENANT_ID, 'corr-1', 'id-7');

      expect(eventEmitter.emit).toHaveBeenCalledWith('provisioning.deprovisioned', 'id-7', {
        identityId: 'id-7',
        connector: 'ad',
        detail: 'disabled',
      });
    });

    it('fails at once without a host', async () => {
      const error = await activities
        .deprovisionAdUser(dn, undefined, TEST_TENANT_ID)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).nonRetryable).toBe(true);
      expect(adService.deprovisionUser).not.toHaveBeenCalled();
    });

    it('masks the name in the DN of an LDAP error and leaves it for Temporal to retry', async () => {
      (adService.deprovisionUser as jest.Mock).mockRejectedValue(
        new Error(`Insufficient access to ${dn}`),
      );

      const error = await activities
        .deprovisionAdUser(dn, mockAdConfig, TEST_TENANT_ID)
        .catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(ApplicationFailure);
      expect((error as Error).message).toBe(
        'ad: Insufficient access to CN=•••,OU=Users,DC=example,DC=com',
      );
    });
  });

  describe('tenant context rejection', () => {
    it('should throw when tenantId is empty', async () => {
      const user = createMockUser();
      await expect(activities.provisionUserToAd(user, undefined, mockAdConfig, '')).rejects.toThrow(
        '[SECURITY]',
      );
    });
  });

  describe('checkAdHealth', () => {
    it('should return true when health check succeeds', async () => {
      (adService.healthCheck as jest.Mock).mockResolvedValue(true);

      const result = await activities.checkAdHealth(mockAdConfig, TEST_TENANT_ID);

      expect(result).toBe(true);
    });

    it('should return false when health check fails', async () => {
      (adService.healthCheck as jest.Mock).mockRejectedValue(new Error('Connection refused'));

      const result = await activities.checkAdHealth(mockAdConfig, TEST_TENANT_ID);

      expect(result).toBe(false);
    });
  });

  describe('discoverAdEntitlements', () => {
    it('should pass raw entitlements with metadata to catalog (PAM classification moved to catalog)', async () => {
      (adService.discover as jest.Mock).mockResolvedValue([
        {
          nativeId: 'CN=Domain Admins,DC=example,DC=com',
          name: 'Domain Admins',
          type: 'Group',
          metadata: { rid: '512' },
        },
        { nativeId: 'CN=Regular Group,DC=example,DC=com', name: 'Regular Group', type: 'Group' },
      ]);

      const result = await activities.discoverAdEntitlements(mockAdConfig, TEST_TENANT_ID);

      // Activity no longer stamps PAM fields — classification happens in EntitlementCatalogService.absorbDiscovered()
      // The activity just passes raw entitlements with metadata through
      expect(result[0]).toMatchObject({
        nativeId: 'CN=Domain Admins,DC=example,DC=com',
        name: 'Domain Admins',
        metadata: { rid: '512' },
      });
      expect(result[0]).not.toHaveProperty('adminTier');

      expect(result[1]).not.toHaveProperty('adminTier');
      expect(result[1]).not.toHaveProperty('requiresAdminAccount');
    });

    it('should not classify groups without RID metadata', async () => {
      (adService.discover as jest.Mock).mockResolvedValue([
        {
          nativeId: 'CN=Users,DC=example,DC=com',
          name: 'Users',
          type: 'Group',
          metadata: { rid: '513' },
        },
      ]);

      const result = await activities.discoverAdEntitlements(mockAdConfig, TEST_TENANT_ID);

      // RID 513 is not a known admin group
      expect(result[0]).not.toHaveProperty('adminTier');
      expect(result[0]).not.toHaveProperty('requiresAdminAccount');
    });
  });
  describe('setAdUserEnabled (a privileged session)', () => {
    const DN = 'CN=adm-ada,OU=Admins,DC=example,DC=com';

    it('enables and disables by the DN on the canvas config', async () => {
      (adService as { setUserEnabled?: jest.Mock }).setUserEnabled = jest
        .fn()
        .mockResolvedValue({ outcome: 'done', detail: 'enabled' });

      await expect(
        activities.setAdUserEnabled(DN, true, mockAdConfig, TEST_TENANT_ID, 'wf-1'),
      ).resolves.toEqual({ outcome: 'done', detail: 'enabled' });

      expect(adService.setUserEnabled).toHaveBeenCalledWith(mockAdConfig, DN, true);
    });

    it('fails without retry when the config has no host', async () => {
      const failure = activities.setAdUserEnabled(
        DN,
        true,
        { ...mockAdConfig, host: '' } as AdConfig,
        TEST_TENANT_ID,
        'wf-1',
      );
      await expect(failure).rejects.toBeInstanceOf(ApplicationFailure);
      await expect(failure).rejects.toMatchObject({ nonRetryable: true });
    });
  });
});
