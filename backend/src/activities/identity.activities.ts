import { Injectable, Logger } from '@nestjs/common';
import { IdentityService } from '../modules/identity/identity.service';
import { UserEventService } from '../modules/identity/user-event.service';
import { IdentityException } from '@shared/exceptions/domain-exceptions';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { UserPayload } from '@shared/types/user-payload';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { maskEmail } from '../modules/identity/identity-pii';
import { maskEmails } from './deprovision-failure';

/**
 * Temporal Activity: Hub operations (save, delete, lookup). Bridges workflows to IdentityService.
 */
@Injectable()
export class IdentityActivities {
  private readonly logger = new Logger(IdentityActivities.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly userEventService: UserEventService,
  ) {}

  /**
   * Saves the user to the "Hub" (MongoDB).
   * This ensures we have a Golden Record before we provision to targets. An identity the save
   * mints emits identity.created.
   */
  async saveToHub(
    user: StandardUserDto | UserPayload,
    tenantId?: string,
    correlationId?: string,
  ): Promise<string> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const ctx = requestContext.getStore();
        this.logger.log(
          `[IdentityActivities] Saving Golden Record for: ${maskEmail((user as StandardUserDto).email)}`,
          {
            tenantId: tenantId ?? '',
            correlationId: ctx?.correlationId ?? correlationId,
          },
        );
        // A correlationId the caller put in is the national ID hash it computed before the
        // workflow started, with the value removed (ReconciliationService, bulk provisioning):
        // the Hub save matches on it. Used only for a tenant with the rule (ensureIdentityFromUser)
        const nationalIdHash = (user as { correlationId?: unknown }).correlationId;
        const record =
          typeof nationalIdHash === 'string' && nationalIdHash
            ? await this.identityService.saveOrUpdateReportingCreated(
                user as StandardUserDto,
                undefined,
                undefined,
                { nationalIdHash },
              )
            : await this.identityService.saveOrUpdateReportingCreated(user as StandardUserDto);

