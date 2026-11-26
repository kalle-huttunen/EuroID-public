/**
 * SamlAuthService — SAML 2.0 SP-initiated SSO with JIT provisioning.
 *
 * Uses @node-saml/node-saml directly (no Passport dependency).
 * Validates SAML assertions from IdPs like ADFS, Okta, PingFederate.
 */

import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { SAML, SamlConfig, Profile as NodeSamlProfile } from '@node-saml/node-saml';
import type { ValidateInResponseTo } from '@node-saml/node-saml';
import { assertionIdOf, SecurityStateSamlCache } from './saml-replay';
import {
  bindingMatches,
  hashBinding,
  isIssuedRelayState,
  relayStateKey,
  safeReturnPath,
  type SamlCodeEntry,
  type SamlLoginState,
} from './saml-login-state';
import { AdminUser, AdminUserDocument } from './schemas/admin-user.schema';
import { jitRole, jitTenant, samlJitConfig } from './saml-jit-policy';
import { Tenant, type TenantDocument } from '@infrastructure/multi-tenancy/schemas/tenant.schema';
import { AuthLocalService, type SignInResult } from './auth-local.service';
import { isDevOrTest } from '@infrastructure/config/runtime-env';
import {
  SECURITY_STATE_STORE,
  type SecurityStateStore,
} from '@infrastructure/cache/security-state.store';

const SAML_AUTH_CODE_TTL_MS = 60_000;
/** How long an AuthnRequest id waits for its response. */
export const SAML_REQUEST_TTL_MS = 15 * 60_000;
/** An assertion older than this is refused, so assertion ids need to be kept only this long. */
const SAML_MAX_ASSERTION_AGE_MS = 10 * 60_000;

/** What POST /auth/saml/exchange answers: what a password sign-in answers (completeSignIn). */
export type SamlExchangePayload = SignInResult;

interface SamlProfile {
  email: string;
  name?: string;
  role?: string;
  tenantId?: string;
  nameID?: string;
  nameIDFormat?: string;
}

@Injectable()
export class SamlAuthService {
  private readonly logger = new Logger(SamlAuthService.name);

  constructor(
    @InjectModel(AdminUser.name) private adminModel: Model<AdminUserDocument>,
    @InjectModel(Tenant.name) private tenantModel: Model<TenantDocument>,
    private config: ConfigService,
    private authLocalService: AuthLocalService,
    @Inject(SECURITY_STATE_STORE) private readonly securityState: SecurityStateStore,
  ) {}

  isConfigured(): boolean {
    return !!(this.config.get('SAML_ENTRY_POINT') && this.config.get('SAML_CERT'));
  }

  getPublicConfig(): { enabled: boolean; issuer?: string } {
    if (!this.isConfigured()) return { enabled: false };
    return {
      enabled: true,
      issuer: this.config.get('SAML_ISSUER') || 'euroid-sp',
    };
  }

  private buildSamlConfig(): SamlConfig {
    const appBaseUrl = this.config.get('APP_BASE_URL');
    // Production rules everywhere but development and test (staging, an unset NODE_ENV too).
    const isProduction = !isDevOrTest(this.config.get<string>('NODE_ENV') ?? '');
    if (!appBaseUrl && isProduction) {
      this.logger.error(
        '[SECURITY] APP_BASE_URL is not configured in production. SAML callback URL cannot be determined. ' +
          'Set APP_BASE_URL to your production base URL (e.g. https://app.example.com).',
      );
      throw new BadRequestException(
        'APP_BASE_URL must be configured in production for SAML to function',
      );
    }
    if (!appBaseUrl) {
      this.logger.warn(
        '[SECURITY] APP_BASE_URL is not configured. SAML callback URL will fall back to localhost. ' +
          'Set APP_BASE_URL to your production base URL (e.g. https://app.example.com).',
      );
    }
    const resolvedBaseUrl = appBaseUrl || 'http://localhost:3001';

    // F4: outside development and test, never allow disabling assertion signature validation
    const wantAssertionsSignedRaw = this.config.get('SAML_WANT_ASSERTIONS_SIGNED');
    if (isProduction && wantAssertionsSignedRaw === 'false') {
      this.logger.error(
        '[SECURITY] SAML_WANT_ASSERTIONS_SIGNED cannot be false outside development and test. ' +
          'SAML assertions must be signed to prevent tampering.',
      );
      throw new BadRequestException(
        'SAML_WANT_ASSERTIONS_SIGNED cannot be false outside development and test',
      );
    }
    const wantAssertionsSigned = wantAssertionsSignedRaw !== 'false';

    return {
      entryPoint: this.config.get('SAML_ENTRY_POINT')!,
      issuer: this.config.get('SAML_ISSUER') || 'euroid-sp',
      idpCert: this.config.get('SAML_CERT')!,
      callbackUrl:
        this.config.get('SAML_CALLBACK_URL') || `${resolvedBaseUrl}/api/v1/auth/saml/callback`,
      wantAssertionsSigned,
      acceptedClockSkewMs: parseInt(this.config.get('SAML_ACCEPTED_CLOCK_SKEW_MS') || '30000', 10),
      signatureAlgorithm: this.getSafeSignatureAlgorithm(),
      // A response must answer an AuthnRequest this deployment sent (InResponseTo), kept in the
      // shared security state store; node-saml removes the id once the response is used.
      validateInResponseTo: this.getInResponseToMode(),
      cacheProvider: new SecurityStateSamlCache(this.securityState, SAML_REQUEST_TTL_MS),
      requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
      maxAssertionAgeMs: SAML_MAX_ASSERTION_AGE_MS,
    };
  }

