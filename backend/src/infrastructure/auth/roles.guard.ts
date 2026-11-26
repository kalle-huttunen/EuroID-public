import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { type AuthConfig, authConfig } from '../config/auth.config';
import { PLATFORM_ADMIN_ROLE, isPlatformAdmin, parsePlatformAdminIds } from './platform-admin';

/**
 * Role hierarchy: super-admin > connector-admin > operator > viewer; policy-admin > operator > viewer.
 * These are tenant roles. None of them implies `platform-admin`, which no token can carry
 * (see platform-admin.ts): a token claiming it gets nothing from it.
 */
const ROLE_HIERARCHY: Record<string, string[]> = {
  'super-admin': ['super-admin', 'connector-admin', 'policy-admin', 'operator', 'viewer'],
  'connector-admin': ['connector-admin', 'operator', 'viewer'],
  'policy-admin': ['policy-admin', 'operator', 'viewer'],
  operator: ['operator', 'viewer'],
  viewer: ['viewer'],
};

/**
 * Whether tenant roles grant `role` through the hierarchy above, for a route that gates one
 * option more strictly than the route itself (GET /identity?includeDeleted=true: operator).
 */
export function rolesGrant(userRoles: readonly string[] | undefined, role: string): boolean {
  return (userRoles ?? []).some((r) => (ROLE_HIERARCHY[r] ?? []).includes(role));
}

/** The tenant roles, the strongest first. */
const ROLES_STRONGEST_FIRST = [
  'super-admin',
  'connector-admin',
  'policy-admin',
  'operator',
  'viewer',
];

/**
 * `role` held to `cap`: the strongest role both grant through the hierarchy above. `role` itself
 * when the cap grants it, the cap when `role` is above it, and for two roles beside each other
 * (connector-admin, policy-admin) the one below both (operator). Undefined for a name that is no
 * tenant role.
 */
export function roleWithin(role: string, cap: string): string | undefined {
  const byRole = ROLE_HIERARCHY[role];
  const byCap = ROLE_HIERARCHY[cap];
  if (!byRole || !byCap) return undefined;
  return ROLES_STRONGEST_FIRST.find((r) => byRole.includes(r) && byCap.includes(r));
}

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly platformAdminIds: ReadonlySet<string>;

  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(authConfig.KEY)
    authConf?: Pick<AuthConfig, 'PLATFORM_ADMIN_USER_IDS'>,
  ) {
    // No config (unit tests): nobody is a platform admin.
    this.platformAdminIds = parsePlatformAdminIds(authConf?.PLATFORM_ADMIN_USER_IDS);
  }

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no roles specified, any authenticated user can access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest()['user'];

    // Deployment configuration alone decides platform-admin, never the token's roles.
    if (
      requiredRoles.includes(PLATFORM_ADMIN_ROLE) &&
      isPlatformAdmin(user, this.platformAdminIds)
    ) {
      return true;
    }

    if (!user?.roles) {
      throw new ForbiddenException('No roles assigned');
    }

    const userPermissions = new Set<string>();
    for (const role of user.roles) {
      const granted = ROLE_HIERARCHY[role] ?? [];
      granted.forEach((r) => userPermissions.add(r));
    }

    const hasRole = requiredRoles.some((role) => userPermissions.has(role));
    if (!hasRole) {
      throw new ForbiddenException(`Requires one of: ${requiredRoles.join(', ')}`);
    }

    return true;
  }
}
