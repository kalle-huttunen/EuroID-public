/**
 * GitHubClient — HTTP client for GitHub API.
 */

import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import axios, { AxiosInstance } from 'axios';
import { GitHubAccount, GitHubConfig, GitHubOrgInvitation } from './github.interface';
import { CONNECTOR_TIMEOUT_MS, GITHUB_INVITATION_MAX_PAGES } from '@infrastructure/config/defaults';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { maskEmail } from '../../identity/identity-pii';

const GITHUB_API_BASE = 'https://api.github.com';
const INVITATION_PAGE_SIZE = 100;
/** Wait before retrying a rate-limited call that names no delay. */
const DEFAULT_RATE_LIMIT_MS = 60_000;

interface GitHubErrorResponse {
  status?: number;
  headers?: Record<string, string | undefined>;
  data?: unknown;
}

function responseOf(err: unknown): GitHubErrorResponse | undefined {
  return err && typeof err === 'object' && 'response' in err
    ? (err as { response?: GitHubErrorResponse }).response
    : undefined;
}

/**
 * GitHub signals rate limits with 429, or 403 with x-ratelimit-remaining: 0 (primary limit) or a
 * retry-after header (secondary limit). Those become RateLimitedException so Temporal waits.
 */
function rateLimitOf(err: unknown): RateLimitedException | null {
  const res = responseOf(err);
  const headers = res?.headers ?? {};
  const limited =
    res?.status === 429 ||
    (res?.status === 403 &&
      (headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] !== undefined));
  if (!limited) return null;
  const retryAfter = parseInt(headers['retry-after'] ?? '', 10);
  const resetAt = parseInt(headers['x-ratelimit-reset'] ?? '', 10);
  const waitMs = !isNaN(retryAfter)
    ? retryAfter * 1000
    : !isNaN(resetAt)
      ? resetAt * 1000 - Date.now()
      : DEFAULT_RATE_LIMIT_MS;
  return new RateLimitedException(Math.max(1000, waitMs), 'github');
}

/** GitHub reasons (message, or errors[].message) that mean the invitee is already in or invited. */
const ALREADY_IN_ORG = [
  'already a member',
  'already a part of',
  'invitation already exists',
  'already been invited',
  'already invited',
];

function alreadyInvitedOrMember(
  data: { message?: string; errors?: Array<{ message?: unknown }> } | undefined,
): boolean {
  const reasons = [data?.message, ...(data?.errors ?? []).map((e) => e?.message)]
    .filter((m): m is string => typeof m === 'string')
    .join(' ')
    .toLowerCase();
  return ALREADY_IN_ORG.some((phrase) => reasons.includes(phrase));
}

@Injectable()
export class GitHubClient {
  private readonly logger = new Logger(GitHubClient.name);

