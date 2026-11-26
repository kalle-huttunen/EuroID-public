import { SCIMService } from './scim.service';
import { SCIMClient } from './scim.client';
import { SCIMMapper } from './scim.mapper';
import { SCIMConnectorConfig } from './scim.interface';
import { createMockUser } from '@testing';
import { SCIM_SCHEMAS, SCIMError } from '@shared/scim';

describe('SCIMService', () => {
  let service: SCIMService;
  let client: jest.Mocked<SCIMClient>;
  let mapper: SCIMMapper;

  const config: SCIMConnectorConfig = {
    baseUrl: 'https://api.example.com/scim/v2',
    authType: 'bearer',
    bearerToken: 'test-token',
  };

  beforeEach(() => {
    // Real mapper (pure logic, no mocking needed)
    mapper = new SCIMMapper();

    // Mock client (HTTP layer)
    client = {
      createUser: jest.fn(),
      getUser: jest.fn(),
      updateUser: jest.fn(),
      patchUser: jest.fn(),
      deleteUser: jest.fn(),
      listUsers: jest.fn(),
      listGroups: jest.fn(),
      healthCheck: jest.fn(),
      createGroup: jest.fn(),
      invalidateToken: jest.fn(),
    } as unknown as jest.Mocked<SCIMClient>;

    service = new SCIMService(client, mapper);
  });

  // ───────── Provision (Idempotent) ─────────

  describe('provision', () => {
    it('should CREATE user when not found by userName', async () => {
      // listUsers returns empty → user doesn't exist
      client.listUsers.mockResolvedValueOnce({
        schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
        totalResults: 0,
        startIndex: 1,
        itemsPerPage: 0,
        Resources: [],
      });

      // createUser returns the new user
      client.createUser.mockResolvedValueOnce({
        schemas: [SCIM_SCHEMAS.USER],
        id: 'new-user-id',
        userName: 'john.doe@example.com',
      });

      const user = createMockUser();
      const result = await service.provision(config, user);

      expect(client.listUsers).toHaveBeenCalledWith(
        config,
        expect.stringContaining('userName eq'),
        1,
        1,
      );
      expect(client.createUser).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          userName: 'john.doe@example.com',
        }),
      );
      expect(client.updateUser).not.toHaveBeenCalled();
      expect(result.targetUserId).toBe('new-user-id');
    });

    it('should UPDATE user when already exists by userName', async () => {
      // listUsers returns existing user
      client.listUsers.mockResolvedValueOnce({
        schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [
          {
            schemas: [SCIM_SCHEMAS.USER],
            id: 'existing-user-id',
            userName: 'john.doe@example.com',
          },
        ],
      });

      // updateUser returns the updated user
      client.updateUser.mockResolvedValueOnce({
        schemas: [SCIM_SCHEMAS.USER],
        id: 'existing-user-id',
        userName: 'john.doe@example.com',
      });

      const user = createMockUser();
      const result = await service.provision(config, user);

      expect(client.createUser).not.toHaveBeenCalled();
      expect(client.updateUser).toHaveBeenCalledWith(
        config,
        'existing-user-id',
        expect.objectContaining({ userName: 'john.doe@example.com' }),
      );
      expect(result.targetUserId).toBe('existing-user-id');
    });

    // Hunt 2026-11-25 (r2-01 N2): a failed lookup (401, 5xx, timeout, open breaker) was taken
    // for "no such user", so the create made a duplicate account; and the first resource of a
    // server that ignores the filter was updated with this person's attributes.
    it('fails, creating nothing, when the userName lookup fails', async () => {
      client.listUsers.mockRejectedValueOnce(new Error('timeout of 30000ms exceeded'));

      await expect(service.provision(config, createMockUser())).rejects.toThrow(/timeout/);
      expect(client.createUser).not.toHaveBeenCalled();
      expect(client.updateUser).not.toHaveBeenCalled();
    });

    it('never updates a user the server returns for another userName (filter ignored)', async () => {
      client.listUsers.mockResolvedValueOnce({
        schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ schemas: [SCIM_SCHEMAS.USER], id: 'someone-else', userName: 'x@example.com' }],
      });
      client.createUser.mockResolvedValueOnce({
        schemas: [SCIM_SCHEMAS.USER],
        id: 'new-user-id',
        userName: 'john.doe@example.com',
      });

      const result = await service.provision(config, createMockUser());

      expect(client.updateUser).not.toHaveBeenCalled();
      expect(client.createUser).toHaveBeenCalled();
      expect(result.targetUserId).toBe('new-user-id');
    });

    it('finds the user whatever the case of its userName', async () => {
      client.listUsers.mockResolvedValueOnce({
        schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ schemas: [SCIM_SCHEMAS.USER], id: 'u-1', userName: 'John.Doe@example.com' }],
      });
      client.updateUser.mockResolvedValueOnce({
        schemas: [SCIM_SCHEMAS.USER],
        id: 'u-1',
        userName: 'John.Doe@example.com',
      });

      await service.provision(config, createMockUser());

      expect(client.updateUser).toHaveBeenCalledWith(config, 'u-1', expect.anything());
    });
  });

  describe('getUserByEmail', () => {
    it('fails when the lookup fails, so reconciliation never takes the account for missing', async () => {
      client.listUsers.mockRejectedValueOnce(new Error('Request failed with status code 503'));

      await expect(service.getUserByEmail(config, 'john.doe@example.com')).rejects.toThrow(/503/);
    });
  });

  // Hunt 2026-11-25 (r2-01 N6): listUsers stopped after a page shorter than the 100 it asked
  // for, so a server that caps pages at 50 gave orphan detection its first 50 users; discover
  // read the server's first page of groups only.
  describe('paging', () => {
    const page = <T>(resources: T[], totalResults: number, startIndex: number) => ({
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    });
    const users = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        schemas: [SCIM_SCHEMAS.USER],
        id: `u${from + i}`,
        userName: `u${from + i}@example.com`,
      }));

    it('reads every user of a server that caps its pages below the count asked for', async () => {
      client.listUsers
        .mockResolvedValueOnce(page(users(1, 50), 120, 1))
        .mockResolvedValueOnce(page(users(51, 50), 120, 51))
        .mockResolvedValueOnce(page(users(101, 20), 120, 101));

      const all = await service.listUsers(config);

      expect(all.map((u) => u.id)).toEqual(users(1, 120).map((u) => u.id));
      expect(client.listUsers.mock.calls.map((c) => c[2])).toEqual([1, 51, 101]);
    });

    it('discovers every group, page by page', async () => {
      const groups = (from: number, n: number) =>
        Array.from({ length: n }, (_, i) => ({
          schemas: [SCIM_SCHEMAS.GROUP],
          id: `g${from + i}`,
          displayName: `Group ${from + i}`,
        }));
      client.listGroups
        .mockResolvedValueOnce(page(groups(1, 100), 150, 1))
        .mockResolvedValueOnce(page(groups(101, 50), 150, 101));

      const found = await service.discover(config);

      expect(found).toHaveLength(150);
      expect(client.listGroups.mock.calls.map((c) => c[2])).toEqual([1, 101]);
    });
  });

  // ───────── Deprovision ─────────

  describe('deprovision', () => {
    it('should PATCH active=false when strategy is deactivate (default)', async () => {
      client.patchUser.mockResolvedValueOnce({
        schemas: [SCIM_SCHEMAS.USER],
        id: 'user-1',
        userName: 'john@test.com',
        active: false,
      });

      await service.deprovision(config, 'user-1');

      expect(client.patchUser).toHaveBeenCalledWith(
        config,
        'user-1',
        expect.objectContaining({
          schemas: [SCIM_SCHEMAS.PATCH_OP],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        }),
      );
      expect(client.deleteUser).not.toHaveBeenCalled();
    });

    it('should DELETE when strategy is delete', async () => {
      const deleteConfig: SCIMConnectorConfig = { ...config, deprovisionStrategy: 'delete' };
      client.deleteUser.mockResolvedValueOnce(undefined);

      await service.deprovision(deleteConfig, 'user-1');

      expect(client.deleteUser).toHaveBeenCalledWith(deleteConfig, 'user-1');
      expect(client.patchUser).not.toHaveBeenCalled();
    });
  });

  // ───────── Discover ─────────

  // An orphan delete removes the account whatever deprovisionStrategy says (HX-F follow-up)
  describe('deleteUser', () => {
    const listing = (users: Array<{ id: string; userName: string }>) => ({
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: users.length,
      startIndex: 1,
      itemsPerPage: users.length,
      Resources: users.map((u) => ({ schemas: [SCIM_SCHEMAS.USER], ...u })),
    });

    it('deletes the user its userName finds with DELETE /Users/{id}', async () => {
      client.listUsers.mockResolvedValueOnce(
        listing([{ id: 'u-7', userName: 'old@corp.example' }]),
      );
      client.deleteUser.mockResolvedValueOnce(undefined);

      const result = await service.deleteUser(
        { ...config, deprovisionStrategy: 'deactivate' },
        { userNames: ['old@corp.example'], emails: ['old@corp.example'] },
      );

      expect(result).toEqual({ outcome: 'done' });
      expect(client.deleteUser).toHaveBeenCalledWith(expect.anything(), 'u-7');
      expect(client.patchUser).not.toHaveBeenCalled();
    });

    it('answers not-found when no user has the userName or email, deleting nothing', async () => {
      client.listUsers.mockResolvedValue(listing([]));

      const result = await service.deleteUser(config, {
        userNames: ['gone@corp.example'],
        emails: ['gone@corp.example'],
      });

      expect(result).toEqual({ outcome: 'not-found' });
      expect(client.deleteUser).not.toHaveBeenCalled();
    });

    it('answers already-gone for a 404 on the delete', async () => {
      client.deleteUser.mockRejectedValueOnce(
        new SCIMError(undefined, 'Resource not found', '404'),
      );

      await expect(service.deleteUser(config, { id: 'u-7' })).resolves.toEqual({
        outcome: 'already-gone',
      });
    });
  });

  describe('discover', () => {
    it('should return groups as entitlements', async () => {
      client.listGroups.mockResolvedValueOnce({
        schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 2,
        Resources: [
          { schemas: [SCIM_SCHEMAS.GROUP], id: 'grp-1', displayName: 'Engineering' },
          { schemas: [SCIM_SCHEMAS.GROUP], id: 'grp-2', displayName: 'Marketing' },
        ],
      });

      const entitlements = await service.discover(config);

      expect(entitlements).toHaveLength(2);
      expect(entitlements[0]).toEqual({
        nativeId: 'grp-1',
        name: 'Engineering',
        type: 'Group',
        system: 'scim',
        origin: 'EXTERNAL',
        governanceLevel: 'OPEN',
      });
      expect(entitlements[1].nativeId).toBe('grp-2');
    });

    it('should return empty array when no groups exist', async () => {
      client.listGroups.mockResolvedValueOnce({
        schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
        totalResults: 0,
        startIndex: 1,
        itemsPerPage: 0,
        Resources: [],
      });

      const entitlements = await service.discover(config);
      expect(entitlements).toHaveLength(0);
    });
  });

  // ───────── Health Check ─────────

  describe('healthCheck', () => {
    it('should return healthy when client health check passes', async () => {
      client.healthCheck.mockResolvedValueOnce(true);

      const result = await service.healthCheck(config);
      expect(result.healthy).toBe(true);
    });

    it('should return unhealthy with error when client health check fails', async () => {
      client.healthCheck.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await service.healthCheck(config);
      expect(result.healthy).toBe(false);
      expect(result.error).toBe('Connection refused');
    });
  });
});
