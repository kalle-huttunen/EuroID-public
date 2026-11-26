import { Test, TestingModule } from '@nestjs/testing';
import { AdService } from './ad.service';
import { AdClient } from './ad.client';
import { InsufficientAccessError, NoSuchObjectError } from 'ldapts';
import { createMockUser } from '@testing/mock-factories';
import type { AdConfig } from './ad.interface';

describe('AdService', () => {
  let service: AdService;
  let client: jest.Mocked<AdClient>;

  const mockConfig: AdConfig = {
    host: '10.0.0.1',
    baseDn: 'OU=Helsinki,DC=gov,DC=fi',
    serviceAccount: 'CN=svc,OU=SA,DC=gov,DC=fi',
    password: 'secret',
    useLdaps: true,
    defaultDomain: 'gov.fi',
    userOu: 'OU=Users',
  };

  beforeEach(async () => {
    const mockClient = {
      addUser: jest.fn(),
      searchUsers: jest.fn(),
      searchGroups: jest.fn(),
      addUserToGroup: jest.fn(),
      healthCheck: jest.fn(),
      disableUser: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AdService, { provide: AdClient, useValue: mockClient }],
    }).compile();

    service = module.get(AdService);
    client = module.get(AdClient);
  });

  describe('discover', () => {
    it('returns [] when config is missing', async () => {
      const result = await service.discover();
      expect(result).toEqual([]);
      expect(client.searchGroups).not.toHaveBeenCalled();
    });

    it('returns [] when config has no baseDn', async () => {
      const result = await service.discover({ ...mockConfig, baseDn: '' });
      expect(result).toEqual([]);
    });

    it('returns entitlements when config is valid', async () => {
      (client.searchGroups as jest.Mock).mockResolvedValue([
        { dn: 'CN=Group1,OU=Groups,OU=Helsinki,DC=gov,DC=fi', cn: 'Group1', name: 'Group1' },
      ]);
      const result = await service.discover(mockConfig);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        nativeId: expect.any(String),
        name: 'Group1',
        type: 'Group',
      });
    });

    it('returns raw RID as metadata for admin groups (classification deferred to Brain)', async () => {
      const objectSid512 = Buffer.alloc(8);
      objectSid512.writeUInt32LE(512, 4);
      (client.searchGroups as jest.Mock).mockResolvedValue([
        {
          dn: 'CN=Domain Admins,CN=Users,DC=gov,DC=fi',
          cn: 'Domain Admins',
          name: 'Domain Admins',
          objectSid: objectSid512,
        },
      ]);
      const result = await service.discover(mockConfig);
      expect(result[0]).toMatchObject({
        nativeId: 'CN=Domain Admins,CN=Users,DC=gov,DC=fi',
        name: 'Domain Admins',
        type: 'Group',
        metadata: { rid: '512' },
      });
      // Connector must NOT stamp admin classification — that's Brain responsibility
      expect(result[0]).not.toHaveProperty('adminTier');
      expect(result[0]).not.toHaveProperty('requiresAdminAccount');
      expect(result[0]).not.toHaveProperty('riskLevel');
    });

    it('returns no metadata for groups without objectSid', async () => {
      (client.searchGroups as jest.Mock).mockResolvedValue([
        {
          dn: 'CN=Domain Users,CN=Users,DC=gov,DC=fi',
          cn: 'Domain Users',
          name: 'Domain Users',
        },
      ]);
      const result = await service.discover(mockConfig);
      expect(result[0]).toMatchObject({
        nativeId: 'CN=Domain Users,CN=Users,DC=gov,DC=fi',
        name: 'Domain Users',
        type: 'Group',
      });
      expect(result[0].metadata).toBeUndefined();
    });
  });

  describe('healthCheck', () => {
    it('returns false when config is missing', async () => {
      const result = await service.healthCheck();
      expect(result).toBe(false);
    });

    it('returns client result when config is valid', async () => {
      (client.healthCheck as jest.Mock).mockResolvedValue(true);
      const result = await service.healthCheck(mockConfig);
      expect(result).toBe(true);
    });
  });

  describe('provision', () => {
    it('calls client.addUser and returns ProvisioningResult when user has pre-resolved samAccountName and userPrincipalName', async () => {
      (client.addUser as jest.Mock).mockResolvedValue({
        dn: 'CN=John Doe,OU=Users,OU=Helsinki,DC=gov,DC=fi',
      });

      const user = createMockUser({
        email: 'john@example.com',
        firstName: 'John',
        lastName: 'Doe',
        samAccountName: 'johndoe',
        userPrincipalName: 'john@example.com',
      });
      const result = await service.provision(mockConfig, user, undefined, 'SecureP@ss1!');

      expect(result.targetUserId).toContain('CN=');
      expect(result.generatedAttributes).toBeDefined();
      expect(result.generatedAttributes?.mail).toBeDefined();
      expect(result.generatedAttributes?.userPrincipalName).toBeDefined();
      expect(client.addUser).toHaveBeenCalled();
    });

    // A namesake holds the planned DN: the activity picks a free CN (FOLLOWUPS 2026-11-24)
    it('creates the account under the CN the caller chose, keeping the display name', async () => {
      (client.addUser as jest.Mock).mockImplementation(async (_c: unknown, dn: string) => ({
        dn,
      }));
      const user = createMockUser({
        displayName: 'John Doe',
        samAccountName: 'johndoe1',
        userPrincipalName: 'john@example.com',
      });

      const result = await service.provision(mockConfig, user, undefined, 'P@ss1!', 'John Doe 1');

      const [, dn, attributes] = (client.addUser as jest.Mock).mock.calls[0];
      expect(dn).toBe('CN=John Doe 1,OU=Users,OU=Helsinki,DC=gov,DC=fi');
      expect(attributes).toMatchObject({ cn: 'John Doe 1', displayName: 'John Doe' });
      expect(result.targetUserId).toBe(dn);
    });

    it('throws when user lacks samAccountName or userPrincipalName', async () => {
      const user = createMockUser({
        email: 'john@example.com',
        firstName: 'John',
        lastName: 'Doe',
      });
      await expect(service.provision(mockConfig, user, undefined, 'SecureP@ss1!')).rejects.toThrow(
        'AD connector requires pre-resolved samAccountName and userPrincipalName',
      );
    });

    it('throws when password is not provided', async () => {
      const user = createMockUser({
        samAccountName: 'johndoe',
        userPrincipalName: 'john@example.com',
      });
      await expect(service.provision(mockConfig, user)).rejects.toThrow(
        'AD connector requires a pre-generated password',
      );
    });
  });

  describe('createUser', () => {
    it('calls client.addUser and returns dn', async () => {
      (client.addUser as jest.Mock).mockResolvedValue({ dn: 'CN=Jane,OU=Users,...' });

      const adUser = {
        cn: 'Jane Doe',
        sn: 'Doe',
        givenName: 'Jane',
        displayName: 'Jane Doe',
        mail: 'jane@example.com',
        sAMAccountName: 'janedoe',
        userPrincipalName: 'jane@example.com',
        objectClass: ['top', 'person', 'organizationalPerson', 'user'],
        userAccountControl: 512,
      };
      const result = await service.createUser(
        mockConfig,
        adUser,
        'CN=Jane,OU=Users,...',
        'SecurePwd1!',
      );

      expect(result).toBe('CN=Jane,OU=Users,...');
      expect(client.addUser).toHaveBeenCalled();
    });
  });

  describe('deprovision', () => {
    it('returns true when disableUser succeeds', async () => {
      (client.disableUser as jest.Mock).mockResolvedValue(undefined);
      const result = await service.deprovision(mockConfig, 'CN=user,OU=Users,DC=gov,DC=fi');
      expect(result).toBe(true);
      expect(client.disableUser).toHaveBeenCalledWith(mockConfig, 'CN=user,OU=Users,DC=gov,DC=fi');
    });

    it('throws when disableUser fails (no error swallowing)', async () => {
      (client.disableUser as jest.Mock).mockRejectedValue(new Error('LDAP unavailable'));
      await expect(
        service.deprovision(mockConfig, 'CN=user,OU=Users,DC=gov,DC=fi'),
      ).rejects.toThrow('LDAP unavailable');
    });
  });

  describe('deprovisionUser (offboarding)', () => {
    const dn = 'CN=user,OU=Users,DC=gov,DC=fi';

    it('disables the account by its DN', async () => {
      (client.disableUser as jest.Mock).mockResolvedValue(undefined);
      await expect(service.deprovisionUser(mockConfig, dn)).resolves.toEqual({
        outcome: 'deprovisioned',
        detail: 'disabled',
      });
    });

    it('reports "no such object" for the DN as already gone', async () => {
      (client.disableUser as jest.Mock).mockRejectedValue(new NoSuchObjectError('0000208D'));
      await expect(service.deprovisionUser(mockConfig, dn)).resolves.toEqual({
        outcome: 'already-gone',
        detail: 'no such object',
      });
    });

    it('lets other LDAP errors through', async () => {
      (client.disableUser as jest.Mock).mockRejectedValue(new InsufficientAccessError('50'));
      await expect(service.deprovisionUser(mockConfig, dn)).rejects.toBeInstanceOf(
        InsufficientAccessError,
      );
    });
  });

  describe('create', () => {
    it('throws when called without config', async () => {
      const user = createMockUser();
      await expect(service.create(user)).rejects.toThrow('requires config');
    });
  });
});
