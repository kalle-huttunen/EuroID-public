import {
  Injectable,
  Logger,
  UnauthorizedException,
  NotFoundException,
  ConflictException,
  Inject,
  HttpStatus,
} from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import axios from 'axios';
import { createHash } from 'crypto';
import { safeLog } from '@infrastructure/observability/pii-redact.format';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { EntraConfig } from './entra.interface';
import { ConnectorCircuitBreakerService } from '@infrastructure/resilience/connector-circuit-breaker';
import { validateUrlForFetch } from '@infrastructure/url-validation/ssrf-guard';

const OAUTH_CACHE_PREFIX = 'oauth:entra:';
const TOKEN_PREEXPIRE_SEC = 60;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface EntraCredentials {
  tenant: string;
  clientId: string;
  secret: string;
}

/** tenant:clientId:sha256(secret), so configs that differ in any credential never share. */
function scopeOf({ tenant, clientId, secret }: EntraCredentials): string {
  return `${tenant}:${clientId}:${createHash('sha256').update(secret).digest('hex')}`;
}

const CREDENTIAL_FIELDS = ['tenantId', 'clientId', 'clientSecret'] as const;

/**
 * HTTP layer for Microsoft Graph. Token acquisition, retries, and raw API calls.
 *
 * Holds no per-call state: every Graph call names the config it runs on (a canvas or installed
 * connector config, or `undefined` for the ENTRA_* environment variables), and its token is
 * cached under that config's tenant, client id and secret. Concurrent activities on one worker
 * with different configs never use each other's credentials or tokens.
 */
@Injectable()
export class EntraClient {
  private readonly logger = new Logger(EntraClient.name);
  private readonly baseUrl = process.env.ENTRA_GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0';

  private readonly connectorName = 'entra-id';

  constructor(
    private readonly config: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly circuitBreaker: ConnectorCircuitBreakerService,
  ) {}

  /**
   * Identifies the credentials a config signs in with (tenant, client id and a hash of the
   * secret), for caches that must not be shared between configs. Never contains the secret.
   */
  credentialScope(config: EntraConfig | undefined): string {
    return scopeOf(this.credentials(config));
  }

  /** Generic GET */
  async get<T>(endpoint: string, config: EntraConfig | undefined): Promise<T> {
    const headers = await this.getHeaders(config);
    return this.guarded(config, endpoint, async () => {
      const res = await axios.get(`${this.baseUrl}${endpoint}`, { headers });
      return res.data;
    });
  }

  /** GET by full URL (for Graph API @odata.nextLink pagination). SSRF-validated before fetch. */
  async getByUrl<T>(url: string, config: EntraConfig | undefined): Promise<T> {
    await validateUrlForFetch(url);
    const headers = await this.getHeaders(config);
    return this.guarded(config, url, async () => {
      const res = await axios.get(url, { headers });
      return res.data;
    });
  }

  /** Generic POST */
  async post<T>(
    endpoint: string,
    body: Record<string, unknown>,
    config: EntraConfig | undefined,
  ): Promise<T> {
    const headers = await this.getHeaders(config);
    return this.guarded(config, endpoint, async () => {
      const res = await axios.post(`${this.baseUrl}${endpoint}`, body, { headers });
      return res.data;
    });
  }

  /** Generic PATCH (for updating resources) */
  async patch<T>(
    endpoint: string,
    body: Record<string, unknown>,
    config: EntraConfig | undefined,
  ): Promise<T> {
    const headers = await this.getHeaders(config);
    return this.guarded(config, endpoint, async () => {
      const res = await axios.patch(`${this.baseUrl}${endpoint}`, body, { headers });
      return res.data;
    });
  }

  /** Generic DELETE */
  async delete(endpoint: string, config: EntraConfig | undefined): Promise<void> {
    const headers = await this.getHeaders(config);
    return this.guarded(config, endpoint, async () => {
      await axios.delete(`${this.baseUrl}${endpoint}`, { headers });
    });
  }

  /**
   * One Graph call under the circuit breaker of the config's directory and app (breakerTarget),
   * its failure turned into an exception by handleError inside it, so the breaker sees the
   * status: only a 5xx or no answer counts there.
   */
  private guarded<T>(
    config: EntraConfig | undefined,
    endpoint: string,
    call: () => Promise<T>,
  ): Promise<T> {
    return this.circuitBreaker.execute(
      this.connectorName,
      async () => {
        try {
          return await call();
        } catch (e: unknown) {
          this.handleError(e, endpoint);
        }
      },
      this.breakerTarget(config),
    );
  }

  /** The directory and app a config signs in to: the target its circuit breaker is kept for. */
  private breakerTarget(config: EntraConfig | undefined): string {
    const { tenant, clientId } = this.credentials(config);
    return `${tenant}:${clientId}`;
  }

