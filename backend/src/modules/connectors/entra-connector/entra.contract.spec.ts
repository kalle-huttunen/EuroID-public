/**
 * Entra Connector Contract Tests
 *
 * Wires EntraService with mocked EntraClient (HTTP boundary).
 * Verifies: create (provision), discover (discoverEntitlements), healthCheck (checkConnection),
 * and idempotency of provision.
 *
 * The connector is a dumb pipe: it executes explicit add/remove operations.
 * PAM tier classification and governance filtering happen in the activity layer (Brain),
 * not in the connector (Hands).
 *
 * @see docs/tasks/CURRENT_TASK_23.md
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { EntraService } from './entra.service';
import { EntraClient } from './entra.client';
import { EntraMapper } from './entra.mapper';
import { EntraDiscoveryService } from './entra-discovery.service';
import { EntraProvisioningService } from './entra-provisioning.service';
import { EntraEntitlementsService } from './entra-entitlements.service';
import { EntraTenantConfigService } from './entra-tenant-config.service';
import { CorrelationConfigRegistry } from '../../correlation-config/correlation-config.registry';
import { CredentialGenerationService } from '@infrastructure/secrets/credential-generation.service';
import { createMockUser } from '@testing/mock-factories';

/** Mock EntraClient — simulates HTTP boundary without real API calls */
function createMockEntraClient() {
  const users = new Map<string, string>();
  return {
    get: jest.fn().mockImplementation(async (endpoint: string) => {
      if (endpoint === '/organization' || endpoint.startsWith('/organization?')) {
        return { value: [{ verifiedDomains: [{ name: 'test.local' }] }] };
      }
      if (endpoint.includes('/users/') && endpoint.includes('$select=id')) {
        const upn = decodeURIComponent(endpoint.split('/users/')[1].split('?')[0]);
        const id = users.get(upn);
        if (id) return { id };
        throw new NotFoundException('Resource not found');
      }
      if (endpoint === '/groups?$select=id,displayName') {
        return { value: [{ id: 'g1', displayName: 'All Staff' }] };
      }
      if (endpoint === '/subscribedSkus') {
        return { value: [{ skuPartNumber: 'E3', skuId: 'sku-e3' }] };
      }
      if (endpoint.includes('/users/') && endpoint.includes('/memberOf')) {
        return { value: [] };
      }
      if (endpoint.includes('/subscribedSkus')) {
        return { value: [{ skuPartNumber: 'E3', skuId: 'sku-e3' }] };
      }
      if (endpoint === '/roleManagement/directory/roleDefinitions') {
        return {
          value: [
            {
              id: '62e90394-69f5-4237-9190-012177145e10',
              templateId: '62e90394-69f5-4237-9190-012177145e10',
              displayName: 'Global Administrator',
              description: 'Can manage all aspects of Azure AD',
              isBuiltIn: true,
            },
            {
              id: 'unknown-role-id',
              templateId: 'unknown-role-id',
              displayName: 'Unknown Role',
              description: 'Custom or unknown role',
              isBuiltIn: true,
            },
          ],
        };
      }
      if (
        endpoint.includes('/roleManagement/directory/roleAssignments') &&
        endpoint.includes('$filter=')
      ) {
        return { value: [] };
      }
      return {};
    }),
    post: jest.fn().mockImplementation(async (endpoint: string, body: any) => {
      if (endpoint === '/users') {
        const upn = body.userPrincipalName || 'new@test.local';
        const id = 'entra-' + upn.replace('@', '-at-');
        users.set(upn, id);
        return { id, mail: upn, userPrincipalName: upn };
      }
      if (endpoint.includes('/groups/') && endpoint.includes('/members/$ref')) {
        return {};
      }
      if (endpoint.includes('/assignLicense')) {
        return {};
      }
      if (endpoint === '/roleManagement/directory/roleAssignments') {
        return {
          id: 'assignment-123',
          principalId: body.principalId,
          roleDefinitionId: body.roleDefinitionId,
        };
      }
      return {};
    }),
    patch: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue(undefined),
    credentialScope: jest.fn((config?: { tenantId: string }) => config?.tenantId ?? 'environment'),
  };
}

