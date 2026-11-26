import { Injectable, Logger } from '@nestjs/common';
import { GitHubService } from '../modules/connectors/github-connector/github.service';
import {
  githubLoginOf,
  githubUserIdOf,
  githubUserObjectId,
} from '../modules/connectors/github-connector/github.mapper';
import type {
  GitHubAccountRef,
  GitHubProvisionResult,
} from '../modules/connectors/github-connector/github.interface';
import { IdentityService } from '../modules/identity/identity.service';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import type { DeprovisionResult } from '@shared/types/deprovision';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { ApplicationFailure } from '@temporalio/common';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { asDeprovisionFailure } from './deprovision-failure';
import {
  asProvisionFailure,
  eventAccountId,
  provisioningSubject,
  type TargetProvisionResult,
} from './target-provision';

/**
 * Temporal activities for the GitHub connector (default task queue: GitHub has no queue of its
 * own). The connector resolves its config (PAT, org) from the installed connector, so no secret
 * passes through workflow history. Neither does the person's GitHub login: onboarding reads it
 * from the profile it is given, offboarding from the identity.
 */
@Injectable()
export class GitHubActivities {
  private readonly logger = new Logger(GitHubActivities.name);

  constructor(
    private readonly githubService: GitHubService,
    private readonly identityService: IdentityService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** Onboarding health check: the organization answers to the saved token. */
  async checkGitHubHealth(
    _config?: undefined,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(tenantId ?? '', () => this.githubService.healthCheck(), {
      correlationId,
    });
  }

  /**
   * Onboarding: invite the person to the organization. With a GitHub login on the profile
   * (customAttributes.githubLogin) the account is invited by its user id, which is written back
   * (`github-user-<id>`) also when it was already invited or a member, so offboarding removes
   * that account even after a change of login. Without one the invitation goes to the email and
   * the invitation's id is written back (`github-invitation-<id>`); an earlier invitation or
   * membership (GitHub's 422) is success without one, and offboarding finds the invitation by
   * email. Errors are retried by Temporal (a rate limit waits). Emits provisioning.completed
   * (the account id written back, the detail) or provisioning.failed (the masked reason) under
   * the identity's id; no login or email.
   */
  async provisionUserToGitHub(
    user: StandardUserDto,
    _intent?: unknown,
    _config?: undefined,
    tenantId?: string,
    correlationId?: string,
  ): Promise<TargetProvisionResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const { aggregateId, identityId } = provisioningSubject(user, 'github');
        const startTime = Date.now();
        let result: TargetProvisionResult;
        try {
          result = this.provisionResult(await this.githubService.create(user));
        } catch (error: unknown) {
          const failure = asProvisionFailure('github', error);
          this.eventEmitter.emit(DomainEventType.PROVISIONING_FAILED, aggregateId, {
            ...(identityId ? { identityId } : {}),
            connector: 'github',
            error: failure instanceof Error ? failure.message : String(failure),
            retryable: !(failure instanceof ApplicationFailure && failure.nonRetryable),
          });
          throw failure;
        }
        const targetUserId = eventAccountId(result.objectId);
        this.eventEmitter.emit(DomainEventType.PROVISIONING_COMPLETED, aggregateId, {
          ...(identityId ? { identityId } : {}),
          connector: 'github',
          ...(targetUserId ? { targetUserId } : {}),
          operations: [],
          detail: result.detail,
          durationMs: Date.now() - startTime,
        });
        return result;
      },
      { correlationId },
    );
  }

  /** What an invitation call did: the account id to write back, if any, and the detail. */
  private provisionResult({ invitationId, account }: GitHubProvisionResult): TargetProvisionResult {
    if (account) {
      return {
        success: true as const,
        objectId: githubUserObjectId(account.id),
        detail:
          invitationId === undefined
            ? 'GitHub account already invited or a member'
            : 'organization invitation sent to the GitHub account',
      };
    }
    if (invitationId === undefined) {
      return { success: true as const, detail: 'already invited or a member' };
    }
    return {
      success: true as const,
      objectId: `github-invitation-${invitationId}`,
      detail: 'organization invitation sent',
    };
  }

  /**
   * Offboarding: remove the person from the organization. `externalId` is the account id
   * onboarding wrote back, `identityId` the identity whose GitHub login is read when that id is
   * not a GitHub user id. With an account: its membership is removed; without: the pending
   * invitation found by email is cancelled, and an accepted one fails without retry (see
   * GitHubService.deprovision). A rate limit waits for GitHub's reset; other errors are retried.
   * Histories from before these arguments existed call it with the first three only: by email.
   * A removal emits provisioning.deprovisioned under `identityId` (no login or email).
   */
  async deprovisionGitHubUser(
    email: string,
    tenantId?: string,
    correlationId?: string,
    externalId?: string,
    identityId?: string,
  ): Promise<DeprovisionResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        try {
          const account = await this.accountOf(externalId, identityId);
          const result = await this.githubService.deprovision(email, undefined, account);
          this.logger.log(`GitHub deprovision: ${result.outcome}`);
          if (result.outcome === 'deprovisioned') {
            const targetUserId = eventAccountId(externalId);
            this.eventEmitter.emit(
              DomainEventType.PROVISIONING_DEPROVISIONED,
              identityId ?? 'github',
              {
                ...(identityId ? { identityId } : {}),
                connector: 'github',
                ...(targetUserId ? { targetUserId } : {}),
                ...(result.detail ? { detail: result.detail } : {}),
              },
            );
          }
          return result;
        } catch (error: unknown) {
          throw asDeprovisionFailure('github', error);
        }
      },
      { correlationId },
    );
  }

  /** The written-back GitHub user id, else the identity's GitHub login (deleted ones included). */
  private async accountOf(externalId?: string, identityId?: string): Promise<GitHubAccountRef> {
    const userId = githubUserIdOf(externalId);
    if (userId !== undefined) return { userId };
    if (!identityId) return {};
    const identity = await this.identityService.findIdentityById(identityId, {
      includeDeleted: true,
    });
    const login = githubLoginOf(identity?.profile?.customAttributes);
    return login ? { login } : {};
  }
}
