/**
 * ServiceNowClient — HTTP client for ServiceNow REST API.
 *
 * Auth: OAuth2 client credentials flow with Basic auth fallback.
 * Handles token caching, 429 rate limiting, and 409 idempotency.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { createHash } from 'crypto';
import { CONNECTOR_TIMEOUT_MS } from '@infrastructure/config/defaults';
import {
  checkUrlWithoutDns,
  createSsrfSafeHttpsAgent,
} from '@infrastructure/url-validation/ssrf-guard';
import {
  ServiceNowConfig,
  ServiceNowOAuthToken,
  ServiceNowUser,
  ServiceNowIncident,
  ServiceNowGroup,
  ServiceNowListResponse,
  ServiceNowSingleResponse,
} from './servicenow.interface';

/** Buffer (seconds) before actual expiry to refresh token early */
const TOKEN_EXPIRY_BUFFER_S = 60;
/** Max retries on 429 rate limiting */
const MAX_RATE_LIMIT_RETRIES = 3;
/** Base delay (ms) for rate-limit backoff */
const RATE_LIMIT_BACKOFF_MS = 2000;
/** Wait before retrying a 429 that names no delay (deprovision calls). */
const DEFAULT_RATE_LIMIT_MS = 60_000;

@Injectable()
export class ServiceNowClient {
  private readonly logger = new Logger(ServiceNowClient.name);
  /**
   * Token cache keyed by instance URL, client id and a hash of the secret: a config that names
   * the same instance (or also the same client id) never gets another config's token.
   */
  private tokenCache = new Map<string, ServiceNowOAuthToken>();
  /**
   * SSRF guard for the tenant's instance URL (connectors ARCHITECTURE.md, SSRF Protection): the
   * URL is checked before each request (https, no blocked name or IP literal) and the agent
   * checks every address a host name resolves to at connect, so no request (the OAuth token
   * request with the client secret included) reaches a private or cloud metadata address.
   */
  private readonly httpsAgent = createSsrfSafeHttpsAgent();
  /** The agent must make the connection it checked: no redirect, no proxy from the environment. */
  private readonly guarded = {
    maxRedirects: 0,
    httpsAgent: this.httpsAgent,
    proxy: false as const,
  };

  // ── Auth ────────────────────────────────────────────────

  /**
   * Get a valid access token via OAuth2 client credentials flow.
   * Falls back to Basic auth header if clientId is not configured.
   */
  private async getAuthHeaders(config: ServiceNowConfig): Promise<Record<string, string>> {
    if (!config.clientId || !config.clientSecret) {
      return this.getBasicAuthHeaders(config);
    }

    const secretHash = createHash('sha256').update(config.clientSecret).digest('hex');
    const cacheKey = `${config.instanceUrl}|${config.clientId}|${secretHash}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() / 1000 + TOKEN_EXPIRY_BUFFER_S) {
      return { Authorization: `Bearer ${cached.accessToken}` };
    }

    try {
      const tokenUrl = `${config.instanceUrl}/oauth_token.do`;
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });

      const res = await axios.post(tokenUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: CONNECTOR_TIMEOUT_MS,
        ...this.guarded,
      });

      const token: ServiceNowOAuthToken = {
        accessToken: res.data.access_token,
        expiresAt: Date.now() / 1000 + (res.data.expires_in ?? 1800),
      };
      this.tokenCache.set(cacheKey, token);
      return { Authorization: `Bearer ${token.accessToken}` };
    } catch (err: unknown) {
      this.logger.warn('[AUTH] OAuth2 token request failed, falling back to Basic auth');
      return this.getBasicAuthHeaders(config);
    }
  }

  private getBasicAuthHeaders(config: ServiceNowConfig): Record<string, string> {
    if (!config.username || !config.password) {
      throw new ConnectorException(
        'ServiceNow: No valid auth. Provide clientId/clientSecret (OAuth2) or username/password (Basic).',
      );
    }
    const encoded = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }

  // ── Axios factory ──────────────────────────────────────

  private async createAxios(config: ServiceNowConfig): Promise<AxiosInstance> {
    // Before the token request too: it goes to the same instance URL
    checkUrlWithoutDns(config.instanceUrl);
    const authHeaders = await this.getAuthHeaders(config);
    return axios.create({
      baseURL: config.instanceUrl,
      timeout: CONNECTOR_TIMEOUT_MS,
      ...this.guarded,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...authHeaders,
      },
    });
  }

  /** Execute request with rate-limit retry (429 handling) */
  private async executeWithRetry<T>(
    client: AxiosInstance,
    requestFn: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        return await requestFn();
      } catch (err: unknown) {
        const status = this.extractStatus(err);
        if (status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
          const delay = RATE_LIMIT_BACKOFF_MS * Math.pow(2, attempt);
          this.logger.warn(
            `[RATE_LIMIT] 429 received, retrying in ${delay}ms (attempt ${attempt + 1})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
    throw new ConnectorException('ServiceNow: max rate-limit retries exceeded');
  }

