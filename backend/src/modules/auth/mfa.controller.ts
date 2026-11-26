/**
 * MFA controller — TOTP enrollment, verification, challenge, and management.
 */

import { Controller, Post, Get, Body, UnauthorizedException, Res } from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@infrastructure/auth/public.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import { AllowMfaEnrollmentToken } from '@infrastructure/auth/mfa-enrollment.decorator';
import { MfaService } from './mfa.service';
import { AuthLocalService } from './auth-local.service';
import { MfaVerifyDto } from './dtos/mfa-verify.dto';
import { MfaChallengeDto } from './dtos/mfa-challenge.dto';
import { setAuthCookies } from '@infrastructure/auth/auth-cookies';

@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfaService: MfaService,
    private readonly authLocalService: AuthLocalService,
  ) {}

  // These two and GET status also serve the MFA enrollment token (MfaEnrollmentScopeGuard).
  @AllowMfaEnrollmentToken('setup')
  @Post('setup')
  async setup(@AuthUser() user: { sub: string }) {
    return this.mfaService.setupMfa(user.sub);
  }

  @AllowMfaEnrollmentToken('setup')
  @Post('verify-setup')
  async verifySetup(@AuthUser() user: { sub: string }, @Body() dto: MfaVerifyDto) {
    return this.mfaService.verifySetup(user.sub, dto.code);
  }

  @Throttle({
    short: { limit: parseInt(process.env.MFA_CHALLENGE_THROTTLE_LIMIT ?? '5', 10), ttl: 1000 },
    medium: { limit: parseInt(process.env.MFA_CHALLENGE_THROTTLE_MEDIUM ?? '10', 10), ttl: 60000 },
  })
  @Public()
  @Post('challenge')
  async challenge(@Body() dto: MfaChallengeDto, @Res({ passthrough: true }) res: Response) {
    const pending = await this.mfaService.verifyMfaPendingToken(dto.mfa_token);
    const valid = await this.mfaService.validateCode(pending.sub, dto.code);
    if (!valid) {
      throw new UnauthorizedException('Invalid verification code');
    }
    const result = await this.authLocalService.issueTokensForUser(pending.sub);
    setAuthCookies(res, result.access_token, result.refresh_token);
    return result;
  }

  @Post('disable')
  async disable(@AuthUser() user: { sub: string }, @Body() dto: MfaVerifyDto) {
    await this.mfaService.disableMfa(user.sub, dto.code);
    return { success: true };
  }

  @Post('backup-codes')
  async regenerateBackupCodes(@AuthUser() user: { sub: string }, @Body() dto: MfaVerifyDto) {
    return this.mfaService.regenerateBackupCodes(user.sub, dto.code);
  }

  @AllowMfaEnrollmentToken()
  @Get('status')
  async status(@AuthUser() user: { sub: string }) {
    return this.mfaService.getMfaStatus(user.sub);
  }
}
