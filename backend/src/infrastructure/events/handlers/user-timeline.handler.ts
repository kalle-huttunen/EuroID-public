import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import { UserEventService } from '../../../modules/identity/user-event.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';
import {
  IdentityCreatedPayload,
  IdentityUpdatedPayload,
  ProvisioningCompletedPayload,
  ProvisioningFailedPayload,
  PolicyEvaluatedPayload,
  DriftDetectedPayload,
  IdentityStatusChangedPayload,
  IdentityDeletedPayload,
} from '../event-payloads';

/**
 * Domain events on the identity timeline (user_events), one entry per event: each entry carries
 * the event's id, so a redelivered event (outbox reclaim, dead-letter replay) adds none.
 */
@Injectable()
export class UserTimelineHandler {
  private readonly logger = new Logger(UserTimelineHandler.name);

  constructor(private readonly userEventService: UserEventService) {}

  @OnEvent(DomainEventType.IDENTITY_CREATED, { async: true })
  async handleIdentityCreated(event: DomainEvent<IdentityCreatedPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    try {
      await withTenantContext(tenantId, async () => {
        await this.userEventService.recordEvent({
          userId: event.aggregateId,
          type: 'USER_CREATED',
          eventId: event.eventId,
          severity: 'success',
          title: `Created via ${event.payload.sourceSystem}`,
          description: `User account created`,
          actor: event.metadata.actor,
          metadata: { sourceSystem: event.payload.sourceSystem },
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to record creation timeline for ${event.aggregateId}: ${message}`);
    }
  }

  /** An update that changed no field (an unchanged save) is no entry: "Updated: " said nothing. */
  @OnEvent(DomainEventType.IDENTITY_UPDATED, { async: true })
  async handleIdentityUpdated(event: DomainEvent<IdentityUpdatedPayload>): Promise<void> {
    if ((event.payload.changedFields ?? []).length === 0) return;
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    try {
      await withTenantContext(tenantId, async () => {
        await this.userEventService.recordEvent({
          userId: event.aggregateId,
          type: 'USER_UPDATED',
          eventId: event.eventId,
          title: `Updated: ${event.payload.changedFields.join(', ')}`,
          description: `${event.payload.changedFields.length} field(s) updated`,
          actor: event.metadata.actor,
          // A write-back: the target system whose new account was written back
          targetSystem: event.payload.targetSystem,
          metadata: { changedFields: event.payload.changedFields, source: event.payload.source },
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to record update timeline for ${event.aggregateId}: ${message}`);
    }
  }

  /**
   * The evaluation a workflow provisions from (forProvisioning), for an identity. What-ifs
   * (simulation, anomaly scans, the access preview) evaluate stored identities too: not recorded.
   */
  @OnEvent(DomainEventType.POLICY_EVALUATED, { async: true })
  async handlePolicyEvaluated(event: DomainEvent<PolicyEvaluatedPayload>): Promise<void> {
    const { identityId, matchedPolicies, generatedOperations, forProvisioning } = event.payload;
    const tenantId = event.metadata.tenantId;
    if (!forProvisioning || !identityId) return;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    const matched = matchedPolicies.length
      ? `Matched: ${matchedPolicies.join(', ')}.`
      : 'No policy matched.';
    const operations = `${generatedOperations} operation${generatedOperations === 1 ? '' : 's'}`;
    try {
      await withTenantContext(tenantId, async () => {
        await this.userEventService.recordEvent({
          userId: identityId,
          type: 'POLICY_EVALUATED',
          eventId: event.eventId,
          severity: 'info',
          title: 'Policy evaluated',
          description: `${matched} ${operations}.`,
          actor: event.metadata.actor,
          metadata: { matchedPolicies, generatedOperations },
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to record policy timeline for ${identityId}: ${message}`);
    }
  }

  /** Provisioning events without an identity id (bulk rows, PAM profiles) have no timeline. */
  @OnEvent(DomainEventType.PROVISIONING_COMPLETED, { async: true })
  async handleProvisioningCompleted(
    event: DomainEvent<ProvisioningCompletedPayload>,
  ): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!event.payload.identityId) return;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    try {
      await withTenantContext(tenantId, async () => {
        await this.userEventService.recordEvent({
          userId: event.aggregateId,
          type: 'USER_PROVISIONED',
          eventId: event.eventId,
          title: `Provisioned to ${event.payload.connector}`,
          // A target that keeps no account says what it did instead
          description:
            event.payload.detail ?? `${event.payload.operations.length} operations executed`,
          actor: event.metadata.actor,
          targetSystem: event.payload.connector,
          metadata: { operations: event.payload.operations },
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to record provisioning timeline for ${event.aggregateId}: ${message}`,
      );
    }
  }

  @OnEvent(DomainEventType.PROVISIONING_FAILED, { async: true })
  async handleProvisioningFailed(event: DomainEvent<ProvisioningFailedPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!event.payload.identityId) return;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    try {
      await withTenantContext(tenantId, async () => {
        await this.userEventService.recordEvent({
          userId: event.aggregateId,
          type: 'USER_PROVISIONED',
          eventId: event.eventId,
          severity: 'error',
          title: `Provisioning failed to ${event.payload.connector}`,
          description: event.payload.error,
          actor: event.metadata.actor,
          targetSystem: event.payload.connector,
          metadata: { error: event.payload.error, retryable: event.payload.retryable },
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to record provisioning failure timeline for ${event.aggregateId}: ${message}`,
      );
    }
  }

  @OnEvent(DomainEventType.DRIFT_DETECTED, { async: true })
  async handleDriftDetected(event: DomainEvent<DriftDetectedPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    try {
      await withTenantContext(tenantId, async () => {
        await this.userEventService.recordEvent({
          userId: event.aggregateId,
          type: 'DRIFT_DETECTED',
          eventId: event.eventId,
          severity: event.payload.severity === 'CRITICAL' ? 'error' : 'warning',
          title: `Drift detected in ${event.payload.system}`,
          description: `${event.payload.discrepancies.length} discrepancies found`,
          actor: 'system',
          targetSystem: event.payload.system,
          metadata: { discrepancies: event.payload.discrepancies },
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to record drift timeline for ${event.aggregateId}: ${message}`);
    }
  }

  @OnEvent(DomainEventType.IDENTITY_DELETED, { async: true })
  async handleIdentityDeleted(event: DomainEvent<IdentityDeletedPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    try {
      await withTenantContext(tenantId, async () => {
        await this.userEventService.recordEvent({
          userId: event.aggregateId,
          type: 'USER_DEPROVISIONED',
          eventId: event.eventId,
          severity: 'warning',
          title: 'User deprovisioned',
          description: event.payload.reason,
          actor: event.metadata.actor,
          metadata: { reason: event.payload.reason },
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to record deletion timeline for ${event.aggregateId}: ${message}`);
    }
  }

  @OnEvent(DomainEventType.IDENTITY_STATUS_CHANGED, { async: true })
  async handleIdentityStatusChanged(
    event: DomainEvent<IdentityStatusChangedPayload>,
  ): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    try {
      await withTenantContext(tenantId, async () => {
        await this.userEventService.recordEvent({
          userId: event.aggregateId,
          type: 'STATUS_CHANGE',
          eventId: event.eventId,
          title: `Status changed: ${event.payload.previousStatus} → ${event.payload.newStatus}`,
          description: event.payload.reason,
          actor: event.metadata.actor,
          metadata: {
            previousStatus: event.payload.previousStatus,
            newStatus: event.payload.newStatus,
            reason: event.payload.reason,
          },
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to record status change timeline for ${event.aggregateId}: ${message}`,
      );
    }
  }
}
