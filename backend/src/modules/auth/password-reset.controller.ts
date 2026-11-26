import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '@infrastructure/auth/public.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { parsePlatformAdminIds } from '@infrastructure/auth/platform-admin';
import { type AuthConfig, authConfig } from '@infrastructure/config/auth.config';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { AdminUsersService } from './admin-users.service';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetConfirmDto, PasswordResetRequestDto } from './dtos/password-reset.dto';

/** The client address as Express resolves it (trust proxy), never a raw X-Forwarded-For. */
function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Console admin password reset: a public request (a link by email when SMTP is on), a public
 * confirm with the token from the link or a super-admin's one-time code, and the super-admin
 * route that issues such a code. Design: password-reset.service.ts.
 */
@Controller('auth')
export class PasswordResetController {
  private readonly platformAdminIds: ReadonlySet<string>;

  constructor(
    private readonly passwordReset: PasswordResetService,
    private readonly adminUsers: AdminUsersService,
    @Inject(authConfig.KEY) authConf: Pick<AuthConfig, 'PLATFORM_ADMIN_USER_IDS'>,
  ) {
    this.platformAdminIds = parsePlatformAdminIds(authConf.PLATFORM_ADMIN_USER_IDS);
  }

  @Public()
  @Get('password-reset/config')
  @ApiOperation({ summary: 'How an admin can reset a forgotten password on this deployment' })
  @ApiResponse({
    status: 200,
    description:
      '{ byEmail, tokenTtlMinutes }: byEmail is true when SMTP is configured (a link by email); a super-admin can always issue a code.',
  })
  getConfig() {
    return {
      byEmail: this.passwordReset.byEmail,
      tokenTtlMinutes: this.passwordReset.tokenTtlMinutes,
    };
  }

  @Public()
  @Post('password-reset/request')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Ask for a password reset link by email',
    description:
      'Answers the same, in about the same time, whether or not the address has an account. Only an active account that signs in with a password gets a mail, and only when SMTP is configured.',
  })
  @ApiResponse({ status: 202, description: '{ message }, the same for every address' })
  @ApiResponse({ status: 400, description: 'Not an email address' })
  @ApiResponse({ status: 429, description: 'Too many requests from this IP or for this address' })
  @ApiResponse({ status: 503, description: 'The rate limit store is unavailable (fails closed)' })
  async request(@Body() dto: PasswordResetRequestDto, @Req() req: Request) {
    await this.passwordReset.request(dto.email, clientIp(req));
    return {
      message: `If an active admin account that signs in with a password uses this address, EuroID emails it a link to set a new password, valid for ${this.passwordReset.tokenTtlMinutes} minutes. No email? Ask a super-admin of your organization for a reset code.`,
    };
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set a new password with a reset token or code',
    description:
      'Every session of the admin ends; nobody is signed in and MFA stays as it is. The token works once.',
  })
  @ApiResponse({ status: 200, description: '{ success: true, message }' })
  @ApiResponse({
    status: 400,
    description: 'Invalid, used or expired token; a password that breaks the rules or was used',
  })
  @ApiResponse({ status: 429, description: 'Too many attempts from this IP' })
  @ApiResponse({ status: 503, description: 'The rate limit store is unavailable (fails closed)' })
  async confirm(@Body() dto: PasswordResetConfirmDto, @Req() req: Request) {
    await this.passwordReset.confirm(dto.token, dto.newPassword, clientIp(req));
    return { success: true, message: 'Password changed. Sign in with your new password.' };
  }

  @Roles('super-admin')
  @Post('users/:id/password-reset')
  @ApiOperation({
    summary: "Issue a one-time password reset code for an admin of the caller's tenant",
    description:
      'Answers { token, expiresAt } once; only its hash is stored. A newer code or link voids it. Audited (admin_user.password_reset_issued) without the code.',
  })
  @ApiResponse({ status: 400, description: 'Your own account (use change-password)' })
  @ApiResponse({ status: 403, description: 'A platform admin account' })
  @ApiResponse({ status: 404, description: "Not an admin of the caller's tenant" })
  @ApiResponse({ status: 409, description: 'A single sign-on or deactivated account' })
  async issue(
    @Param('id', ParseObjectIdPipe) id: string,
    @AuthUser() user: { sub: string; tenantId: string },
  ) {
    const admin = await this.adminUsers.findInTenant(id, user.tenantId);
    if (!admin) throw new NotFoundException('Admin user not found');
    if (this.platformAdminIds.has(id)) {
      throw new ForbiddenException(
        'This account is a platform admin, managed through the deployment configuration (PLATFORM_ADMIN_USER_IDS): a tenant role cannot issue it a reset code.',
      );
    }
    if (id === user.sub) {
      throw new BadRequestException(
        'You cannot issue a reset code for your own account. Change your password under Account security.',
      );
    }
    if (admin.authSource === 'saml') {
      throw new ConflictException(
        'This admin signs in through single sign-on and has no EuroID password to reset.',
      );
    }
    if (!admin.isActive) {
      throw new ConflictException(
        'This admin is deactivated. Reactivate the account before resetting its password.',
      );
    }
    return this.passwordReset.issue(id, user.tenantId, user.sub);
  }
}
