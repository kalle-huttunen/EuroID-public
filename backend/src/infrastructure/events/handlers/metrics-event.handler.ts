import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import { MetricsService } from '../../observability/metrics.service';
import {
  ProvisioningCompletedPayload,
  ProvisioningFailedPayload,
  DriftDetectedPayload,
  DriftResolvedPayload,
  PolicyEvaluatedPayload,
  IdentityCreatedPayload,
  IdentityDeletedPayload,
  IdentityStatusChangedPayload,
  AnomalyDetectedPayload,
  AccessReviewItemApprovedPayload,
  AccessReviewItemRevokedPayload,
  AccessReviewItemExpiredPayload,
  MoverCompletedPayload,
  MoverFailedPayload,
} from '../event-payloads';

@Injectable()
export class MetricsEventHandler {
  constructor(private readonly metrics: MetricsService) {}

  // ── Provisioning ──────────────────────────────

  @OnEvent(DomainEventType.PROVISIONING_COMPLETED, { async: true })
  handleProvisioningCompleted(event: DomainEvent<ProvisioningCompletedPayload>): void {
    const { connector, durationMs, operations } = event.payload;
    const allSuccess = operations.every((op) => op.success);
    const tenant = event.metadata.tenantId || 'unknown';

    this.metrics.provisioningTotal.inc({
      connector,
      status: allSuccess ? 'success' : 'partial_failure',
      tenant,
    });
    this.metrics.provisioningDuration.observe({ connector, tenant }, durationMs);
  }

  @OnEvent(DomainEventType.PROVISIONING_FAILED, { async: true })
  handleProvisioningFailed(event: DomainEvent<ProvisioningFailedPayload>): void {
    this.metrics.provisioningTotal.inc({
      connector: event.payload.connector,
      status: 'error',
      tenant: event.metadata.tenantId || 'unknown',
    });
  }

  // ── Drift & Reconciliation ────────────────────

  @OnEvent(DomainEventType.DRIFT_DETECTED, { async: true })
  handleDriftDetected(event: DomainEvent<DriftDetectedPayload>): void {
    this.metrics.driftDetected.inc({
      system: event.payload.system,
      severity: event.payload.severity,
      tenant: event.metadata.tenantId || 'unknown',
    });
  }

  @OnEvent(DomainEventType.DRIFT_RESOLVED, { async: true })
  handleDriftResolved(event: DomainEvent<DriftResolvedPayload>): void {
    this.metrics.driftResolved.inc({
      system: event.payload.system,
      tenant: event.metadata.tenantId || 'unknown',
    });
  }

  // ── Policy Engine ─────────────────────────────

  @OnEvent(DomainEventType.POLICY_EVALUATED, { async: true })
  handlePolicyEvaluated(event: DomainEvent<PolicyEvaluatedPayload>): void {
    this.metrics.policyEvaluationTotal.inc();
    this.metrics.policyEvaluationDuration.observe(event.payload.durationMs);
  }

  // ── Identity Lifecycle ────────────────────────

  @OnEvent(DomainEventType.IDENTITY_CREATED, { async: true })
  handleIdentityCreated(_event: DomainEvent<IdentityCreatedPayload>): void {
    this.metrics.identityOperationsTotal.inc({ operation: 'created' });
  }

  @OnEvent(DomainEventType.IDENTITY_DELETED, { async: true })
  handleIdentityDeleted(_event: DomainEvent<IdentityDeletedPayload>): void {
    this.metrics.identityOperationsTotal.inc({ operation: 'deleted' });
  }

  @OnEvent(DomainEventType.IDENTITY_STATUS_CHANGED, { async: true })
  handleIdentityStatusChanged(event: DomainEvent<IdentityStatusChangedPayload>): void {
    this.metrics.identityOperationsTotal.inc({ operation: `status_${event.payload.newStatus}` });
  }

  // ── Access Requests ───────────────────────────

  // euroid_access_requests_pending is counted in MongoDB at each scrape (MetricsService)
  @OnEvent(DomainEventType.ACCESS_REQUEST_CREATED, { async: true })
  handleAccessRequestCreated(): void {
    this.metrics.accessRequestsTotal.inc({ outcome: 'created' });
  }

  // ── Access Reviews ────────────────────────────

  @OnEvent(DomainEventType.ACCESS_REVIEW_ITEM_APPROVED, { async: true })
  handleAccessReviewApproved(_event: DomainEvent<AccessReviewItemApprovedPayload>): void {
    this.metrics.accessReviewDecisionsTotal.inc({ decision: 'approved' });
  }

  @OnEvent(DomainEventType.ACCESS_REVIEW_ITEM_REVOKED, { async: true })
  handleAccessReviewRevoked(_event: DomainEvent<AccessReviewItemRevokedPayload>): void {
    this.metrics.accessReviewDecisionsTotal.inc({ decision: 'revoked' });
  }

  @OnEvent(DomainEventType.ACCESS_REVIEW_ITEM_EXPIRED, { async: true })
  handleAccessReviewExpired(_event: DomainEvent<AccessReviewItemExpiredPayload>): void {
    this.metrics.accessReviewDecisionsTotal.inc({ decision: 'expired' });
  }

  // ── Anomaly Detection ─────────────────────────

  @OnEvent(DomainEventType.ANOMALY_DETECTED, { async: true })
  handleAnomalyDetected(event: DomainEvent<AnomalyDetectedPayload>): void {
    this.metrics.anomaliesDetectedTotal.inc({
      type: event.payload.type,
      severity: event.payload.severity,
    });
  }

  // ── Mover Workflow ────────────────────────────

  @OnEvent(DomainEventType.MOVER_COMPLETED, { async: true })
  handleMoverCompleted(event: DomainEvent<MoverCompletedPayload>): void {
    this.metrics.moverOperationsTotal.inc({ status: 'completed' });
    this.metrics.moverDuration.observe(event.payload.durationMs);
  }

  @OnEvent(DomainEventType.MOVER_FAILED, { async: true })
  handleMoverFailed(_event: DomainEvent<MoverFailedPayload>): void {
    this.metrics.moverOperationsTotal.inc({ status: 'failed' });
  }
}
