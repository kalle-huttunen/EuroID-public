/**
 * GitHubConnector — Invites people to a GitHub organization and removes them again.
 *
 * With the identity's GitHub login (custom attribute `githubLogin`, see github.mapper.ts) the
 * account itself is invited by its user id and offboarding removes its membership. Without it
 * the person is invited by email, and offboarding can only cancel a pending invitation.
 *
 * Low-friction dev connector. Implements IConnector.
 */

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { IConnector } from '../connector.interface';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { GitHubAccountRef, GitHubConfig, GitHubProvisionResult } from './github.interface';
import { GitHubClient } from './github.client';
import { githubLoginOf, githubUserObjectId, GITHUB_LOGIN_ATTRIBUTE } from './github.mapper';
import { ConnectorConfigService } from '../connector-config.service';
import { ConnectorConfigDecryptError } from '../connector-config.errors';
import { maskEmail, maskLogin } from '@modules/identity/identity-pii';
import type { DeprovisionResult } from '@shared/types/deprovision';

const CONNECTOR_ID = 'github';

@Injectable()
export class GitHubService implements IConnector {
  private readonly logger = new Logger(GitHubService.name);

  constructor(
    private readonly client: GitHubClient,
    private readonly connectorConfig: ConnectorConfigService,
  ) {}

  /**
   * Create (provision) — invites the user to the GitHub org: the GitHub account when the
   * identity has a GitHub login, else the email address.
   */
  async create(user: StandardUserDto, _intent?: unknown): Promise<GitHubProvisionResult> {
    const cfg = await this.getConfig();
    return this.provision(cfg, user);
  }

  async healthCheck(config?: unknown): Promise<boolean> {
    let cfg: GitHubConfig;
    try {
      cfg = (config ?? (await this.getConfig())) as GitHubConfig;
    } catch (err: unknown) {
      // Not unhealthy: a process with the right key can read it (503, retried)
      if (err instanceof ConnectorConfigDecryptError) throw err;
      return false;
    }
    return this.client.healthCheck(cfg);
  }

  /**
   * Provision with explicit config (for activities/callers that pass config). `invitationId`:
   * the invitation GitHub created; none when the person was already invited or a member.
   * `account`: the GitHub account invited by its id (identity with a GitHub login). A login
   * GitHub does not know fails (422): inviting the email instead could reach another account.
   */
  async provision(config: GitHubConfig, user: StandardUserDto): Promise<GitHubProvisionResult> {
    const login = githubLoginOf(user.customAttributes);
    if (login === undefined) {
      const result = await this.client.createInvitation(config, user.email);
      this.logger.log(
        `[PROVISION] Invited ${maskEmail(user.email)} to GitHub org ${config.orgName}`,
      );
      return result;
    }
    const account = await this.client.findAccount(config, { login });
    if (!account) {
      throw new ConnectorException(
        `GitHub has no account with the login in customAttributes.${GITHUB_LOGIN_ATTRIBUTE}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const { invitationId } = await this.client.inviteAccount(config, account);
    this.logger.log(
      `[PROVISION] ${invitationId === undefined ? 'Already invited or a member' : 'Invited'}: ` +
        `GitHub account ${maskLogin(account.login)} in ${config.orgName}`,
    );
    return {
      targetUserId: githubUserObjectId(account.id),
      account,
      ...(invitationId !== undefined ? { invitationId } : {}),
    };
  }

  /**
   * Deprovision. With a GitHub account (`account`: the user id onboarding wrote back, whose
   * current login is looked up, else the identity's login): remove its organization membership,
   * which also cancels an invitation sent to the account. GitHub having neither (404) leaves an
   * invitation sent by email before the login was known, cancelled here; with none the person is
   * already gone. A user id GitHub no longer knows is a deleted account: already gone.
   *
   * Without one: cancel the person's pending invitation found by email. The GitHub API cannot
   * find a member by email, so an accepted invitation is a non-retryable failure (422) telling
   * an admin to remove the member in GitHub. A failed or expired invitation means the person
   * never joined (already gone).
   */
  async deprovision(
    email: string,
    config?: GitHubConfig,
    account: GitHubAccountRef = {},
  ): Promise<DeprovisionResult> {
    const cfg = config ?? (await this.getConfig());
    let login = account.login;
    if (account.userId !== undefined) {
      const found = await this.client.findAccount(cfg, { id: account.userId });
      if (!found) return { outcome: 'already-gone', detail: 'GitHub account no longer exists' };
      login = found.login;
    }
    if (login) {
      if (await this.client.removeMembership(cfg, login)) {
        this.logger.log(
          `[DEPROVISION] Removed GitHub account ${maskLogin(login)} from ${cfg.orgName}`,
        );
        return {
          outcome: 'deprovisioned',
          detail: 'removed from the organization (membership or invitation)',
        };
      }
      const pending = await this.client.findInvitation(cfg, email, 'invitations');
      if (pending) return this.cancelInvitation(cfg, pending.id);
      return { outcome: 'already-gone', detail: 'not a member of the organization' };
    }

    const pending = await this.client.findInvitation(cfg, email, 'invitations');
    if (pending) return this.cancelInvitation(cfg, pending.id);
    if (await this.client.findInvitation(cfg, email, 'failed_invitations')) {
      return { outcome: 'already-gone', detail: 'invitation failed or expired, never joined' };
    }
    throw new ConnectorException(
      'No pending or failed GitHub invitation for this person. If they accepted it, remove them ' +
        'from the organization in GitHub: the GitHub API cannot find a member by email. ' +
        `A GitHub login on the identity (customAttributes.${GITHUB_LOGIN_ATTRIBUTE}) lets ` +
        'offboarding remove the member.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  private async cancelInvitation(cfg: GitHubConfig, id: number): Promise<DeprovisionResult> {
    if (!(await this.client.cancelInvitation(cfg, id))) {
      // Accepted or cancelled since the lookup: a retry looks again (409 is retried)
      throw new ConnectorException(
        'GitHub invitation changed while it was being cancelled',
        HttpStatus.CONFLICT,
      );
    }
    this.logger.log(`[DEPROVISION] Cancelled invitation ${id} in ${cfg.orgName}`);
    return { outcome: 'deprovisioned', detail: 'pending invitation cancelled' };
  }

  private async getConfig(): Promise<GitHubConfig> {
    const doc = await this.connectorConfig.getConfig(CONNECTOR_ID);
    if (!doc?.config?.personalAccessToken || !doc?.config?.orgName) {
      throw new ConnectorException(
        'GitHubConnector: not configured. Install with personalAccessToken and orgName.',
      );
    }
    return doc.config as unknown as GitHubConfig;
  }
}
