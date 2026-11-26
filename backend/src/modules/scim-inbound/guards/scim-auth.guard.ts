import {
  Injectable,
  CanActivate,
  ExecutionContext,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ScimTokenService } from '../scim-token.service';
import { SCIMError } from '@shared/scim';
import {
  TENANT_INACTIVE_MESSAGE,
  TenantStatusService,
} from '@infrastructure/multi-tenancy/tenant-status.service';

/** The SCIM resource a controller serves; its token scopes are `<resource>:read` and `:write`. */
export type ScimResource = 'Users' | 'Groups';

/** The scopes a SCIM token can hold. */
export const SCIM_SCOPES = ['Users:read', 'Users:write', 'Groups:read', 'Groups:write'] as const;

const SCIM_RESOURCE_KEY = 'scimResource';

/** GET and HEAD read; every other method writes. */
function requiredScope(resource: ScimResource, method: string | undefined): string {
  const reads = method === 'GET' || method === 'HEAD';
  return `${resource}:${reads ? 'read' : 'write'}`;
}

/** Extend Express Request with SCIM client metadata */
export interface ScimClientInfo {
  id: string;
  name: string;
  scopes: string[];
  tenantId?: string;
}

declare global {
  namespace Express {
    interface Request {
      scimClient?: ScimClientInfo;
    }
  }
}

/**
 * Guard that validates SCIM bearer tokens from Authorization header.
 * Extracts Bearer token, validates via ScimTokenService, attaches token metadata to req.scimClient.
 * The token must hold the scope of the route: `<resource>:read` for GET, `<resource>:write` for
 * any other method, the resource being the one its controller declares (ScimAuth). A route
 * without a declared resource is refused. A token of a tenant that is not active (suspended,
 * deprovisioned: TenantStatusService) is refused with a SCIM 403, as every other authenticated
 * request of such a tenant is.
 */
@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(
    private readonly scimTokenService: ScimTokenService,
    private readonly reflector: Reflector,
    private readonly tenantStatus: TenantStatusService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new SCIMError(undefined, 'Missing or invalid Authorization header', '401');
    }

    const bearerToken = authHeader.slice(7);
    const tokenData = await this.scimTokenService.validateToken(bearerToken);

    if (!tokenData) {
      throw new SCIMError(undefined, 'Invalid or expired SCIM token', '401');
    }
    // SCIM routes are @Public(): the JWT guard's tenant status check does not run for them
    if (tokenData.tenantId && !(await this.tenantStatus.isActive(tokenData.tenantId))) {
      throw new SCIMError(undefined, TENANT_INACTIVE_MESSAGE, '403');
    }

    const resource = this.reflector.getAllAndOverride<ScimResource | undefined>(SCIM_RESOURCE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const scope = resource ? requiredScope(resource, request.method) : undefined;
    if (!scope || !tokenData.scopes?.includes(scope)) {
      throw new SCIMError(
        undefined,
        scope
          ? `This SCIM token does not have the ${scope} scope`
          : 'No SCIM scope covers this route',
        '403',
      );
    }

    request.scimClient = tokenData;
    // Set tenantId on request so TenantContextInterceptor can propagate it to AsyncLocalStorage
    if (tokenData.tenantId) {
      request['user'] = {
        ...(request['user'] || {}),
        tenantId: tokenData.tenantId,
        sub: `scim-token:${tokenData.id}`,
        email: 'scim-client',
        name: tokenData.name,
        roles: ['scim-provisioner'],
      };
    }
    return true;
  }
}

/** SCIM token auth for a controller of `resource`: its routes need that resource's scopes. */
export const ScimAuth = (resource: ScimResource) =>
  applyDecorators(SetMetadata(SCIM_RESOURCE_KEY, resource), UseGuards(ScimAuthGuard));