  private async getHeaders(config: EntraConfig | undefined) {
    const token = await this.ensureToken(config);
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  /**
   * The credentials of a config, all three from it; `undefined` takes all three from the ENTRA_*
   * environment variables. A config with any of them empty is a configuration error (400, which
   * retrying cannot fix), never filled in from the environment: a tenant id with the
   * environment's client id and secret would sign the deployment's app in to that tenant.
   */
  private credentials(config: EntraConfig | undefined): EntraCredentials {
    if (config) {
      const empty = CREDENTIAL_FIELDS.filter((key) => !String(config[key] ?? '').trim());
      if (empty.length > 0) {
        throw new ConnectorException(
          `Entra ID config is incomplete (empty: ${empty.join(', ')}): set the tenant ID, ` +
            'client ID and client secret of one app registration in the Entra ID connector config.',
          HttpStatus.BAD_REQUEST,
        );
      }
      return { tenant: config.tenantId, clientId: config.clientId, secret: config.clientSecret };
    }
    const tenant = this.config.get('ENTRA_TENANT_ID');
    const clientId = this.config.get('ENTRA_CLIENT_ID');
    const secret = this.config.get('ENTRA_CLIENT_SECRET');
    if (!tenant || !clientId || !secret) {
      throw new ConnectorException(
        'Missing Entra Config: install the Entra ID connector, or set ENTRA_TENANT_ID, ' +
          'ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET.',
      );
    }
    return { tenant, clientId, secret };
  }

  private async ensureToken(config: EntraConfig | undefined): Promise<string> {
    // Read once, before any await: the token is fetched and cached for exactly these credentials
    const credentials = this.credentials(config);
    const { tenant, clientId, secret } = credentials;
    const cacheKey = `${OAUTH_CACHE_PREFIX}${scopeOf(credentials)}`;
    const cached = await this.cache.get<CachedToken>(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAtMs > now) {
      return cached.accessToken;
    }

    try {
      return await this.circuitBreaker.execute(
        this.connectorName,
        async () => {
          const res = await axios.post(
            `${process.env.ENTRA_LOGIN_BASE_URL || 'https://login.microsoftonline.com'}/${tenant}/oauth2/v2.0/token`,
            new URLSearchParams({
              client_id: clientId,
              client_secret: secret,
              scope: 'https://graph.microsoft.com/.default',
              grant_type: 'client_credentials',
            }),
          );
          const accessToken = res.data.access_token;
          const expiresIn = res.data.expires_in ?? 3600;
          const ttlMs = Math.max(60_000, (expiresIn - TOKEN_PREEXPIRE_SEC) * 1000);
          const expiresAtMs = now + ttlMs;

          await this.cache.set(cacheKey, { accessToken, expiresAtMs }, ttlMs);
          this.logger.log(
            `Authenticated with Entra ID using ${config ? 'runtime config' : 'environment variables'}`,
          );
          return accessToken;
        },
        `${tenant}:${clientId}`,
      );
    } catch (e: unknown) {
      // The token endpoint refused the credentials (wrong secret, unknown tenant or client, app
      // not consented): 401, which retrying cannot fix
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        this.logger.error(`Entra Auth Failed (HTTP ${status})`);
        throw new UnauthorizedException('Could not authenticate with Entra ID');
      }
      // The token endpoint failed, not the credentials: a 429, a 5xx or no answer is handled as
      // on a Graph call (a 5xx or no answer is a retryable 502, as in 2.0cw), anything else
      // (the circuit breaker open) is rethrown as it is
      this.handleError(e, 'token endpoint');
    }
  }

  // ── Credential state (dumb pipe, read only: no password reset) ────────────

  /** Get credential state: lastPasswordChangeDateTime, accountEnabled. */
  async getCredentialState(
    userId: string,
    config?: EntraConfig,
  ): Promise<{ lastPasswordChangeDateTime?: string; accountEnabled?: boolean }> {
    return this.get<{ lastPasswordChangeDateTime?: string; accountEnabled?: boolean }>(
      `/users/${userId}?$select=lastPasswordChangeDateTime,accountEnabled`,
      config,
    );
  }

  /** Get MFA authentication methods registered for user. */
  async getMfaMethods(
    userId: string,
    config?: EntraConfig,
  ): Promise<{ value: Array<{ '@odata.type': string }> }> {
    return this.get<{ value: Array<{ '@odata.type': string }> }>(
      `/users/${userId}/authentication/methods`,
      config,
    );
  }

  /**
   * A Graph failure as an exception: 429 waits its retry-after, 404 and 409 are their own
   * exceptions. Any other 4xx is a client error (400), which retrying cannot fix. A 5xx answer or
   * no answer at all (network error, timeout) is 502, which deprovision activities retry
   * (asDeprovisionFailure), so a brief Graph outage does not fail an offboarding for good. The
   * token request's failures other than refused credentials come here too (ensureToken).
   */
  private handleError(e: unknown, _endpoint: string): never {
    if (axios.isAxiosError(e)) {
      const status = e.response?.status;
      if (status === 429) {
        const retryAfter = e.response?.headers?.['retry-after'];
        const retryMs =
          retryAfter != null ? Math.max(1000, parseInt(String(retryAfter), 10) * 1000) : 60_000;
        throw new RateLimitedException(retryMs, 'entra-id');
      }
      if (status === 404) throw new NotFoundException('Resource not found');
      if (status === 409) throw new ConflictException('Resource conflict');
      const msg = safeLog(e.response?.data?.error || (e instanceof Error ? e.message : String(e)));
      const upstreamFailed = status === undefined || status >= 500;
      throw new ConnectorException(
        `Entra API Error${status === undefined ? '' : ` (HTTP ${status})`}: ${msg}`,
        upstreamFailed ? HttpStatus.BAD_GATEWAY : HttpStatus.BAD_REQUEST,
      );
    }
    throw e;
  }
}

// --- TASK_103 recap: 429 handling — parse Retry-After, throw RateLimitedException(retryMs, 'entra-id').
