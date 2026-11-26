/**
 * MfaEnrollmentScopeGuard: a global guard (AuthModule), right after JwtAuthGuard.
 *
 * An MFA enrollment token (scope 'mfa-enrollment', no role: AuthLocalService.completeSignIn when
 * the tenant requires MFA and the admin has none) is accepted only by the routes marked
 * @AllowMfaEnrollmentToken(): GET /auth/me, GET /auth/mfa/status, POST /auth/mfa/setup and
 * POST /auth/mfa/verify-setup. Public routes, POST /auth/logout among them, check no token.
 * Every other route answers 403 to it, whether or not it needs a role.
 *
 * The MFA setup routes (`setup`) also refuse any other token without a role.
 */

import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MFA_ENROLLMENT_ACCESS_KEY, type MfaEnrollmentAccess } from './mfa-enrollment.decorator';

/** The `scope` claim of the token AuthLocalService.signScopedJwt issues for MFA setup. */
export const MFA_ENROLLMENT_SCOPE = 'mfa-enrollment';

@Injectable()
export class MfaEnrollmentScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user as
      | { roles?: string[]; scope?: string }
      | undefined;
    if (!user) return true; // A public route: JwtAuthGuard checked no token.

    const access = this.reflector.getAllAndOverride<MfaEnrollmentAccess | undefined>(
      MFA_ENROLLMENT_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (user.scope === MFA_ENROLLMENT_SCOPE) {
      if (access) return true;
      throw new ForbiddenException(
        'This sign-in can only set up MFA. Finish the setup (POST /api/v1/auth/mfa/setup, then ' +
          'POST /api/v1/auth/mfa/verify-setup) and sign in again.',
      );
    }

    if (access === 'setup' && !user.roles?.length) {
      throw new ForbiddenException(
        'This endpoint requires an MFA enrollment token. Complete the MFA enrollment flow.',
      );
    }
    return true;
  }
}
