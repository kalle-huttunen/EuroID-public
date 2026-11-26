import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Inject,
  Post,
  Get,
  Patch,
  Body,
  Param,
  NotFoundException,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '@infrastructure/auth/public.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AllowMfaEnrollmentToken } from '@infrastructure/auth/mfa-enrollment.decorator';
import { AuthLocalService } from './auth-local.service';
import { AdminUsersService } from './admin-users.service';
import { LoginDto } from './dtos/login.dto';
import { RegisterDto } from './dtos/register.dto';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { RefreshTokenDto } from './dtos/refresh-token.dto';
import { UpdateAdminDto } from './dtos/update-admin.dto';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { setAuthCookies, clearAuthCookies } from '@infrastructure/auth/auth-cookies';
import { isPlatformAdmin, parsePlatformAdminIds } from '@infrastructure/auth/platform-admin';
import { type AuthConfig, authConfig } from '@infrastructure/config/auth.config';
import { sharedThrottleKey } from '@infrastructure/cache/shared-throttler.storage';

/**
 * Local auth endpoints for email/password login and registration, and the tenant's admin users.
 * Public endpoints (login, register, setup-status) bypass JwtAuthGuard. Invites: invite.controller.ts.
 */
@Controller('auth')
export class AuthLocalController {
  private readonly platformAdminIds: ReadonlySet<string>;

  constructor(
    private readonly authLocalService: AuthLocalService,
    private readonly adminUsers: AdminUsersService,
    @Inject(authConfig.KEY) authConf: Pick<AuthConfig, 'PLATFORM_ADMIN_USER_IDS'>,
  ) {
    this.platformAdminIds = parsePlatformAdminIds(authConf.PLATFORM_ADMIN_USER_IDS);
  }

