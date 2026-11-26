/**
 * SAML 2.0 SSO controller — SP-initiated login, assertion callback, and metadata.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@infrastructure/auth/public.decorator';
import { ConfigService } from '@nestjs/config';
import { SAML_REQUEST_TTL_MS, SamlAuthService } from './saml-auth.service';
import { clearBindingCookie, SAML_BINDING_COOKIE, setBindingCookie } from './saml-login-state';
import { Request, Response } from 'express';
import { z } from 'zod';
import { setAuthCookies } from '@infrastructure/auth/auth-cookies';
import { sharedThrottleKey } from '@infrastructure/cache/shared-throttler.storage';

const ExchangeCodeSchema = z.object({ code: z.string().min(1) });

@Controller('auth/saml')
export class SamlAuthController {
  private readonly logger = new Logger(SamlAuthController.name);

  constructor(
    private readonly samlAuthService: SamlAuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get('config')
  getConfig() {
    return this.samlAuthService.getPublicConfig();
  }

  @Public()
  @Get('login')
  async login(@Query('returnUrl') returnUrl: string, @Res() res: Response) {
    if (!this.samlAuthService.isConfigured()) {
      return res.status(400).json({ message: 'SAML is not configured' });
    }
    // The browser's half of the sign-in's binding: the exchange answers only to this cookie
    const { url, binding } = await this.samlAuthService.startLogin(returnUrl);
    setBindingCookie(res, binding, SAML_REQUEST_TTL_MS);
    return res.redirect(url);
  }

  // Counted across instances, as POST /auth/login is (a store failure answers 503).
  @Throttle({
    short: {
      limit: parseInt(process.env.SAML_CALLBACK_THROTTLE_LIMIT ?? '10', 10),
      ttl: 1000,
      generateKey: sharedThrottleKey,
    },
    medium: {
      limit: parseInt(process.env.SAML_CALLBACK_THROTTLE_MEDIUM ?? '30', 10),
      ttl: 60000,
      generateKey: sharedThrottleKey,
    },
  })
  @Public()
  @Post('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const frontendUrl =
      this.config.get('FRONTEND_URL') ||
      this.config.get('CORS_ORIGINS')?.split(',')[0]?.trim() ||
      'http://localhost:5173';

    if (!this.samlAuthService.isConfigured()) {
      return res.redirect(
        `${frontendUrl}/login?saml_error=${encodeURIComponent('SAML is not configured')}`,
      );
    }

    try {
      const { redirectParams } = await this.samlAuthService.handleCallback(req.body);

      const params = new URLSearchParams(redirectParams);
      return res.redirect(`${frontendUrl}/auth/saml-callback?${params.toString()}`);
    } catch (err: unknown) {
      const internalMessage = err instanceof Error ? err.message : 'SAML authentication failed';
      this.logger.error(`SAML callback error: ${internalMessage}`);
      return res.redirect(
        `${frontendUrl}/login?saml_error=${encodeURIComponent('Authentication failed. Please try again or contact your administrator.')}`,
      );
    }
  }

  @Public()
  @Post('exchange')
  async exchange(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = ExchangeCodeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Invalid or missing auth code');
    }
    const binding = (req as Request & { cookies?: Record<string, string | undefined> }).cookies?.[
      SAML_BINDING_COOKIE
    ];
    // One sign-in, one code: the cookie has done its work whatever the answer
    clearBindingCookie(res);
    const result = await this.samlAuthService.exchangeCode(parsed.data.code, binding);
    if (result.access_token && result.refresh_token) {
      setAuthCookies(res, result.access_token, result.refresh_token);
    }
    return result;
  }

  @Public()
  @Get('metadata')
  metadata(@Res() res: Response) {
    if (!this.samlAuthService.isConfigured()) {
      return res.status(400).json({ message: 'SAML is not configured' });
    }
    const xml = this.samlAuthService.generateMetadata();
    res.set('Content-Type', 'application/xml');
    return res.send(xml);
  }
}