  /**
   * `always` (the default): only responses to this SP's own AuthnRequests (SP-initiated), which
   * also stops a login CSRF with an unsolicited response. `ifPresent`
   * (SAML_VALIDATE_IN_RESPONSE_TO=ifPresent) also accepts IdP-initiated sign-ins; the assertion
   * id check still refuses a replay of them.
   */
  private getInResponseToMode(): ValidateInResponseTo {
    const configured = this.config.get<string>('SAML_VALIDATE_IN_RESPONSE_TO');
    // The enum's string values; the enum object itself is not imported (a type-only import).
    if (configured === 'ifPresent') return 'ifPresent' as ValidateInResponseTo;
    if (configured && configured !== 'always') {
      this.logger.error(
        `[SECURITY] SAML_VALIDATE_IN_RESPONSE_TO="${configured}" is not allowed. Only always and ifPresent are accepted. Using always.`,
      );
    }
    return 'always' as ValidateInResponseTo;
  }

  private getSafeSignatureAlgorithm(): 'sha256' | 'sha512' {
    const configured = this.config.get('SAML_SIGNATURE_ALGORITHM');
    if (!configured || configured === 'sha256') return 'sha256';
    if (configured === 'sha512') return 'sha512';
    this.logger.error(
      `[SECURITY] SAML_SIGNATURE_ALGORITHM="${configured}" is not allowed. ` +
        `Only sha256 and sha512 are accepted. Defaulting to sha256.`,
    );
    return 'sha256';
  }

  private getSaml(): SAML {
    return new SAML(this.buildSamlConfig());
  }

  /**
   * Start an SP-initiated sign-in (saml-login-state.ts): the IdP URL, with a fresh RelayState id,
   * and the binding value the controller sets as the browser's cookie. Under the RelayState the
   * store keeps the binding's hash and `returnUrl` when it is a same-origin path (else dropped).
   */
  async startLogin(returnUrl?: string): Promise<{ url: string; binding: string }> {
    const saml = this.getSaml(); // the configuration checks, before anything is stored
    const binding = randomBytes(32).toString('hex');
    const relayState = randomBytes(16).toString('hex');
    const path = safeReturnPath(returnUrl);
    if (returnUrl && !path) this.logger.warn('[SAML] Dropped a return URL that is no console path');
    const state: SamlLoginState = {
      bindingHash: hashBinding(binding),
      ...(path && { returnUrl: path }),
    };
    await this.securityState.set(relayStateKey(relayState), state, SAML_REQUEST_TTL_MS);
    const url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
    return { url, binding };
  }

  async validateCallback(body: Record<string, string>): Promise<SamlProfile> {
    const saml = this.getSaml();
    const { profile } = await saml.validatePostResponseAsync(body);

    if (!profile) {
      throw new UnauthorizedException('SAML assertion validation failed: no profile returned');
    }

    const emailAttr =
      this.config.get('SAML_EMAIL_ATTR') ||
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';
    const nameAttr =
      this.config.get('SAML_NAME_ATTR') ||
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name';
    const roleAttr = this.config.get('SAML_ROLE_ATTR') || '';
    const tenantAttr = this.config.get('SAML_TENANT_ATTR') || '';

    const attrs: NodeSamlProfile = profile;
    const email = String(attrs[emailAttr] || attrs.email || attrs.nameID || '')
      .toLowerCase()
      .trim();

    if (!email) {
      throw new UnauthorizedException('SAML assertion missing email attribute');
    }
    await this.useAssertionOnce(profile);

    return {
      email,
      name: String(attrs[nameAttr] || attrs.name || attrs.displayName || email.split('@')[0]),
      role: roleAttr ? String(attrs[roleAttr] || '') : undefined,
      tenantId: tenantAttr ? String(attrs[tenantAttr] || '') : undefined,
      nameID: attrs.nameID,
      nameIDFormat: attrs.nameIDFormat,
    };
  }

  /**
   * An assertion signs in once: its id (with the issuer) is counted in the security state store
   * for the maximum assertion age, atomically, so a captured response replayed, or posted twice
   * at once, is refused. A store failure rejects (503 at the callback's redirect).
   */
  private async useAssertionOnce(profile: NodeSamlProfile): Promise<void> {
    const assertionId = assertionIdOf(profile);
    if (!assertionId) throw new UnauthorizedException('SAML assertion has no ID');
    const key = createHash('sha256')
      .update(`${profile.issuer ?? ''}\n${assertionId}`)
      .digest('hex');
    const { count } = await this.securityState.increment(
      `saml:assertion:${key}`,
      SAML_MAX_ASSERTION_AGE_MS + 60_000,
    );
    if (count > 1) throw new UnauthorizedException('SAML assertion has already been used');
  }