  // Counted across instances in the security state store, so a client cannot multiply its
  // password guesses by the number of instances; a store failure refuses the login (503).
  @Throttle({
    short: {
      limit: parseInt(process.env.AUTH_THROTTLE_SHORT_LIMIT ?? '5', 10),
      ttl: 1000,
      generateKey: sharedThrottleKey,
    },
    medium: {
      limit: parseInt(process.env.AUTH_THROTTLE_MEDIUM_LIMIT ?? '15', 10),
      ttl: 60000,
      generateKey: sharedThrottleKey,
    },
  })
  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // The lockout counts per address and client (request.ip, TRUST_PROXY decides the hops)
    const clientIp = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const result = (await this.authLocalService.login(dto, clientIp)) as Record<string, unknown>;
    const accessToken = result.access_token as string | undefined;
    const refreshToken = result.refresh_token as string | undefined;
    if (accessToken && refreshToken) {
      setAuthCookies(res, accessToken, refreshToken);
    }
    return result;
  }

  @Throttle({
    short: { limit: parseInt(process.env.AUTH_REGISTER_THROTTLE_LIMIT ?? '3', 10), ttl: 1000 },
    medium: { limit: parseInt(process.env.AUTH_REGISTER_THROTTLE_MEDIUM ?? '10', 10), ttl: 60000 },
  })
  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authLocalService.register(dto);
  }

  @Throttle({
    short: { limit: parseInt(process.env.AUTH_REFRESH_THROTTLE_LIMIT ?? '5', 10), ttl: 1000 },
    medium: { limit: parseInt(process.env.AUTH_REFRESH_THROTTLE_MEDIUM ?? '20', 10), ttl: 60000 },
  })
  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken =
      dto.refresh_token ??
      (req as Request & { cookies?: { refresh_token?: string } }).cookies?.refresh_token;
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token required (cookie or body)');
    }
    const result = await this.authLocalService.refresh(refreshToken);
    setAuthCookies(res, result.access_token, result.refresh_token);
    return result;
  }

  @Public()
  @Get('setup-status')
  async getSetupStatus() {
    return this.authLocalService.getSetupStatus();
  }

  /**
   * Public, so a browser whose access token expired can still sign out. The refresh token it
   * holds (cookie, or body for an API client) stops working; the cookies are cleared first.
   */
  @Public()
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    clearAuthCookies(res);
    const refreshToken =
      dto.refresh_token ??
      (req as Request & { cookies?: { refresh_token?: string } }).cookies?.refresh_token;
    if (refreshToken) {
      await this.authLocalService.revokeRefreshToken(refreshToken);
    }
    return { success: true };
  }

  @AllowMfaEnrollmentToken()
  @Get('me')
  async me(
    @AuthUser()
    user: {
      sub: string;
      email: string;
      name: string;
      roles: string[];
      tenantId: string;
    },
  ) {
    return {
      sub: user.sub,
      email: user.email,
      name: user.name,
      roles: user.roles,
      tenantId: user.tenantId,
      // Decided here from PLATFORM_ADMIN_USER_IDS, as RolesGuard does; the UI only reads it to
      // show tenant management. Nothing the client sends can set it.
      isPlatformAdmin: isPlatformAdmin(user, this.platformAdminIds),
    };
  }

  @Roles('super-admin')
  @Get('users')
  @ApiOperation({
    summary: "List the caller tenant's admin users (console sign-ins, not managed identities)",
  })
  @ApiResponse({
    status: 200,
    description:
      'Sorted by email: { id, email, name, role, isActive, mfaEnabled, authSource, isPlatformAdmin, createdAt, lastLoginAt }. lastLoginAt is null until a sign-in records it. No password, MFA, session or token data.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden: requires super-admin' })
  async listAdmins(@AuthUser() user: { tenantId: string }) {
    // A tenant super-admin sees its own tenant's admins only.
    return this.authLocalService.listAdmins(user.tenantId, this.platformAdminIds);
  }

  @Roles('super-admin')
  @Post('revoke/:userId')
  @ApiOperation({ summary: "Revoke every session of an admin of the caller's tenant" })
  @ApiResponse({ status: 400, description: 'The user id is not an ObjectId' })
  @ApiResponse({ status: 403, description: "Another user's platform admin account" })
  @ApiResponse({ status: 404, description: "Not an admin of the caller's tenant" })
  async revoke(
    @Param('userId', ParseObjectIdPipe) userId: string,
    @AuthUser() user: { sub: string; tenantId: string },
  ) {
    await this.findInTenant(userId, user.tenantId);
    this.refusePlatformAdmin(userId, user.sub);
    if (!(await this.authLocalService.revokeAllSessions(userId, user.tenantId))) {
      throw new NotFoundException('Admin user not found');
    }
    return { success: true };
  }

  @Post('change-password')
  @ApiResponse({ status: 409, description: 'A single sign-on account (no EuroID password)' })
  async changePassword(@AuthUser() user: { sub: string }, @Body() dto: ChangePasswordDto) {
    await this.authLocalService.changePassword(user.sub, dto.currentPassword, dto.newPassword);
    return { success: true };
  }

  @Roles('super-admin')
  @Patch('users/:id')
  @ApiOperation({
    summary: "Change the role of, deactivate or reactivate an admin of the caller's tenant",
    description:
      "Body: { role?, isActive? }. role is one of the five tenant roles; it applies from the admin's next request and is audited (admin_user.role_changed).",
  })
  @ApiResponse({ status: 400, description: 'Your own account (deactivate, role), an unknown role' })
  @ApiResponse({ status: 403, description: "Another user's platform admin account" })
  @ApiResponse({ status: 404, description: "Not an admin of the caller's tenant" })
  @ApiResponse({
    status: 409,
    description: 'It would leave the tenant without an active super-admin',
  })
  async updateAdmin(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateAdminDto,
    @AuthUser() user: { sub: string; tenantId: string },
  ) {
    await this.findInTenant(id, user.tenantId);
    this.refusePlatformAdmin(id, user.sub);
    // Only a super-admin deactivates or changes a role: doing it to yourself is how the last
    // super-admin could leave the tenant with nobody to reactivate or promote anyone.
    if (dto.isActive === false && id === user.sub) {
      throw new BadRequestException(
        'You cannot deactivate your own account. Another super-admin can.',
      );
    }
    if (dto.role !== undefined && id === user.sub) {
      throw new BadRequestException('You cannot change your own role. Another super-admin can.');
    }
    if (dto.role !== undefined) {
      if (!(await this.adminUsers.changeRole(id, dto.role, user.tenantId, user.sub))) {
        throw new NotFoundException('Admin user not found');
      }
    }
    const result =
      dto.isActive !== undefined
        ? await this.adminUsers.setActive(id, dto.isActive, user.tenantId)
        : await this.adminUsers.safeInTenant(id, user.tenantId);
    if (!result) {
      throw new NotFoundException('Admin user not found');
    }
    return result;
  }

  /**
   * A tenant super-admin manages its own tenant's admins only (AdminUser is exempt from the
   * tenant plugin). Runs before every other check, so another tenant's id is 404 whatever it is,
   * a platform admin's included.
   */
  private async findInTenant(id: string, tenantId: string): Promise<void> {
    if (!(await this.adminUsers.findInTenant(id, tenantId))) {
      throw new NotFoundException('Admin user not found');
    }
  }

  /**
   * A platform admin's account is the deployment's (PLATFORM_ADMIN_USER_IDS), not its tenant's:
   * no tenant role signs it out, deactivates, reactivates it or changes its role. Its owner may
   * revoke their own sessions; deactivating it or changing its role is refused like any change of
   * your own account. Checked after findInTenant, so it never tells another tenant's super-admin
   * which ids are on the list.
   */
  private refusePlatformAdmin(targetId: string, callerSub: string): void {
    if (targetId !== callerSub && this.platformAdminIds.has(targetId)) {
      throw new ForbiddenException(
        'This account is a platform admin, managed through the deployment configuration (PLATFORM_ADMIN_USER_IDS), not by a tenant role.',
      );
    }
  }
}