  // ── User operations (sys_user) ────────────────────────

  async createUser(
    config: ServiceNowConfig,
    fields: Record<string, string>,
  ): Promise<ServiceNowUser> {
    const client = await this.createAxios(config);
    try {
      const res = await this.executeWithRetry(client, () =>
        client.post<ServiceNowSingleResponse<ServiceNowUser>>('/api/now/table/sys_user', fields),
      );
      return res.data.result;
    } catch (err: unknown) {
      if (this.extractStatus(err) === 409) {
        this.logger.log('[CREATE_USER] 409 Conflict — user already exists, treating as success');
        const existing = await this.getUser(config, fields.email);
        if (existing) return existing;
      }
      throw this.wrapError('createUser', err);
    }
  }

  async updateUser(
    config: ServiceNowConfig,
    sysId: string,
    fields: Record<string, string>,
  ): Promise<ServiceNowUser> {
    const client = await this.createAxios(config);
    try {
      const res = await this.executeWithRetry(client, () =>
        client.patch<ServiceNowSingleResponse<ServiceNowUser>>(
          `/api/now/table/sys_user/${sysId}`,
          fields,
        ),
      );
      return res.data.result;
    } catch (err: unknown) {
      throw this.wrapError('updateUser', err);
    }
  }

  async getUser(config: ServiceNowConfig, email: string): Promise<ServiceNowUser | null> {
    const client = await this.createAxios(config);
    try {
      const res = await this.executeWithRetry(client, () =>
        client.get<ServiceNowListResponse<ServiceNowUser>>('/api/now/table/sys_user', {
          // `^` separates encoded-query terms: escaped (`^^`) so the email stays one term
          params: { sysparm_query: `email=${email.replace(/\^/g, '^^')}`, sysparm_limit: 1 },
        }),
      );
      return res.data.result?.[0] ?? null;
    } catch (err: unknown) {
      throw this.wrapError('getUser', err);
    }
  }

  // ── Deprovision (sys_user) ─────────────────────────────
  // Errors keep their HTTP status (the activity decides about retries); a 429 becomes
  // RateLimitedException so Temporal waits the retry-after instead of this client sleeping.

  /** The sys_user record with this sys_id, or null when it does not exist (404). */
  async getUserBySysId(config: ServiceNowConfig, sysId: string): Promise<ServiceNowUser | null> {
    const client = await this.createAxios(config);
    try {
      const res = await client.get<ServiceNowSingleResponse<ServiceNowUser>>(
        `/api/now/table/sys_user/${encodeURIComponent(sysId)}`,
        { params: { sysparm_fields: 'sys_id,active,locked_out' } },
      );
      return res.data.result ?? null;
    } catch (err: unknown) {
      if (this.extractStatus(err) === 404) return null;
      throw this.rateLimitOf(err) ?? err;
    }
  }

  /**
   * The sys_user records whose `field` (email or user_name) equals `value` (at most two: more
   * than one is ambiguous). `^` separates encoded-query terms, so it is escaped (`^^`) to keep
   * the value one term.
   */
  async findUsersBy(
    config: ServiceNowConfig,
    field: 'email' | 'user_name',
    value: string,
  ): Promise<ServiceNowUser[]> {
    const client = await this.createAxios(config);
    try {
      const res = await client.get<ServiceNowListResponse<ServiceNowUser>>(
        '/api/now/table/sys_user',
        {
          params: {
            sysparm_query: `${field}=${value.replace(/\^/g, '^^')}`,
            sysparm_fields: 'sys_id,active,locked_out',
            sysparm_limit: 2,
          },
        },
      );
      return res.data.result ?? [];
    } catch (err: unknown) {
      throw this.rateLimitOf(err) ?? err;
    }
  }

  /**
   * Deactivate and lock a sys_user record (active=false, locked_out=true); the record stays.
   * @returns false when the record does not exist (404)
   */
  async deactivateUser(config: ServiceNowConfig, sysId: string): Promise<boolean> {
    const client = await this.createAxios(config);
    try {
      await client.patch(`/api/now/table/sys_user/${encodeURIComponent(sysId)}`, {
        active: 'false',
        locked_out: 'true',
      });
      return true;
    } catch (err: unknown) {
      if (this.extractStatus(err) === 404) return false;
      throw this.rateLimitOf(err) ?? err;
    }
  }