describe('Entra Connector Contract', () => {
  let entraService: EntraService;
  let entitlementsService: EntraEntitlementsService;
  let mockClient: ReturnType<typeof createMockEntraClient>;

  beforeEach(async () => {
    mockClient = createMockEntraClient();

    const configService = {
      get: jest.fn().mockImplementation((key: string) => {
        const map: Record<string, string> = {
          ENTRA_TENANT_ID: 'tenant',
          ENTRA_CLIENT_ID: 'client',
          ENTRA_CLIENT_SECRET: 'secret',
          ENTRA_DEFAULT_DOMAIN: 'test.local',
          ENTRA_USAGE_LOCATION: 'US',
        };
        return map[key];
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        EntraService,
        EntraMapper,
        EntraDiscoveryService,
        EntraProvisioningService,
        EntraEntitlementsService,
        // No tenant context and no installed configs: calls without a config run on ENTRA_*
        EntraTenantConfigService,
        CorrelationConfigRegistry,
        {
          provide: EntraClient,
          useValue: mockClient,
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
        {
          provide: CredentialGenerationService,
          useValue: { generatePassword: jest.fn().mockReturnValue('MockP@ss123!') },
        },
      ],
    }).compile();

    entraService = module.get(EntraService);
    entitlementsService = module.get(EntraEntitlementsService);
  });

  describe('healthCheck (checkConnection)', () => {
    it('calls client.get for organization and returns true', async () => {
      const result = await entraService.checkConnection();
      expect(result).toBe(true);
      expect(mockClient.get).toHaveBeenCalledWith('/organization', undefined);
    });
  });

  describe('discover (discoverEntitlements)', () => {
    it('calls client.get for groups, subscribedSkus, and roleDefinitions', async () => {
      const entitlements = await entraService.discoverEntitlements();
      expect(Array.isArray(entitlements)).toBe(true);
      expect(entitlements.length).toBeGreaterThan(0);
      expect(mockClient.get).toHaveBeenCalledWith('/groups?$select=id,displayName', undefined);
      expect(mockClient.get).toHaveBeenCalledWith('/subscribedSkus', undefined);
      expect(mockClient.get).toHaveBeenCalledWith(
        '/roleManagement/directory/roleDefinitions',
        undefined,
      );
    });

    it('returns entitlements with nativeId, name, type', async () => {
      const entitlements = await entraService.discoverEntitlements();
      for (const e of entitlements) {
        expect(e).toHaveProperty('nativeId');
        expect(e).toHaveProperty('name');
        expect(e).toHaveProperty('type');
      }
    });

    it('discovers directory roles with raw metadata (no PAM fields — classification is Brain responsibility)', async () => {
      const entitlements = await entraService.discoverEntitlements();
      const dirRoles = entitlements.filter((e) => e.type === 'DirectoryRole');
      expect(dirRoles.length).toBeGreaterThanOrEqual(2);

      const globalAdmin = dirRoles.find(
        (e) => e.nativeId === '62e90394-69f5-4237-9190-012177145e10',
      );
      expect(globalAdmin).toBeDefined();
      // Connector returns raw metadata, NOT PAM classification
      expect(globalAdmin?.metadata?.templateId).toBe('62e90394-69f5-4237-9190-012177145e10');
      expect(globalAdmin).not.toHaveProperty('adminTier');
      expect(globalAdmin).not.toHaveProperty('requiresAdminAccount');
      expect(globalAdmin).not.toHaveProperty('riskLevel');

      const unknownRole = dirRoles.find((e) => e.nativeId === 'unknown-role-id');
      expect(unknownRole).toBeDefined();
      expect(unknownRole?.metadata?.templateId).toBe('unknown-role-id');
      expect(unknownRole).not.toHaveProperty('adminTier');
      expect(unknownRole).not.toHaveProperty('requiresAdminAccount');
    });
  });

  describe('create (provision)', () => {
    it('creates new user and returns targetUserId', async () => {
      const user = createMockUser({
        email: 'newuser@test.local',
        userPrincipalName: 'newuser@test.local',
        firstName: 'New',
        lastName: 'User',
      });

      const result = await entraService.provision(user);
      expect(result.targetUserId).toBeDefined();
      expect(typeof result.targetUserId).toBe('string');
      expect(mockClient.post).toHaveBeenCalledWith(
        '/users',
        expect.objectContaining({
          userPrincipalName: 'newuser@test.local',
          givenName: 'New',
          surname: 'User',
        }),
        undefined,
      );
    });

    it('passes a canvas config to every Graph call, group, license and role ones included', async () => {
      const canvas = {
        tenantId: 'canvas-tenant',
        clientId: 'canvas-app',
        clientSecret: 'canvas-secret',
        defaultDomain: 'test.local',
      };
      const user = createMockUser({
        email: 'canvas@test.local',
        userPrincipalName: 'canvas@test.local',
        firstName: 'Canvas',
        lastName: 'User',
      });

      await entraService.provision(
        user,
        {
          operations: [
            { type: 'group', action: 'add', targetId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
            { type: 'license', action: 'add', targetId: 'E3' },
            { type: 'role', action: 'add', targetId: '62e90394-69f5-4237-9190-012177145e10' },
          ],
        },
        canvas,
      );

      const calls = [mockClient.get, mockClient.post, mockClient.patch, mockClient.delete].flatMap(
        (fn) => fn.mock.calls as unknown[][],
      );
      expect(calls.map((args) => args[0])).toEqual(
        expect.arrayContaining(['/subscribedSkus', '/roleManagement/directory/roleAssignments']),
      );
      expect(calls.filter((args) => args[args.length - 1] !== canvas)).toEqual([]);
    });

    it('is idempotent — same input returns success (existing resource)', async () => {
      const user = createMockUser({
        email: 'idempotent@test.local',
        userPrincipalName: 'idempotent@test.local',
        firstName: 'Idem',
        lastName: 'Potent',
      });

      const first = await entraService.provision(user);
      const second = await entraService.provision(user);

      expect(first.targetUserId).toBe(second.targetUserId);
      expect(mockClient.post).toHaveBeenCalledTimes(1);
      expect(mockClient.patch).toHaveBeenCalledTimes(1);
    });
  });

  describe('assignDirectoryRole', () => {
    it('returns assignment ID on success', async () => {
      const result = await entraService.assignDirectoryRole(
        'user-123',
        '62e90394-69f5-4237-9190-012177145e10',
      );
      expect(result).toBe('assignment-123');
      expect(mockClient.post).toHaveBeenCalledWith(
        '/roleManagement/directory/roleAssignments',
        expect.objectContaining({
          principalId: 'user-123',
          roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10',
          directoryScopeId: '/',
        }),
        undefined,
      );
    });

    it('returns empty string on 409 Conflict (idempotent)', async () => {
      (mockClient.post as jest.Mock).mockRejectedValueOnce(
        new ConflictException('Resource conflict'),
      );
      const result = await entraService.assignDirectoryRole('user-123', 'role-id');
      expect(result).toBe('');
    });
  });

  describe('removeDirectoryRole', () => {
    it('succeeds on 404 NotFound (already removed)', async () => {
      (mockClient.delete as jest.Mock).mockRejectedValueOnce(
        new NotFoundException('Resource not found'),
      );
      await expect(entraService.removeDirectoryRole('assignment-456')).resolves.not.toThrow();
    });

    it('calls client.delete with assignment ID', async () => {
      await entraService.removeDirectoryRole('assignment-456');
      expect(mockClient.delete).toHaveBeenCalledWith(
        '/roleManagement/directory/roleAssignments/assignment-456',
        undefined,
      );
    });
  });

  describe('syncDirectoryRoles (dumb pipe: explicit add/remove)', () => {
    it('executes explicit add operations', async () => {
      await entraService.syncDirectoryRoles('user-1', [
        { type: 'role', action: 'add', targetId: 'role-new' },
      ]);

      expect(mockClient.post).toHaveBeenCalledWith(
        '/roleManagement/directory/roleAssignments',
        expect.objectContaining({ roleDefinitionId: 'role-new' }),
        undefined,
      );
    });

    it('executes explicit remove operations (fetches assignment ID by filter)', async () => {
      (mockClient.get as jest.Mock).mockImplementation(async (endpoint: string) => {
        if (endpoint.includes('/roleAssignments') && endpoint.includes('$filter=')) {
          return {
            value: [{ id: 'a1', principalId: 'user-1', roleDefinitionId: 'role-existing' }],
          };
        }
        return {};
      });

      await entraService.syncDirectoryRoles('user-1', [
        { type: 'role', action: 'remove', targetId: 'role-existing' },
      ]);

      expect(mockClient.delete).toHaveBeenCalledWith(
        '/roleManagement/directory/roleAssignments/a1',
        undefined,
      );
    });

    it('reports a failed op with its reason and continues with remaining ops', async () => {
      (mockClient.post as jest.Mock)
        .mockRejectedValueOnce(new Error('Assign failed'))
        .mockResolvedValueOnce({ id: 'a2' });

      // Does not throw: each op is reported, the failed one with its reason
      const results = await entraService.syncDirectoryRoles('user-1', [
        { type: 'role', action: 'add', targetId: 'role-fail' },
        { type: 'role', action: 'add', targetId: 'role-ok' },
      ]);

      // Both role assignments were attempted despite the first failing
      expect(mockClient.post).toHaveBeenCalledTimes(2);
      expect(results).toEqual([
        {
          type: 'role',
          action: 'add',
          targetId: 'role-fail',
          outcome: 'failed',
          reason: 'Assign failed',
        },
        { type: 'role', action: 'add', targetId: 'role-ok', outcome: 'applied' },
      ]);
    });
  });

  describe('provision routes role ops', () => {
    it('calls syncDirectoryRoles when intent has type: role operations', async () => {
      const user = createMockUser({
        email: 'roleuser@test.local',
        userPrincipalName: 'roleuser@test.local',
        firstName: 'Role',
        lastName: 'User',
      });
      const syncSpy = jest.spyOn(entitlementsService, 'syncDirectoryRoles');

      await entraService.provision(user, {
        operations: [
          { type: 'role', action: 'add', targetId: '62e90394-69f5-4237-9190-012177145e10' },
        ],
      });

      expect(syncSpy).toHaveBeenCalledWith(
        expect.any(String),
        [{ type: 'role', action: 'add', targetId: '62e90394-69f5-4237-9190-012177145e10' }],
        undefined,
      );
    });
  });

  describe('syncGroupMemberships (dumb pipe: explicit add/remove)', () => {
    const groupGuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    it('executes explicit add operations', async () => {
      await entraService.syncGroupMemberships('user-123', [
        { type: 'group', action: 'add', targetId: groupGuid },
      ]);

      expect(mockClient.post).toHaveBeenCalledWith(
        expect.stringContaining(`/groups/${groupGuid}/members/$ref`),
        expect.any(Object),
        undefined,
      );
    });

    it('executes explicit remove operations', async () => {
      await entraService.syncGroupMemberships('user-123', [
        { type: 'group', action: 'remove', targetId: groupGuid },
      ]);

      expect(mockClient.delete).toHaveBeenCalledWith(
        expect.stringContaining(`/groups/${groupGuid}/members/user-123`),
        undefined,
      );
    });

    it('reports an unknown group as a failed op with the reason (does not throw)', async () => {
      // 'nonexistent-name' is not a GUID and resolveGroupId will query the API
      (mockClient.get as jest.Mock).mockImplementation(async (endpoint: string) => {
        if (endpoint.includes('/groups?$filter=')) {
          return { value: [] }; // Group not found
        }
        return {};
      });

      const results = await entraService.syncGroupMemberships('user-123', [
        { type: 'group', action: 'add', targetId: 'nonexistent-name' },
      ]);

      // No group add was attempted (group couldn't be resolved), and that is a failure
      expect(mockClient.post).not.toHaveBeenCalled();
      expect(results).toEqual([
        expect.objectContaining({
          targetId: 'nonexistent-name',
          outcome: 'failed',
          reason: 'No Entra ID group has the id or display name "nonexistent-name"',
          status: 422,
        }),
      ]);
    });
  });
});
