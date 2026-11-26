import { Injectable, Logger, Inject, BadRequestException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { CONNECTOR_TIMEOUT_MS } from '@infrastructure/config/defaults';
import { createHash } from 'crypto';
import { ConnectorCircuitBreakerService } from '@infrastructure/resilience/connector-circuit-breaker';
import { SCIMConnectorConfig } from './scim.interface';
import { SCIMUser, SCIMGroup, SCIMListResponse, SCIMPatchOp } from '@shared/scim';
import { SCIM_CONTENT_TYPE, SCIM_ACCEPT_TYPES, SCIM_SCHEMAS } from '@shared/scim';
import { SCIMError } from '@shared/scim';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import {
  createSsrfSafeHttpsAgent,
  validateUrlForFetch,
} from '@infrastructure/url-validation/ssrf-guard';

/**
 * HTTP client implementing the SCIM 2.0 protocol (RFC 7644).
 *
 * Auth: Supports bearer, basic, and OAuth2 client credentials.
 * Content-Type: Sends application/scim+json, accepts both scim+json and json.
 * Error handling: Parses SCIM error responses and throws typed SCIMError.
 */
const OAUTH_CACHE_PREFIX = 'oauth:scim:';
const TOKEN_PREEXPIRE_SEC = 60;

interface CachedOAuthToken {
  accessToken: string;
  expiresAtMs: number;
}

const CONNECTOR_NAME = 'scim';

/**
 * The cache key of a config's OAuth2 token: base URL, token URL, client id and a hash of the
 * secret, so a config that shares the base URL and client id (neither is secret) never gets
 * another's token, nor one that another token endpoint issued.
 */
function oauthCacheKey(config: SCIMConnectorConfig): string {
  const secretHash = createHash('sha256')
    .update(config.clientSecret ?? '')
    .digest('hex');
  return (
    `${OAUTH_CACHE_PREFIX}${config.baseUrl}|${config.oauth2TokenUrl ?? ''}|` +
    `${config.clientId}|${secretHash}`
  );
}

/**
 * SSRF (connectors ARCHITECTURE.md, SSRF Protection): validateUrlForFetch checks the base URL and
 * the token URL, then axios resolves the host again: the agent checks every address it connects
 * to (DNS rebinding), no redirect is followed (a redirect would lead past the check, a 307 or 308
 * with the token request's client secret in its body) and no proxy from the environment is used.
 */
const NO_REDIRECTS: Pick<AxiosRequestConfig, 'maxRedirects' | 'proxy'> = {
  maxRedirects: 0,
  proxy: false,
};

/**
 * A 5xx answer, thrown inside the circuit breaker so it counts as the target failing
 * (isTargetFailure counts an error of no HTTP kind), then answered as the SCIM error it carries.
 */
class ScimServerFailure extends Error {
  constructor(readonly response: AxiosResponse) {
    super(`SCIM server answered HTTP ${response.status}`);
  }
}

@Injectable()
export class SCIMClient {
  private readonly logger = new Logger(SCIMClient.name);
  private readonly httpsAgent = createSsrfSafeHttpsAgent();

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly circuitBreaker: ConnectorCircuitBreakerService,
  ) {}

  // --- User CRUD ---

  async createUser(config: SCIMConnectorConfig, user: SCIMUser): Promise<SCIMUser> {
    return this.request<SCIMUser>(config, 'POST', '/Users', user);
  }

  async getUser(config: SCIMConnectorConfig, id: string): Promise<SCIMUser> {
    return this.request<SCIMUser>(config, 'GET', `/Users/${encodeURIComponent(id)}`);
  }

  async updateUser(config: SCIMConnectorConfig, id: string, user: SCIMUser): Promise<SCIMUser> {
    return this.request<SCIMUser>(config, 'PUT', `/Users/${encodeURIComponent(id)}`, user);
  }

  async patchUser(config: SCIMConnectorConfig, id: string, ops: SCIMPatchOp): Promise<SCIMUser> {
    return this.request<SCIMUser>(config, 'PATCH', `/Users/${encodeURIComponent(id)}`, ops);
  }

  async deleteUser(config: SCIMConnectorConfig, id: string): Promise<void> {
    await this.request<void>(config, 'DELETE', `/Users/${encodeURIComponent(id)}`);
  }

  async listUsers(
    config: SCIMConnectorConfig,
    filter?: string,
    startIndex?: number,
    count?: number,
  ): Promise<SCIMListResponse<SCIMUser>> {
    const params = new URLSearchParams();
    if (filter) params.set('filter', filter);
    if (startIndex !== undefined) params.set('startIndex', String(startIndex));
    if (count !== undefined) params.set('count', String(count));

    const query = params.toString();
    const path = query ? `/Users?${query}` : '/Users';
    return this.request<SCIMListResponse<SCIMUser>>(config, 'GET', path);
  }

  // --- Group CRUD ---

  async createGroup(config: SCIMConnectorConfig, group: SCIMGroup): Promise<SCIMGroup> {
    return this.request<SCIMGroup>(config, 'POST', '/Groups', group);
  }

  async listGroups(
    config: SCIMConnectorConfig,
    filter?: string,
    startIndex?: number,
    count?: number,
  ): Promise<SCIMListResponse<SCIMGroup>> {
    const params = new URLSearchParams();
    if (filter) params.set('filter', filter);
    if (startIndex !== undefined) params.set('startIndex', String(startIndex));
    if (count !== undefined) params.set('count', String(count));
    const query = params.toString();
    const path = query ? `/Groups?${query}` : '/Groups';
    return this.request<SCIMListResponse<SCIMGroup>>(config, 'GET', path);
  }

  async patchGroup(config: SCIMConnectorConfig, id: string, ops: SCIMPatchOp): Promise<SCIMGroup> {
    return this.request<SCIMGroup>(config, 'PATCH', `/Groups/${encodeURIComponent(id)}`, ops);
  }

  // --- Health ---

  async healthCheck(config: SCIMConnectorConfig): Promise<boolean> {
    try {
      await this.request<Record<string, unknown>>(config, 'GET', '/ServiceProviderConfig');
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch ServiceProviderConfig for capability validation (filter, patch, bulk support). */
  async getServiceProviderConfig(config: SCIMConnectorConfig): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(config, 'GET', '/ServiceProviderConfig');
  }

  // --- Core HTTP Engine ---

  /**
   * One SCIM call. A 401 to an OAuth2 config drops its cached token and the call is made once
   * more with a new one (`retried` marks that second try): a revoked or rotated token would
   * otherwise fail every call until its TTL ends.
   */
  private async request<T>(
    config: SCIMConnectorConfig,
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    if (process.env.NODE_ENV === 'production') {
      try {
        const parsed = new URL(config.baseUrl);
        if (parsed.protocol !== 'https:') {
          throw new BadRequestException('SCIM connections must use HTTPS in production');
        }
      } catch (e: unknown) {
        if (e instanceof TypeError) {
          throw new BadRequestException('Invalid SCIM baseUrl');
        }
        throw e;
      }
    }

    await validateUrlForFetch(config.baseUrl);

    const url = `${config.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers = await this.buildHeaders(config);

    const axiosConfig: AxiosRequestConfig = {
      method,
      url,
      headers,
      data: body,
      validateStatus: () => true, // Don't throw on non-2xx — we handle it below
      timeout: CONNECTOR_TIMEOUT_MS,
      ...NO_REDIRECTS,
      httpsAgent: this.httpsAgent,
    };

    this.logger.debug(`SCIM ${method} ${path}`);

    // The breaker of this tenant and base URL: no answer (a network error, the timeout) and a
    // 5xx answer count; a 4xx or 429 is the server answering
    let response: AxiosResponse;
    try {
      response = await this.circuitBreaker.execute(
        CONNECTOR_NAME,
        async () => {
          const answered = await axios(axiosConfig);
          if (answered.status >= 500) throw new ScimServerFailure(answered);
          return answered;
        },
        config.baseUrl,
      );
    } catch (err: unknown) {
      if (!(err instanceof ScimServerFailure)) throw err;
      response = err.response;
    }

    if (response.status === 401 && config.authType === 'oauth2' && !retried) {
      this.logger.warn(`SCIM ${method} ${path}: token refused (401), fetching a new one`);
      await this.invalidateToken(config);
      return this.request<T>(config, method, path, body, true);
    }

    // Handle 429 rate limiting before generic error handling
    if (response.status === 429) {
      const retryAfter = response.headers?.['retry-after'];
      const retryMs =
        retryAfter != null ? Math.max(1000, parseInt(String(retryAfter), 10) * 1000) : 60_000;
      throw new RateLimitedException(retryMs, 'scim');
    }

    if (response.status >= 300 && response.status < 400) {
      throw new BadRequestException(
        `The SCIM server answered ${path} with a redirect (HTTP ${response.status}), which ` +
          'EuroID does not follow: set the base URL to the address it redirects to',
      );
    }

    // Handle SCIM error responses
    if (response.status >= 400) {
      this.handleErrorResponse(response.status, response.data, path);
    }

    // 204 No Content (e.g. DELETE)
    if (response.status === 204 || !response.data) {
      return undefined as T;
    }

    return response.data as T;
  }

  // --- Auth ---

  private async buildHeaders(config: SCIMConnectorConfig): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': SCIM_CONTENT_TYPE,
      Accept: SCIM_ACCEPT_TYPES.join(', '),
    };

    switch (config.authType) {
      case 'bearer':
        if (!config.bearerToken) throw new BadRequestException('SCIM bearer token is required');
        headers['Authorization'] = `Bearer ${config.bearerToken}`;
        break;

      case 'basic':
        if (!config.username || !config.password)
          throw new BadRequestException('SCIM basic auth credentials are required');
        headers['Authorization'] =
          `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
        break;

      case 'oauth2': {
        const token = await this.ensureOAuth2Token(config);
        headers['Authorization'] = `Bearer ${token}`;
        break;
      }

      default:
        throw new BadRequestException(`Unsupported SCIM auth type: ${config.authType}`);
    }

    return headers;
  }

  /**
   * OAuth2 client credentials flow with token caching (Redis or in-memory).
   * Refreshes token when expired or on first call.
   */
  private async ensureOAuth2Token(config: SCIMConnectorConfig): Promise<string> {
    if (!config.oauth2TokenUrl || !config.clientId || !config.clientSecret) {
      throw new BadRequestException(
        'SCIM OAuth2 requires oauth2TokenUrl, clientId, and clientSecret',
      );
    }

    await validateUrlForFetch(config.oauth2TokenUrl);

    const cacheKey = oauthCacheKey(config);
    const cached = await this.cache.get<CachedOAuthToken>(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAtMs > now) {
      return cached.accessToken;
    }

    this.logger.log(`Fetching OAuth2 token from ${config.oauth2TokenUrl}`);

    const clientId = config.clientId;
    const clientSecret = config.clientSecret;
    const tokenUrl = config.oauth2TokenUrl;
    if (!clientId || !clientSecret || !tokenUrl) {
      throw new BadRequestException(
        'SCIM OAuth2 config missing clientId, clientSecret, or oauth2TokenUrl',
      );
    }

    try {
      // The breaker of this tenant and token URL: a refused client (4xx) is never counted
      const res = await this.circuitBreaker.execute(
        CONNECTOR_NAME,
        () =>
          axios.post(
            tokenUrl,
            new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: clientId,
              client_secret: clientSecret,
            }),
            {
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              timeout: CONNECTOR_TIMEOUT_MS,
              ...NO_REDIRECTS,
              httpsAgent: this.httpsAgent,
            },
          ),
        tokenUrl,
      );

      const accessToken: string = res.data.access_token;
      const expiresIn: number = res.data.expires_in ?? 3600;
      const ttlMs = Math.max(60_000, (expiresIn - TOKEN_PREEXPIRE_SEC) * 1000);
      const expiresAtMs = now + ttlMs;

      await this.cache.set(cacheKey, { accessToken, expiresAtMs }, ttlMs);

      this.logger.log('OAuth2 token acquired and cached');
      return accessToken;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`OAuth2 token acquisition failed: ${message}`);
      throw new BadRequestException(`SCIM OAuth2 authentication failed: ${message}`);
    }
  }

  /** Drop the cached OAuth2 token of a config (a call answered 401 with it). */
  async invalidateToken(config: SCIMConnectorConfig): Promise<void> {
    if (config.authType === 'oauth2' && config.clientId) {
      await this.cache.del(oauthCacheKey(config));
    }
  }

  // --- Error Handling ---

  private handleErrorResponse(
    status: number,
    data: Record<string, unknown> | undefined,
    path: string,
  ): never {
    let detail = `SCIM API error [${path}]: HTTP ${status}`;
    let scimType: string | undefined;

    // Try to parse SCIM error body
    if (data && typeof data === 'object') {
      const schemas = data.schemas as string[] | undefined;
      if (schemas?.includes(SCIM_SCHEMAS.ERROR)) {
        detail = (data.detail as string) || detail;
        scimType = data.scimType as string | undefined;
      } else if (data.detail) {
        detail = data.detail as string;
      } else if (data.message) {
        detail = data.message as string;
      }
    }

    throw new SCIMError(scimType, detail, String(status));
  }
}

// --- TASK_103 recap: 429 handling — parse Retry-After, throw RateLimitedException(retryMs, 'scim').
// ── TASK 107 RECAP ──
// Added: getServiceProviderConfig() — fetches /ServiceProviderConfig for validateCapabilities.