  async findOrCreateUser(profile: SamlProfile): Promise<AdminUserDocument> {
    // Look up existing SAML user
    let user = await this.adminModel.findOne({
      email: profile.email,
      authSource: 'saml',
    });

    if (user) {
      if (!user.isActive) {
        throw new UnauthorizedException('Account is disabled. Contact your administrator.');
      }
      return user;
    }

    // Check if a local user exists with same email
    const localUser = await this.adminModel.findOne({ email: profile.email, authSource: 'local' });
    if (localUser) {
      throw new UnauthorizedException(
        'An account with this email already exists with local authentication. Contact your administrator to link accounts.',
      );
    }

    // JIT provisioning — F5: outside development and test, require explicit opt-in
    const isProduction = !isDevOrTest(this.config.get<string>('NODE_ENV') ?? '');
    const autoCreate = isProduction
      ? this.config.get('SAML_AUTO_CREATE_USER') === 'true'
      : this.config.get('SAML_AUTO_CREATE_USER') !== 'false';
    if (!autoCreate) {
      throw new UnauthorizedException(
        'Account not found. Automatic user provisioning is disabled for SAML.',
      );
    }

    // Tenant and role from the IdP only within this deployment's limits (saml-jit-policy.ts)
    const jit = samlJitConfig((key) => this.config.get<string>(key), this.logger);
    const tenantId = await jitTenant(profile.tenantId, jit, (id) =>
      this.tenantModel.findOne({ tenantId: id }, 'status').lean<{ status?: string } | null>(),
    );
    const role = jitRole(profile.role, jit);

    // No passwordHash: a single sign-on admin has no EuroID password (AdminUser.passwordHash).
    user = await this.adminModel.create({
      email: profile.email,
      name: profile.name || profile.email.split('@')[0],
      role,
      tenantId,
      authSource: 'saml',
      isActive: true,
    });

    this.logger.log(`JIT-provisioned SAML user (role: ${role}, tenant: ${tenantId})`);
    return user;
  }

  /**
   * The IdP's response: the admin signed in (completeSignIn) under a one-time code, bound to the
   * browser of the sign-in its RelayState names, and the return path of that sign-in. A response
   * whose RelayState this deployment did not issue (or issued and saw used) is refused, except
   * with SAML_VALIDATE_IN_RESPONSE_TO=ifPresent, which accepts IdP-initiated sign-ins: their
   * code is not bound to a browser (an unsolicited response can always sign a browser in).
   */
  async handleCallback(
    body: Record<string, string>,
  ): Promise<{ redirectParams: Record<string, string> }> {
    const profile = await this.validateCallback(body);
    const relayState = body.RelayState;
    const login = isIssuedRelayState(relayState)
      ? await this.securityState.take<SamlLoginState>(relayStateKey(relayState))
      : undefined;
    if (!login && this.getInResponseToMode() !== 'ifPresent') {
      throw new UnauthorizedException(
        'SAML response without a sign-in started from this console (RelayState unknown or used)',
      );
    }
    const user = await this.findOrCreateUser(profile);

    // The same MFA gate as a password sign-in: the MFA step, the setup-only token or a session.
    const payload: SamlExchangePayload = await this.authLocalService.completeSignIn(user);
    const code = randomBytes(32).toString('hex');
    const entry: SamlCodeEntry = { payload, ...(login && { bindingHash: login.bindingHash }) };
    await this.securityState.set(`saml:auth:${code}`, entry, SAML_AUTH_CODE_TTL_MS);
    return { redirectParams: { code, ...(login?.returnUrl && { returnUrl: login.returnUrl }) } };
  }

  /**
   * The sign-in result of a one-time code, for the browser whose binding cookie (`binding`)
   * started the sign-in. The code is used up by the first exchange, refused or not.
   */
  async exchangeCode(code: string, binding?: string): Promise<SamlExchangePayload> {
    if (!code || typeof code !== 'string') {
      throw new UnauthorizedException('Invalid or missing auth code');
    }
    const cacheKey = `saml:auth:${code}`;
    // One-time code, read and deleted in one step: of two simultaneous exchanges of one code
    // only one gets the payload. A store failure rejects (503), so no code is redeemed without
    // being used up.
    const entry = await this.securityState.take<SamlCodeEntry>(cacheKey);
    if (!entry?.payload) {
      throw new UnauthorizedException('Auth code invalid or expired');
    }
    if (entry.bindingHash !== undefined && !bindingMatches(entry.bindingHash, binding)) {
      this.logger.warn('[SAML] A sign-in code was presented by a browser that did not start it');
      throw new UnauthorizedException(
        'This sign-in was started in another browser. Sign in again from this one.',
      );
    }
    return entry.payload;
  }

  generateMetadata(): string {
    const saml = this.getSaml();
    return saml.generateServiceProviderMetadata(null, null);
  }
}
