import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ScimAuthGuard } from './scim-auth.guard';
import { ScimTokenService } from '../scim-token.service';
import { ScimUsersController } from '../scim-users.controller';
import { ScimGroupsController } from '../scim-groups.controller';
import { SCIMError } from '@shared/scim';
import {
  TENANT_INACTIVE_MESSAGE,
  TenantStatusService,
} from '@infrastructure/multi-tenancy/tenant-status.service';

describe('ScimAuthGuard', () => {
  let guard: ScimAuthGuard;
  let scimTokenService: jest.Mocked<ScimTokenService>;
  let isActive: jest.Mock;

  const createMockContext = (
    headers: Record<string, string> = {},
    method = 'GET',
    controller: unknown = ScimUsersController,
  ) => {
    const request = {
      headers: { ...headers },
      method,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getClass: () => controller,
      getHandler: () => () => undefined,
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    scimTokenService = {
      validateToken: jest.fn(),
    } as unknown as jest.Mocked<ScimTokenService>;

    isActive = jest.fn().mockResolvedValue(true);
    guard = new ScimAuthGuard(
      scimTokenService,
      new Reflector(),
      new TenantStatusService({
        findOne: () => ({ lean: async () => null }),
      } as never),
    );
    jest
      .spyOn(TenantStatusService.prototype, 'isActive')
      .mockImplementation((tenantId: string) => isActive(tenantId));
    jest.clearAllMocks();
  });

  it('should throw 401 when Authorization header is missing', async () => {
    const context = createMockContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(SCIMError);
    try {
      await guard.canActivate(context);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SCIMError);
      if (e instanceof SCIMError) {
        expect(e.scimStatus).toBe('401');
        expect(e.detail).toContain('Authorization');
      }
    }
  });

  it('should throw 401 when auth scheme is not Bearer', async () => {
    const context = createMockContext({
      authorization: 'Basic dXNlcjpwYXNz',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(SCIMError);
    try {
      await guard.canActivate(context);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SCIMError);
      if (e instanceof SCIMError) expect(e.scimStatus).toBe('401');
    }
  });

  it('should throw 401 when token is invalid', async () => {
    const context = createMockContext({
      authorization: 'Bearer invalid-token',
    });
    scimTokenService.validateToken.mockResolvedValue(null);

    await expect(guard.canActivate(context)).rejects.toThrow(SCIMError);
    try {
      await guard.canActivate(context);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SCIMError);
      if (e instanceof SCIMError) {
        expect(e.scimStatus).toBe('401');
        expect(e.detail).toContain('Invalid or expired');
      }
    }
  });

  it('should pass and set req.scimClient and req.user.tenantId when token is valid', async () => {
    const request: { headers: Record<string, string>; scimClient?: unknown; user?: unknown } = {
      headers: { authorization: 'Bearer valid-token' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getClass: () => ScimUsersController,
      getHandler: () => () => undefined,
    } as unknown as ExecutionContext;

    scimTokenService.validateToken.mockResolvedValue({
      id: 'tok-1',
      name: 'Workday',
      scopes: ['Users:read', 'Users:write'],
      tenantId: 'tenant-acme',
    });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.scimClient).toEqual({
      id: 'tok-1',
      name: 'Workday',
      scopes: ['Users:read', 'Users:write'],
      tenantId: 'tenant-acme',
    });
    expect(request.user).toMatchObject({
      tenantId: 'tenant-acme',
      sub: 'scim-token:tok-1',
      name: 'Workday',
      roles: ['scim-provisioner'],
    });
    expect(scimTokenService.validateToken).toHaveBeenCalledWith('valid-token');
  });

  // Final review AU1: SCIM routes are @Public(), so the JWT guard's tenant status check never ran
  // and a suspended tenant's IdP kept creating, changing and deactivating identities
  it('refuses a valid token of a suspended tenant with a SCIM 403, and sets no request tenant', async () => {
    const request: { headers: Record<string, string>; scimClient?: unknown; user?: unknown } = {
      headers: { authorization: 'Bearer valid-token' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getClass: () => ScimUsersController,
      getHandler: () => () => undefined,
    } as unknown as ExecutionContext;
    scimTokenService.validateToken.mockResolvedValue({
      id: 'tok-1',
      name: 'Workday',
      scopes: ['Users:read'],
      tenantId: 'tenant-suspended',
    });
    isActive.mockResolvedValue(false);

    const error = await guard.canActivate(context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SCIMError);
    expect((error as SCIMError).scimStatus).toBe('403');
    expect((error as SCIMError).detail).toBe(TENANT_INACTIVE_MESSAGE);
    expect(isActive).toHaveBeenCalledWith('tenant-suspended');
    expect(request.user).toBeUndefined();
    expect(request.scimClient).toBeUndefined();
  });

  /**
   * Hunt 2026-11-25 (02 F2): the token's scopes were stored and never read, so a token created
   * with Users:read could create, change and delete users and groups. Each route now needs the
   * scope of its resource: GET reads, every other method writes.
   */
  describe('scopes', () => {
    const withScopes = (scopes: string[]) =>
      scimTokenService.validateToken.mockResolvedValue({
        id: 'tok-1',
        name: 'Okta',
        scopes,
        tenantId: 'tenant-acme',
      });
    const auth = { authorization: 'Bearer t' };
    const status = async (method: string, controller: unknown) => {
      try {
        await guard.canActivate(createMockContext(auth, method, controller));
        return 'allowed';
      } catch (e: unknown) {
        return e instanceof SCIMError ? e.scimStatus : 'other';
      }
    };

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      'refuses %s on Users to a read-only token',
      async (method) => {
        withScopes(['Users:read']);
        await expect(status(method, ScimUsersController)).resolves.toBe('403');
      },
    );

    it('lets a read-only token list and read users', async () => {
      withScopes(['Users:read']);
      await expect(status('GET', ScimUsersController)).resolves.toBe('allowed');
    });

    it('needs Users:read to read users, whatever else the token may do', async () => {
      withScopes(['Users:write', 'Groups:read', 'Groups:write']);
      await expect(status('GET', ScimUsersController)).resolves.toBe('403');
      await expect(status('POST', ScimUsersController)).resolves.toBe('allowed');
    });

    it('checks the Groups scopes on the Groups routes', async () => {
      withScopes(['Users:read', 'Users:write', 'Groups:read']);
      await expect(status('GET', ScimGroupsController)).resolves.toBe('allowed');
      await expect(status('PATCH', ScimGroupsController)).resolves.toBe('403');
    });

    it('names the missing scope', async () => {
      withScopes(['Users:read']);
      await expect(
        guard.canActivate(createMockContext(auth, 'DELETE', ScimUsersController)),
      ).rejects.toThrow(/Users:write/);
    });
  });
});
