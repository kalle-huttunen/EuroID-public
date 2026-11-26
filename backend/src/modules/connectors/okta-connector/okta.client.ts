/**
 * OktaClient — Low-level HTTP client for Okta REST API.
 *
 * Auth: SSWS token header (Authorization: SSWS ${apiToken}).
 * Handles rate limiting (429 with Retry-After) and 409 Conflict for idempotency.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { OktaConfig, OktaUser, OktaGroup, OktaApplication } from './okta.interface';
import { OKTA_API_V1, DEFAULT_RATE_LIMIT_DELAY_MS } from './okta.constants';
import { CONNECTOR_TIMEOUT_MS } from '@infrastructure/config/defaults';
import {
  checkUrlWithoutDns,
  createSsrfSafeHttpsAgent,
} from '@infrastructure/url-validation/ssrf-guard';

@Injectable()
export class OktaClient {
  private readonly logger = new Logger(OktaClient.name);
  /**
   * SSRF guard for the tenant's org URL (connectors ARCHITECTURE.md, SSRF Protection): checked
   * before each request (https, no blocked name or IP literal); the agent checks every address
   * the host resolves to at connect, so the API token never reaches a private address.
   */
  private readonly httpsAgent = createSsrfSafeHttpsAgent();

  private createAxios(config: OktaConfig): AxiosInstance {
    checkUrlWithoutDns(config.orgUrl);
    const baseURL = config.orgUrl.replace(/\/+$/, '');
    return axios.create({
      baseURL: `${baseURL}${OKTA_API_V1}`,
      timeout: CONNECTOR_TIMEOUT_MS,
      // The agent must make the connection it checked: no redirect, no proxy from the environment
      maxRedirects: 0,
      httpsAgent: this.httpsAgent,
      proxy: false,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `SSWS ${config.apiToken}`,
      },
    });
  }

  /**
   * Execute a request with rate-limit retry (429 + Retry-After).
   * Retries once on 429; propagates all other errors.
   */
  private async withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      if (this.isAxiosError(err) && err.response?.status === 429) {
        const retryAfter = parseInt((err.response.headers?.['retry-after'] as string) ?? '', 10);
        const delayMs = isNaN(retryAfter) ? DEFAULT_RATE_LIMIT_DELAY_MS : retryAfter * 1000;
        this.logger.warn(`Rate limited by Okta. Retrying after ${delayMs}ms`);
        await this.sleep(delayMs);
        return fn();
      }
      throw err;
    }
  }

  // ── User Operations ──

  async getUser(config: OktaConfig, userId: string): Promise<OktaUser> {
    const client = this.createAxios(config);
    return this.withRateLimitRetry(async () => {
      const res = await client.get<OktaUser>(`/users/${encodeURIComponent(userId)}`);
      return res.data;
    });
  }

  async createUser(
    config: OktaConfig,
    profile: Record<string, unknown>,
    activate = true,
  ): Promise<OktaUser> {
    const client = this.createAxios(config);
    return this.withRateLimitRetry(async () => {
      const res = await client.post<OktaUser>(`/users?activate=${activate}`, { profile });
      return res.data;
    });
  }

  async updateUser(
    config: OktaConfig,
    userId: string,
    profile: Record<string, unknown>,
  ): Promise<OktaUser> {
    const client = this.createAxios(config);
    return this.withRateLimitRetry(async () => {
      const res = await client.post<OktaUser>(`/users/${encodeURIComponent(userId)}`, { profile });
      return res.data;
    });
  }

  async deactivateUser(config: OktaConfig, userId: string): Promise<void> {
    const client = this.createAxios(config);
    await this.withRateLimitRetry(async () => {
      await client.post(`/users/${encodeURIComponent(userId)}/lifecycle/deactivate`);
    });
  }

  /**
   * POST /users/{id}/lifecycle/activate?sendEmail=true: a STAGED user becomes PROVISIONED and
   * Okta emails its owner the activation link (ACTIVE once the owner finishes).
   */
  async activateUser(config: OktaConfig, userId: string): Promise<void> {
    const client = this.createAxios(config);
    await this.withRateLimitRetry(async () => {
      await client.post(`/users/${encodeURIComponent(userId)}/lifecycle/activate?sendEmail=true`);
    });
  }

  /** POST /users/{id}/lifecycle/suspend: Okta suspends only an ACTIVE user. */
  async suspendUser(config: OktaConfig, userId: string): Promise<void> {
    const client = this.createAxios(config);
    await this.withRateLimitRetry(async () => {
      await client.post(`/users/${encodeURIComponent(userId)}/lifecycle/suspend`);
    });
  }

  /** POST /users/{id}/lifecycle/unsuspend: a SUSPENDED user becomes ACTIVE again. */
  async unsuspendUser(config: OktaConfig, userId: string): Promise<void> {
    const client = this.createAxios(config);
    await this.withRateLimitRetry(async () => {
      await client.post(`/users/${encodeURIComponent(userId)}/lifecycle/unsuspend`);
    });
  }

  async deleteUser(config: OktaConfig, userId: string): Promise<void> {
    const client = this.createAxios(config);
    await this.withRateLimitRetry(async () => {
      await client.delete(`/users/${encodeURIComponent(userId)}`);
    });
  }

  // ── Group Operations ──

  async listGroups(config: OktaConfig): Promise<OktaGroup[]> {
    const client = this.createAxios(config);
    return this.withRateLimitRetry(async () => {
      const res = await client.get<OktaGroup[]>('/groups?limit=200');
      return res.data;
    });
  }

  async addUserToGroup(config: OktaConfig, groupId: string, userId: string): Promise<void> {
    const client = this.createAxios(config);
    try {
      await this.withRateLimitRetry(async () => {
        await client.put(
          `/groups/${encodeURIComponent(groupId)}/users/${encodeURIComponent(userId)}`,
        );
      });
    } catch (err: unknown) {
      // 409 = already a member — idempotent success (Safety Rule 7)
      if (this.isAxiosError(err) && err.response?.status === 409) {
        this.logger.log(`User ${userId} already in group ${groupId} — treating as success`);
        return;
      }
      throw err;
    }
  }

  async removeUserFromGroup(config: OktaConfig, groupId: string, userId: string): Promise<void> {
    const client = this.createAxios(config);
    try {
      await this.withRateLimitRetry(async () => {
        await client.delete(
          `/groups/${encodeURIComponent(groupId)}/users/${encodeURIComponent(userId)}`,
        );
      });
    } catch (err: unknown) {
      // 404 = user not in group — idempotent success
      if (this.isAxiosError(err) && err.response?.status === 404) {
        this.logger.log(`User ${userId} not in group ${groupId} — treating as success`);
        return;
      }
      throw err;
    }
  }

  /**
   * Groups the user is a direct member of, every page (follows `Link: rel="next"`, only to this
   * org's API). Each group carries its `type`: OKTA_GROUP, APP_GROUP or BUILT_IN.
   */
  async listUserGroups(config: OktaConfig, userId: string): Promise<OktaGroup[]> {
    const client = this.createAxios(config);
    const groups: OktaGroup[] = [];
    let path: string | undefined = `/users/${encodeURIComponent(userId)}/groups`;
    while (path) {
      const pagePath: string = path;
      const res = await this.withRateLimitRetry(() => client.get<OktaGroup[]>(pagePath));
      groups.push(...(res.data ?? []));
      path = this.nextPagePath(res.headers?.link, config);
    }
    return groups;
  }

  // ── Application Operations ──

  async listApplications(config: OktaConfig): Promise<OktaApplication[]> {
    const client = this.createAxios(config);
    return this.withRateLimitRetry(async () => {
      const res = await client.get<OktaApplication[]>('/apps?limit=200');
      return res.data;
    });
  }

  async assignAppToUser(config: OktaConfig, appId: string, userId: string): Promise<void> {
    const client = this.createAxios(config);
    try {
      await this.withRateLimitRetry(async () => {
        await client.post(`/apps/${encodeURIComponent(appId)}/users`, {
          id: userId,
        });
      });
    } catch (err: unknown) {
      // 409 = already assigned — idempotent success
      if (this.isAxiosError(err) && err.response?.status === 409) {
        this.logger.log(`User ${userId} already assigned to app ${appId} — treating as success`);
        return;
      }
      throw err;
    }
  }

  async unassignAppFromUser(config: OktaConfig, appId: string, userId: string): Promise<void> {
    const client = this.createAxios(config);
    try {
      await this.withRateLimitRetry(async () => {
        await client.delete(
          `/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(userId)}`,
        );
      });
    } catch (err: unknown) {
      // 404 = not assigned — idempotent success
      if (this.isAxiosError(err) && err.response?.status === 404) {
        this.logger.log(`User ${userId} not assigned to app ${appId} — treating as success`);
        return;
      }
      throw err;
    }
  }

  // ── Health Check ──

  async healthCheck(config: OktaConfig): Promise<boolean> {
    try {
      const client = this.createAxios(config);
      const res = await client.get('/org');
      return res.status === 200;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 401 || status === 403) {
          this.logger.warn(`[HEALTH] Okta auth failed: ${message}`);
        } else {
          this.logger.warn(`[HEALTH] Okta check failed (${status}): ${message}`);
        }
      } else {
        this.logger.warn(`[HEALTH] Okta check failed: ${message}`);
      }
      return false;
    }
  }

  // ── Helpers ──

  /** Path (relative to the API base) of the `rel="next"` link, when it points at this org. */
  private nextPagePath(link: unknown, config: OktaConfig): string | undefined {
    const header = Array.isArray(link) ? link.join(',') : link;
    if (typeof header !== 'string') return undefined;
    const base = `${config.orgUrl.replace(/\/+$/, '')}${OKTA_API_V1}`;
    for (const part of header.split(',')) {
      const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
      if (match && match[1].startsWith(`${base}/`)) return match[1].slice(base.length);
    }
    return undefined;
  }

  private isAxiosError(err: unknown): err is AxiosError {
    return (
      typeof err === 'object' &&
      err !== null &&
      'isAxiosError' in err &&
      (err as AxiosError).isAxiosError === true
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
