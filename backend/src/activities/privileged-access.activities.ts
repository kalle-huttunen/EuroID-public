import { Injectable, Logger } from '@nestjs/common';
import { PrivilegedAccessService } from '../modules/privileged-access/privileged-access.service';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { PamSessionTargets } from '@shared/types/pam-session';
import { PamSessionStateService } from '../modules/privileged-access/pam-session-state.service';
import { PamSessionService } from '../modules/privileged-access/pam-session.service';

export interface GetOrCreateLinkedAdminIdentityResult {
  adminIdentityId: string;
  adminEmail: string;
  adminProfile: StandardUserDto;
}

/** A live linked admin identity of a person being offboarded. */
export interface LinkedAdminIdentity {
  identityId: string;
  email: string;
}

@Injectable()
export class PrivilegedAccessActivities {
  private readonly logger = new Logger(PrivilegedAccessActivities.name);

  constructor(
    private readonly privilegedAccessService: PrivilegedAccessService,
    private readonly sessionState: PamSessionStateService,
    private readonly sessions: PamSessionService,
  ) {}

  async getOrCreateLinkedAdminIdentity(
    parentIdentityId: string,
    adminTier: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<GetOrCreateLinkedAdminIdentityResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const adminIdentity = await this.privilegedAccessService.createLinkedAdminIdentity(
          parentIdentityId,
          adminTier,
          tenantId,
        );
        const doc = adminIdentity.toObject ? adminIdentity.toObject() : adminIdentity;
        const adminIdentityId = adminIdentity._id.toString();
        // The admin identity's id on the profile the connectors get: their provisioning events
        // go under it and reach its timeline (provisioningSubject), never under an email
        const profile = { ...doc.profile, _id: adminIdentityId } as unknown as StandardUserDto;
        return {
          adminIdentityId,
          adminEmail: profile.email,
          adminProfile: profile,
        };
      },
      { correlationId },
    );
  }

  /**
   * Offboarding (patch offboarding:linked-admin-cascade): the person's live linked admin
   * identities, each offboarded before the person's own targets. Their running privileged
   * sessions are told to end first (and the person's own, when the person offboarded is an admin
   * identity), so no session enables an account the offboarding removes; the session disables
   * them on its way out. Signals only: a session that does not run starts nothing.
   */
  async getLinkedAdminIdentities(
    parentIdentityId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<LinkedAdminIdentity[]> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    const tid = tenantId ?? '';
    return withTenantContext(
      tid,
      async () => {
        const admins = await this.privilegedAccessService.findLiveLinkedAdmins(
          parentIdentityId,
          tid,
        );
        for (const id of [parentIdentityId, ...admins.map((a) => a.identityId)]) {
          // Best effort: the offboarding must not wait on it. A session that is not reached ends
          // on identity.deleted (PamSessionEndHandler) and never records a deleted identity ACTIVE
          try {
            await this.sessions.endIfRunning(id, tid, 'offboarded');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Could not tell the privileged session of ${id} to end: ${msg}`);
          }
        }
        return admins;
      },
      { correlationId },
    );
  }

  // ── Privileged session (privilegedSessionWorkflow): its reads and writes ─────────────

  /** The admin identity's accounts and whether it may be enabled (PamSessionStateService). */
  async getPrivilegedSessionTargets(
    adminIdentityId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<PamSessionTargets> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      () => this.sessionState.sessionTargets(adminIdentityId, tenantId ?? ''),
      { correlationId },
    );
  }

  async markPrivilegedSessionActivating(
    adminIdentityId: string,
    sessionId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      () => this.sessionState.markActivating(adminIdentityId, sessionId, tenantId ?? ''),
      { correlationId },
    );
  }

  async recordPrivilegedSessionActive(
    adminIdentityId: string,
    sessionId: string,
    durationMs: number,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ live: boolean; expiresAt?: string }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      () => this.sessionState.recordActive(adminIdentityId, sessionId, durationMs, tenantId ?? ''),
      { correlationId },
    );
  }

  async recordPrivilegedSessionFailed(
    adminIdentityId: string,
    sessionId: string,
    reason: string,
    disableFailures: string[],
    tenantId?: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      () =>
        this.sessionState.recordFailed(
          adminIdentityId,
          sessionId,
          reason,
          disableFailures,
          tenantId ?? '',
        ),
      { correlationId },
    );
  }

  async recordPrivilegedSessionEnded(
    adminIdentityId: string,
    ended: { reason: string; failures: string[] },
    tenantId?: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      () => this.sessionState.recordEnded(adminIdentityId, ended, tenantId ?? ''),
      { correlationId },
    );
  }

  /**
   * Admin account provisioning (patch admin-account-provisioning:settle-standing-state): a
   * disable-only run for what it may have left enabled, unless a session is open.
   */
  async settleAdminAccountState(
    adminIdentityId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      () => this.privilegedAccessService.settleAfterProvisioning(adminIdentityId, tenantId ?? ''),
      { correlationId },
    );
  }
}