  private createAxios(config: GitHubConfig): AxiosInstance {
    return axios.create({
      baseURL: GITHUB_API_BASE,
      timeout: CONNECTOR_TIMEOUT_MS,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${config.personalAccessToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }

  /**
   * Create organization invitation by email.
   * @returns the new invitation's id when GitHub created one (201); none when the person was
   *   already invited or a member (422, treated as success). A rate limit becomes
   *   RateLimitedException; throws on other unexpected errors.
   */
  async createInvitation(
    config: GitHubConfig,
    email: string,
  ): Promise<{ targetUserId: string; invitationId?: number }> {
    const axios = this.createAxios(config);
    try {
      const res = await axios.post<Partial<GitHubOrgInvitation>>(
        `/orgs/${encodeURIComponent(config.orgName)}/invitations`,
        {
          invitee_id: null,
          email,
          role: 'direct_member',
        } as { invitee_id: null; email: string; role: 'direct_member' },
      );
      if (res.status === 201) {
        const id = res.data?.id;
        return {
          targetUserId: `github-${email}`,
          ...(typeof id === 'number' ? { invitationId: id } : {}),
        };
      }
      throw new ConnectorException(`Unexpected GitHub response: ${res.status}`);
    } catch (err: unknown) {
      // A rate limit first: GitHub signals it with 403 too, which is not an auth failure
      const limited = rateLimitOf(err);
      if (limited) throw limited;
      const obj =
        err && typeof err === 'object' && 'response' in err
          ? (
              err as {
                response?: {
                  status?: number;
                  data?: { message?: string; errors?: Array<{ message?: unknown }> };
                };
              }
            ).response
          : undefined;
      const status = obj?.status;
      const data = obj?.data;

      // Already a member, or already invited: idempotent. GitHub answers 422 "Validation
      // Failed" with the reason in errors[]; when no reason says so, a pending invitation for
      // the email does
      if (
        status === 422 &&
        (alreadyInvitedOrMember(data) || (await this.hasInvitation(config, email)))
      ) {
        this.logger.log(
          `[INVITE] ${maskEmail(email)} already member/invited — treating as success`,
        );
        return { targetUserId: `github-${email}` };
      }

      if (status === 404) {
        throw new NotFoundException('GitHub organization not found. Check orgName.');
      }

      if (status === 401 || status === 403) {
        throw new ConnectorException('GitHub auth failed. Ensure PAT has admin:org scope.');
      }

      throw err;
    }
  }

  /** Whether the organization has a pending invitation for `email`; a failed lookup is no. */
  private async hasInvitation(config: GitHubConfig, email: string): Promise<boolean> {
    try {
      return (await this.findInvitation(config, email, 'invitations')) !== null;
    } catch {
      return false;
    }
  }

  /**
   * The organization's pending invitation (GET /orgs/{org}/invitations) or failed invitation
   * (GET /orgs/{org}/failed_invitations) for `email`, compared without case; null when none.
   * Errors keep their HTTP status; a rate limit becomes RateLimitedException.
   */
  async findInvitation(
    config: GitHubConfig,
    email: string,
    list: 'invitations' | 'failed_invitations',
  ): Promise<GitHubOrgInvitation | null> {
    const client = this.createAxios(config);
    const wanted = email.toLowerCase();
    try {
      for (let page = 1; page <= GITHUB_INVITATION_MAX_PAGES; page++) {
        const res = await client.get<GitHubOrgInvitation[]>(
          `/orgs/${encodeURIComponent(config.orgName)}/${list}`,
          { params: { per_page: INVITATION_PAGE_SIZE, page } },
        );
        const found = res.data.find((inv) => inv.email?.toLowerCase() === wanted);
        if (found) return found;
        if (res.data.length < INVITATION_PAGE_SIZE) return null;
      }
      throw new ConnectorException(
        `GitHub ${list}: more than ${GITHUB_INVITATION_MAX_PAGES} pages, search stopped`,
      );
    } catch (err: unknown) {
      throw rateLimitOf(err) ?? err;
    }
  }

  /**
   * Cancel a pending invitation (DELETE /orgs/{org}/invitations/{id}).
   * @returns false when GitHub no longer has it (404)
   */
  async cancelInvitation(config: GitHubConfig, invitationId: number): Promise<boolean> {
    const client = this.createAxios(config);
    try {
      await client.delete(
        `/orgs/${encodeURIComponent(config.orgName)}/invitations/${encodeURIComponent(String(invitationId))}`,
      );
      return true;
    } catch (err: unknown) {
      if (responseOf(err)?.status === 404) return false;
      throw rateLimitOf(err) ?? err;
    }
  }

  /**
   * The GitHub account with this login (GET /users/{username}) or durable user id
   * (GET /user/{account_id}); null when GitHub has none (404). A rate limit becomes
   * RateLimitedException; other errors keep their HTTP status.
   */
  async findAccount(
    config: GitHubConfig,
    ref: { login: string } | { id: number },
  ): Promise<GitHubAccount | null> {
    const client = this.createAxios(config);
    const path =
      'login' in ref
        ? `/users/${encodeURIComponent(ref.login)}`
        : `/user/${encodeURIComponent(String(ref.id))}`;
    try {
      const { data } = await client.get<GitHubAccount>(path);
      return { id: data.id, login: data.login };
    } catch (err: unknown) {
      if (responseOf(err)?.status === 404) return null;
      throw rateLimitOf(err) ?? err;
    }
  }

  /**
   * Invite a GitHub account by its user id (POST /orgs/{org}/invitations with `invitee_id`).
   * @returns the invitation's id; none when GitHub refuses (422) because the account is already
   *   a member or invited, which GET /orgs/{org}/memberships/{username} confirms (the message
   *   text is not relied on). Any other 422 is GitHub's validation error and is thrown.
   */
  async inviteAccount(
    config: GitHubConfig,
    account: GitHubAccount,
  ): Promise<{ invitationId?: number }> {
    const client = this.createAxios(config);
    try {
      const { data } = await client.post<Partial<GitHubOrgInvitation>>(
        `/orgs/${encodeURIComponent(config.orgName)}/invitations`,
        { invitee_id: account.id, role: 'direct_member' },
      );
      return typeof data?.id === 'number' ? { invitationId: data.id } : {};
    } catch (err: unknown) {
      const limited = rateLimitOf(err);
      if (limited) throw limited;
      const res = responseOf(err);
      if (res?.status === 422) {
        if (await this.membershipState(config, account.login)) return {};
        const message = (res.data as { message?: unknown } | undefined)?.message;
        throw new ConnectorException(
          `GitHub refused the invitation: ${typeof message === 'string' ? message : 'validation failed'}`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (res?.status === 404) {
        throw new NotFoundException('GitHub organization not found. Check orgName.');
      }
      if (res?.status === 401 || res?.status === 403) {
        throw new ConnectorException('GitHub auth failed. Ensure PAT has admin:org scope.');
      }
      throw err;
    }
  }

  /**
   * The account's organization membership (GET /orgs/{org}/memberships/{username}): `active`
   * (member) or `pending` (invited); null when neither (404).
   */
  async membershipState(config: GitHubConfig, login: string): Promise<'active' | 'pending' | null> {
    const client = this.createAxios(config);
    try {
      const { data } = await client.get<{ state?: string }>(
        `/orgs/${encodeURIComponent(config.orgName)}/memberships/${encodeURIComponent(login)}`,
      );
      return data?.state === 'active' || data?.state === 'pending' ? data.state : null;
    } catch (err: unknown) {
      if (responseOf(err)?.status === 404) return null;
      throw rateLimitOf(err) ?? err;
    }
  }

  /**
   * Remove the account from the organization (DELETE /orgs/{org}/memberships/{username}): a
   * member is removed, an invited account has its invitation cancelled.
   * @returns false when GitHub has neither (404)
   */
  async removeMembership(config: GitHubConfig, login: string): Promise<boolean> {
    const client = this.createAxios(config);
    try {
      await client.delete(
        `/orgs/${encodeURIComponent(config.orgName)}/memberships/${encodeURIComponent(login)}`,
      );
      return true;
    } catch (err: unknown) {
      if (responseOf(err)?.status === 404) return false;
      throw rateLimitOf(err) ?? err;
    }
  }

  /**
   * Health check: verify org exists and token has access.
   */
  async healthCheck(config: GitHubConfig): Promise<boolean> {
    try {
      const axios = this.createAxios(config);
      const res = await axios.get(`/orgs/${encodeURIComponent(config.orgName)}`);
      return res.status === 200;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const obj =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { status?: number } }).response
          : undefined;
      const status = obj?.status;
      if (status === 401 || status === 403) {
        this.logger.warn(`[HEALTH] GitHub auth failed: ${message}`);
        return false;
      }
      if (status === 404) {
        this.logger.warn(`[HEALTH] GitHub org "${config.orgName}" not found`);
        return false;
      }
      this.logger.warn(`[HEALTH] GitHub check failed: ${message}`);
      return false;
    }
  }
}