  private rateLimitOf(err: unknown): RateLimitedException | null {
    if (this.extractStatus(err) !== 429) return null;
    const headers = (err as { response?: { headers?: Record<string, string | undefined> } })
      .response?.headers;
    const retryAfter = parseInt(headers?.['retry-after'] ?? '', 10);
    return new RateLimitedException(
      isNaN(retryAfter) ? DEFAULT_RATE_LIMIT_MS : Math.max(1000, retryAfter * 1000),
      'servicenow',
    );
  }

  // ── Incident operations ────────────────────────────────

  async createIncident(
    config: ServiceNowConfig,
    fields: Record<string, string>,
  ): Promise<ServiceNowIncident> {
    const client = await this.createAxios(config);
    try {
      const res = await this.executeWithRetry(client, () =>
        client.post<ServiceNowSingleResponse<ServiceNowIncident>>(
          '/api/now/table/incident',
          fields,
        ),
      );
      return res.data.result;
    } catch (err: unknown) {
      throw this.wrapError('createIncident', err);
    }
  }

  /**
   * The active incident whose correlation_id is `correlationId`, or null. The value is EuroID's
   * own key (no `^`), so it is one encoded-query term.
   */
  async findOpenIncident(
    config: ServiceNowConfig,
    correlationId: string,
  ): Promise<ServiceNowIncident | null> {
    const client = await this.createAxios(config);
    try {
      const res = await client.get<ServiceNowListResponse<ServiceNowIncident>>(
        '/api/now/table/incident',
        {
          params: {
            sysparm_query: `correlation_id=${correlationId}^active=true`,
            sysparm_fields: 'sys_id,number,state,short_description,priority',
            sysparm_limit: 1,
          },
        },
      );
      return res.data.result?.[0] ?? null;
    } catch (err: unknown) {
      throw this.rateLimitOf(err) ?? err;
    }
  }

  // ── Change Request operations ──────────────────────────

  async createChangeRequest(
    config: ServiceNowConfig,
    fields: Record<string, string>,
  ): Promise<{ sys_id: string; number: string }> {
    const client = await this.createAxios(config);
    try {
      const res = await this.executeWithRetry(client, () =>
        client.post<ServiceNowSingleResponse<{ sys_id: string; number: string }>>(
          '/api/now/table/change_request',
          fields,
        ),
      );
      return res.data.result;
    } catch (err: unknown) {
      throw this.wrapError('createChangeRequest', err);
    }
  }

  // ── Assignment groups ──────────────────────────────────

  async listAssignmentGroups(config: ServiceNowConfig): Promise<ServiceNowGroup[]> {
    const client = await this.createAxios(config);
    try {
      const res = await this.executeWithRetry(client, () =>
        client.get<ServiceNowListResponse<ServiceNowGroup>>('/api/now/table/sys_user_group', {
          params: { sysparm_query: 'active=true', sysparm_limit: 500 },
        }),
      );
      return res.data.result ?? [];
    } catch (err: unknown) {
      throw this.wrapError('listAssignmentGroups', err);
    }
  }

  // ── Health check ───────────────────────────────────────

  async healthCheck(config: ServiceNowConfig): Promise<boolean> {
    try {
      const client = await this.createAxios(config);
      const res = await client.get('/api/now/table/sys_properties', {
        params: { sysparm_limit: 1 },
      });
      return res.status === 200;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = this.extractStatus(err);
      if (status === 401 || status === 403) {
        this.logger.warn(`[HEALTH] ServiceNow auth failed: ${message}`);
      } else {
        this.logger.warn(`[HEALTH] ServiceNow check failed: ${message}`);
      }
      return false;
    }
  }

  // ── Helpers ────────────────────────────────────────────

  private extractStatus(err: unknown): number | undefined {
    if (err && typeof err === 'object' && 'response' in err) {
      return (err as { response?: { status?: number } }).response?.status;
    }
    return undefined;
  }

  private wrapError(method: string, err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    const status = this.extractStatus(err);
    this.logger.error(`[${method}] ServiceNow API error (${status ?? 'unknown'}): ${message}`);
    if (err instanceof ConnectorException) return err;
    return new ConnectorException(`ServiceNow ${method} failed: ${message}`);
  }
}