        return record._id ? String(record._id) : 'mock-id-123';
      },
      { correlationId },
    );
  }

  /**
   * Mark user as deleted in MongoDB (soft delete)
   * Used by the offboarding workflow
   */
  async markDeleted(userId: string, tenantId?: string, correlationId?: string): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const ctx = requestContext.getStore();
        this.logger.log(`[IdentityActivities] Marking user as deleted: ${userId}`, {
          tenantId: tenantId ?? '',
          correlationId: ctx?.correlationId ?? correlationId,
        });
        await this.identityService.markAsDeleted(userId);
      },
      { correlationId },
    );
  }

  /**
   * Offboarding that left a target failing: disable the identity's login (controls kill switch),
   * so reconciliation keeps its Golden Record SUSPENDED, also across HR syncs. The record is
   * kept (not deleted) so the remaining access stays visible and offboarding can be re-run.
   */
  async suspendIdentity(userId: string, tenantId?: string, correlationId?: string): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        // Audited as the kill switch turned on, by offboarding (as markAsDeleted's default)
        const identity = await this.identityService.updateControls(
          userId,
          { isLoginDisabled: true },
          'offboarding-workflow',
        );
        if (!identity) throw new IdentityException(`suspendIdentity: no identity ${userId}`);
        this.logger.log(
          `[IdentityActivities] Suspended identity ${userId} (offboarding incomplete)`,
        );
      },
      { correlationId },
    );
  }

  /**
   * Fetch a user from the Hub (MongoDB) by email
   * Used by workflows when they need the complete user record
   */
  async getUserByEmail(
    email: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<StandardUserDto | null> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const ctx = requestContext.getStore();
        this.logger.log(`[IdentityActivities] Fetching user from Hub: ${maskEmail(email)}`, {
          tenantId: tenantId ?? '',
          correlationId: ctx?.correlationId ?? correlationId,
        });
        const user = await this.identityService.findByEmail(email);

        if (!user) {
          this.logger.warn(`[IdentityActivities] User not found in Hub: ${maskEmail(email)}`);
          return null;
        }

        // Convert Mongoose document to plain object to ensure all fields are serializable
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- user is a dynamic lean document from identity query
        const plainUser = (user as any).toObject ? (user as any).toObject() : user;

        // Log which fields have values for debugging (no PII values)
        const fieldsWithValues = Object.keys(plainUser).filter(
          (k) =>
            (plainUser as Record<string, unknown>)[k] !== null &&
            (plainUser as Record<string, unknown>)[k] !== undefined,
        );
        this.logger.debug(
          `[IdentityActivities] Found user in Hub with ${fieldsWithValues.length} fields`,
        );
        this.logger.debug(`[IdentityActivities] Field names: ${fieldsWithValues.join(', ')}`);

        return plainUser;
      },
      { correlationId },
    );
  }

  /**
   * Fetch Identity (Onion model) by email for workflows that track provisioning state.
   * Returns a plain object { _id, profile, provisioning } so Temporal can serialize it.
   * Profile is enriched with contracts derived from sources for split provisioning, and carries
   * the identity's id as `_id`: the workflow passes the profile on to evaluateUser and to the
   * connectors, whose policy and provisioning events go under that id (never the email).
   * @param notConfiguredTargets - The targets this onboarding run left out because nothing is
   *   configured for them (onboarding's health check): each goes on the identity's timeline as
   *   not provisioned. A trailing argument of the call onboarding already makes per person, so
   *   the workflow's commands do not change.
   */
  async getIdentityByEmail(
    email: string,
    tenantId?: string,
    correlationId?: string,
    notConfiguredTargets?: string[],
  ): Promise<{
    _id: string;
    profile: StandardUserDto;
    provisioning: Array<{
      targetSystem: string;
      status: string;
      errorMsg?: string;
      lastSync?: Date;
      writebackComplete?: boolean;
    }>;
  } | null> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const identity = await this.identityService.findIdentityByEmail(email);
        if (!identity) return null;
        const doc = identity.toObject ? identity.toObject() : identity;
        const profileWithContracts = (await this.identityService.buildProfileWithContractsForPolicy(
          identity,
        )) as unknown as StandardUserDto;
        const identityId = doc._id.toString();
        for (const target of notConfiguredTargets ?? []) {
          await this.recordNotConfigured(identityId, target, correlationId);
        }
        return {
          _id: identityId,
          profile: { ...profileWithContracts, _id: identityId },
          provisioning: doc.provisioning || [],
        };
      },
      { correlationId },
    );
  }

  /**
   * "Not provisioned to <target>: not configured" on the identity timeline. A failed write is
   * logged: the timeline must not fail or repeat the onboarding lookup it rides on.
   */
  private async recordNotConfigured(
    identityId: string,
    target: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.userEventService.recordEvent({
        userId: identityId,
        type: 'USER_PROVISIONED',
        severity: 'warning',
        title: `Not provisioned to ${target}: not configured`,
        description:
          `EuroID has no configuration for ${target} (canvas node, installed connector or ` +
          'environment settings), so onboarding left it out. Configure it and onboard again.',
        actor: 'system:onboarding',
        targetSystem: target,
        metadata: {
          workflow: 'onboarding',
          ...(correlationId ? { workflowId: correlationId } : {}),
          reason: 'not-configured',
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Timeline entry for ${target} not recorded on ${identityId}: ${message}`);
    }
  }

  /**
   * Get targets where the identity is provisioned (SYNCED) for offboarding deprovision.
   * Returns targetSystem and externalId for each target.
   */
  async getProvisionedTargets(
    identityId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<Array<{ targetSystem: string; externalId?: string }>> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        return this.identityService.getProvisionedTargetsForDeprovision(identityId, tenantId ?? '');
      },
      { correlationId },
    );
  }

  /**
   * Offboarding targets: every provisioning entry not yet DEPROVISIONED (for an admin identity
   * also one a PAM deactivation marked so), with its status and account id, and whether the
   * identity has no provisioning state at all (the only case for the Entra fallback). Replaces
   * getProvisionedTargets behind offboarding:unsynced-targets.
   */
  async getOffboardingTargets(
    identityId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{
    noProvisioningState: boolean;
    targets: Array<{ targetSystem: string; externalId?: string; status: string }>;
  }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      () => this.identityService.getOffboardingTargets(identityId, tenantId ?? ''),
      { correlationId },
    );
  }

  /**
   * Set provisioning state for one target (SYNCING / SYNCED / ERROR / DEPROVISIONED).
   * Called by onboarding workflow before/after each connector; offboarding sets DEPROVISIONED.
   * The first SYNCED target also records the identity's access baseline (the profile its access
   * was applied with, shared/utils/access-baseline.ts); a failure there is logged and leaves the
   * identity without one (the access preview says so), it does not fail provisioning.
   * @param writebackComplete - Set true after first writeback to prevent circular writeback on re-sync.
   * @param options - Time-bound access: expiresAt, activeFrom, grantedBy.
   */
  async setProvisioningStatus(
    identityId: string,
    targetSystem: string,
    status: 'PENDING' | 'SYNCING' | 'SYNCED' | 'ERROR' | 'DEPROVISIONED',
    errorMsg?: string,
    tenantId?: string,
    writebackComplete?: boolean,
    options?: { expiresAt?: Date; activeFrom?: Date; grantedBy?: 'policy' | 'request' | 'manual' },
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        await this.identityService.updateProvisioningState(
          identityId,
          targetSystem,
          status,
          errorMsg,
          writebackComplete,
          options,
        );
        if (status === 'SYNCED') await this.recordInitialAccessBaseline(identityId);
      },
      { correlationId },
    );
  }

  /**
   * Onboarding did not provision the identity because a BLOCK SoD policy refuses the access the
   * policies give it (patch onboarding:sod-block-fails-person): puts that, with the reason (the
   * SoD policies), on the identity's timeline. Nothing else changes: its targets keep the state
   * they had.
   */
  async recordOnboardingBlocked(
    identityId: string,
    reason: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        await this.userEventService.recordEvent({
          userId: identityId,
          type: 'WORKFLOW_COMPLETED',
          severity: 'error',
          title: 'Onboarding refused by a segregation of duties policy',
          description: `${maskEmails(reason)}. No target was changed.`,
          actor: 'system:onboarding',
          metadata: {
            workflow: 'onboarding',
            ...(correlationId ? { workflowId: correlationId } : {}),
          },
        });
      },
      { correlationId },
    );
  }

  /**
   * Onboarding provisioned the person's own targets, but an admin account child failed (patch
   * onboarding:admin-account-failure-not-fatal): puts each failed tier with the child's reason
   * (emails masked) on the identity's timeline. The run then ends failed (AdminAccountFailed);
   * the next onboarding run of the person starts the admin account children again.
   */
  async recordAdminAccountFailed(
    identityId: string,
    failures: Array<{ adminTier: string; reason: string }>,
    tenantId?: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const tiers = failures.map((f) => `${f.adminTier}: ${maskEmails(f.reason)}`).join('; ');
        await this.userEventService.recordEvent({
          userId: identityId,
          type: 'WORKFLOW_COMPLETED',
          severity: 'error',
          title: 'Admin account not provisioned',
          description:
            `${tiers}. The person's own accounts were provisioned; the next onboarding run ` +
            'provisions the admin account again.',
          actor: 'system:onboarding',
          metadata: {
            workflow: 'onboarding',
            ...(correlationId ? { workflowId: correlationId } : {}),
          },
        });
      },
      { correlationId },
    );
  }

  private async recordInitialAccessBaseline(identityId: string): Promise<void> {
    try {
      await this.identityService.recordInitialAccessBaseline(identityId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Access baseline not recorded for identity ${identityId}: ${message}`);
    }
  }

  /**
   * Push source data from a connector (e.g., Entra ID) into the Identity Hub and reconcile.
   * Used when a connector generates attributes (e.g., work email) that need to flow back to the Hub.
   *
   * @param identityIdOrEmail - Identity ID or user email
   * @param sourceName - Connector name (e.g., 'entra-id')
   * @param externalId - Native ID in the target system
   * @param rawData - Raw data from the target (e.g., { mail, userPrincipalName })
   */
  async pushSourceAndReconcile(
    identityIdOrEmail: string,
    sourceName: string,
    externalId: string,
    rawData: Record<string, unknown>,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const identity = await this.identityService.pushSourceAndReconcile(
          identityIdOrEmail,
          sourceName,
          externalId,
          rawData,
        );
        if (!identity) {
          throw new IdentityException(
            maskEmails(`pushSourceAndReconcile: no identity found for ${identityIdOrEmail}`),
          );
        }
        return true;
      },
      { correlationId },
    );
  }
}
