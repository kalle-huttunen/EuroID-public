/**
 * Central registry of domain event types. Dot notation enables wildcard listeners.
 */
export enum DomainEventType {
  // ── Identity Lifecycle ────────────────────────────
  IDENTITY_CREATED = 'identity.created',
  IDENTITY_UPDATED = 'identity.updated',
  IDENTITY_DELETED = 'identity.deleted',
  IDENTITY_STATUS_CHANGED = 'identity.status_changed',
  /** Emitted when offboarding is requested (DELETE /identity/:id, or an HR leaver). Payload: { userId, userEmail, reason? }. Handler returns workflowId. */
  IDENTITY_OFFBOARD_REQUESTED = 'identity.offboard_requested',
  /** An HR sync found a leaver (terminated, end date passed, missing from the source). Payload: LeaverDetectedPayload */
  LEAVER_DETECTED = 'identity.leaver_detected',
  /** Offboarding started for an HR leaver. Payload: LeaverOffboardingStartedPayload */
  LEAVER_OFFBOARDING_STARTED = 'identity.leaver_offboarding_started',
  /** The offboarding workflow finished (or stopped with failed targets). Payload: OffboardingCompletedPayload */
  IDENTITY_OFFBOARDING_COMPLETED = 'identity.offboarding_completed',
  /**
   * An admin confirmed that a failed offboarding target's account was removed by hand (Leavers
   * page). Payload: OffboardingTargetRemovedManuallyPayload. Emitted with emitAndWait: the
   * identity handler marks the target DEPROVISIONED and, once no target is left failed, deletes
   * the Golden Record.
   */
  IDENTITY_OFFBOARDING_TARGET_REMOVED_MANUALLY = 'identity.offboarding_target_removed_manually',
  /** Query event: returns active access requests for identity (offboard-impact). Payload: { identityId }. Handler returns AccessRequestDocument[]. */
  IDENTITY_OFFBOARD_IMPACT_QUERY = 'identity.offboard_impact_query',
  /** Query event: returns entitlement grants for identity (GET /identity/:id/entitlements). Payload: { identityId }. Handlers return IdentityEntitlementsQueryResult. */
  IDENTITY_ENTITLEMENTS_QUERY = 'identity.entitlements_query',
  /** Emitted by controller when onboarding should be triggered (POST /identity?triggerWorkflow=true, PATCH /identity/:id?syncToEntra=true when the mover does not take the edit). Payload: { email, syncToEntra? }. Handler returns workflowId; a failed start rejects emitAndWait with its error. */
  IDENTITY_PROVISION_REQUESTED = 'identity.provision_requested',
  /** Emitted by PATCH /identity/:id?syncToEntra=true before onboarding is asked: the mover starts when the edit moves a provisioned identity's access. Payload: IdentityMoveRequestedPayload. Handler returns the mover workflowId, or undefined when the mover does not apply; a failed start rejects emitAndWait with its error. */
  IDENTITY_MOVE_REQUESTED = 'identity.move_requested',
  IDENTITY_CORRELATED = 'identity.correlated',
  CORRELATION_CONFLICT = 'identity.correlation_conflict',
  IDENTITY_SOURCES_CHANGED = 'identity.sources_changed',
  /** Emitted when an identity's source count reaches the warning threshold (40+). Payload: { identityId, currentCount, maxAllowed } */
  IDENTITY_SOURCES_APPROACHING_LIMIT = 'identity.sources_approaching_limit',

  // ── Provisioning ─────────────────────────────────
  PROVISIONING_STARTED = 'provisioning.started',
  PROVISIONING_COMPLETED = 'provisioning.completed',
  PROVISIONING_FAILED = 'provisioning.failed',
  /** A connector removed an account in its target (deleted, disabled or deactivated). Payload: ProvisioningDeprovisionedPayload (deprovision-event-schemas.ts). Audit log only, no timeline entry. */
  PROVISIONING_DEPROVISIONED = 'provisioning.deprovisioned',

  // ── Distributed Transaction ───────────────────────
  ROLLBACK_FAILED = 'distributed_transaction.rollback_failed',

  // ── HR Leavers ────────────────────────────────────
  /** One HR ingest finished. Payload: HrSyncCompletedPayload. The leaver handler returns LeaverSyncSummary. */
  HR_SYNC_COMPLETED = 'connector.hr_sync_completed',
  /** A sync found more leavers than the mass-leaver limit: none started, a batch awaits approval. */
  LEAVER_BATCH_PAUSED = 'leaver.batch_paused',
  LEAVER_BATCH_APPROVED = 'leaver.batch_approved',
  LEAVER_BATCH_REJECTED = 'leaver.batch_rejected',
  LEAVER_POLICY_UPDATED = 'leaver.policy_updated',

  // ── HR Writeback ──────────────────────────────────
  HR_WRITEBACK_COMPLETED = 'hr_writeback.completed',

  // ── Policy ────────────────────────────────────────
  POLICY_CREATED = 'policy.created',
  POLICY_UPDATED = 'policy.updated',
  POLICY_DELETED = 'policy.deleted',
  POLICY_EVALUATED = 'policy.evaluated',

  // ── SoD Policies ────────────────────────────────────
  SOD_POLICY_CREATED = 'sod_policy.created',
  SOD_POLICY_UPDATED = 'sod_policy.updated',
  SOD_POLICY_DELETED = 'sod_policy.deleted',

  // ── Reconciliation & Drift ────────────────────────
  DRIFT_DETECTED = 'drift.detected',
  DRIFT_RESOLVED = 'drift.resolved',
  CIRCUIT_BREAKER_TRIPPED = 'drift.circuit_breaker_tripped',
  /** A reconciliation run reached a drift threshold of its settings with notifyOnDrift on (ReconciliationActivities.notifyDriftThresholdExceeded). Payload: DriftThresholdExceededPayload (counts and the run's ids only). */
  RECONCILIATION_DRIFT_THRESHOLD_EXCEEDED = 'reconciliation.drift_threshold_exceeded',

  // ── Orphan Detection ─────────────────────────────
  ORPHAN_DETECTED = 'orphan.detected',

  // ── Simulation ────────────────────────────────────
  SIMULATION_COMPLETED = 'simulation.completed',

  // ── Connector ─────────────────────────────────────
  CONNECTOR_HEALTH_CHANGED = 'connector.health_changed',
  CONNECTOR_CIRCUIT_BREAKER_TRIPPED = 'connector.circuit_breaker_tripped',
  /** A connector's entitlement discovery was written to the entitlement catalog (EntitlementCatalogService.absorbDiscovered). Payload: DiscoveryCompletedPayload. */
  DISCOVERY_COMPLETED = 'discovery.completed',

  // ── Pipeline ─────────────────────────────────────
  PIPELINE_DEPLOYED = 'pipeline.deployed',
  PIPELINE_PAUSED = 'pipeline.paused',
  CIRCUIT_BREAKER_TRIGGERED = 'pipeline.circuit_breaker_triggered',

  // ── Anomaly Detection ────────────────────────────
  ANOMALY_DETECTED = 'anomaly.detected',
  ANOMALY_RESOLVED = 'anomaly.resolved',

  // ── Entitlements (SCIM Groups, etc.) ────────────
  ENTITLEMENT_UPDATED = 'entitlement.updated',
  ENTITLEMENT_EXPIRED = 'entitlement.expired',
  ENTITLEMENT_EXPIRING_SOON = 'entitlement.expiring_soon',
  ENTITLEMENT_EXPIRING_TOMORROW = 'entitlement.expiring_tomorrow',
  /** An expired provisioning entry was not deprovisioned (payload: EntitlementExpiryFailedPayload). */
  ENTITLEMENT_EXPIRY_FAILED = 'entitlement.expiry_failed',
  /** An admin cleared an expiry failure for the next run (EntitlementExpiryRetryRequestedPayload). */
  ENTITLEMENT_EXPIRY_RETRY_REQUESTED = 'entitlement.expiry_retry_requested',
  /** An admin removed failed expired access by hand (EntitlementExpiryRemovedManuallyPayload). */
  ENTITLEMENT_EXPIRY_REMOVED_MANUALLY = 'entitlement.expiry_removed_manually',

  // ── Auth / Invites ──────────────────────────────
  INVITE_CREATED = 'invite.created',
  /** A super-admin cancelled a pending invite (payload: InviteCancelledPayload). */
  INVITE_CANCELLED = 'invite.cancelled',
  /** A super-admin gave a console admin another tenant role (AdminUserRoleChangedPayload). */
  ADMIN_USER_ROLE_CHANGED = 'admin_user.role_changed',
  /** A password reset link was asked for and mailed (AdminUserPasswordResetRequestedPayload). */
  ADMIN_USER_PASSWORD_RESET_REQUESTED = 'admin_user.password_reset_requested',
  /** A super-admin issued a password reset code (AdminUserPasswordResetIssuedPayload). */
  ADMIN_USER_PASSWORD_RESET_ISSUED = 'admin_user.password_reset_issued',
  /** An admin set a new password with a reset token (AdminUserPasswordResetCompletedPayload). */
  ADMIN_USER_PASSWORD_RESET_COMPLETED = 'admin_user.password_reset_completed',

  // ── PAM (Privileged Access Management) ───────────
  ADMIN_ACCOUNT_CREATED = 'admin_account.created',
  ADMIN_ACCOUNT_ACTIVATED = 'admin_account.activated',
  ADMIN_ACCOUNT_DEACTIVATED = 'admin_account.deactivated',
  /**
   * A linked admin account has waited PAM_ACTIVATION_PENDING_ALERT_DAYS for its owner to finish
   * its activation in the target (Okta PROVISIONED): a person should finish or remove it.
   */
  ADMIN_ACCOUNT_ACTIVATION_PENDING = 'admin_account.activation_pending',
  /**
   * The tenant has more live identities than settings.maxIdentities allows (creates running at
   * the same moment passed the count): once per overshoot, until the count is back within it.
   */
  TENANT_IDENTITY_LIMIT_EXCEEDED = 'tenant.identity_limit_exceeded',

  // ── Access Requests ──────────────────────────────
  ACCESS_REQUEST_CREATED = 'access_request.created',
  /** The system closed a request, with why (payload: AccessRequestClosedPayload). */
  ACCESS_REQUEST_CLOSED = 'access_request.closed',

  // ── Risk Scoring ────────────────────────────────
  RISK_SCORES_CALCULATED = 'risk_scores.calculated',

  // ── Access Review ────────────────────────────────
  ACCESS_REVIEW_CAMPAIGN_CREATED = 'access_review.campaign_created',
  ACCESS_REVIEW_CAMPAIGN_ACTIVATED = 'access_review.campaign_activated',
  ACCESS_REVIEW_CAMPAIGN_COMPLETED = 'access_review.campaign_completed',
  /** A super-admin cancelled a DRAFT or ACTIVE campaign, with the optional reason (audit log). */
  ACCESS_REVIEW_CAMPAIGN_CANCELLED = 'access_review.campaign_cancelled',
  ACCESS_REVIEW_ITEM_APPROVED = 'access_review.item_approved',
  ACCESS_REVIEW_ITEM_REVOKED = 'access_review.item_revoked',
  ACCESS_REVIEW_ITEM_EXPIRED = 'access_review.item_expired',
  RECERTIFICATION_CAMPAIGN_CREATED = 'access_review.recertification_campaign_created',
  ACCESS_REVIEW_ESCALATED = 'access_review.item_escalated',
  /** A revoked account item's removal at campaign close, with its outcome (identity timeline). */
  ACCESS_REVIEW_ACCOUNT_REVOKED = 'access_review.account_revoked',
  /** A revoked group membership's removal at campaign close, with its outcome (identity timeline). */
  ACCESS_REVIEW_MEMBERSHIP_REVOKED = 'access_review.membership_revoked',
  /**
   * A revoke at campaign close became an access review exclusion: the policy engine leaves the
   * entitlement (an account item: every grant in the system) out of the identity's intent until a
   * policy-admin lifts it. Payload: ReviewExclusionCreatedPayload (review-exclusion.service.ts,
   * schema in access-event-schemas.ts); actor: the reviewer (an auto-revoke: the system).
   */
  ACCESS_REVIEW_EXCLUSION_CREATED = 'access_review.exclusion_created',
  /** A policy-admin lifted an access review exclusion. Payload: ReviewExclusionLiftedPayload. */
  ACCESS_REVIEW_EXCLUSION_LIFTED = 'access_review.exclusion_lifted',

  // ── Compliance Reporting ─────────────────────────────────
  COMPLIANCE_REPORT_GENERATED = 'compliance.report_generated',

  // ── Intelligence ───────────────────────────────────────
  PEER_GROUP_UPDATED = 'intelligence.peer_group_updated',
  PEER_DEVIATION_DETECTED = 'intelligence.peer_deviation_detected',
  REVIEWER_QUALITY_SCORED = 'intelligence.reviewer_quality_scored',

  // ── Webhooks ───────────────────────────────────────
  WEBHOOK_DELIVERY_FAILED = 'webhook.delivery_failed',
  WEBHOOK_SUBSCRIPTION_CREATED = 'webhook.subscription_created',
  WEBHOOK_SUBSCRIPTION_UPDATED = 'webhook.subscription_updated',
  WEBHOOK_SUBSCRIPTION_DELETED = 'webhook.subscription_deleted',
  /**
   * Re-delivery of one webhook that ran out of delivery attempts. Never emitted by a service: it
   * is the dead-letter entry's stored event, which the DLQ retry hands to
   * EventDeliveryService.handleDeliveryRetry. Payload: WebhookDeliveryRetryPayload
   */
  WEBHOOK_DELIVERY_RETRY = 'webhook.delivery_retry',

  // ── Dead Letter Queue ──────────────────────────────
  DLQ_ENTRY_RETRIED = 'dlq.entry_retried',
  DLQ_ENTRY_FAILED_PERMANENTLY = 'dlq.entry_failed_permanently',

  // ── Email Notifications ────────────────────────────
  /**
   * Retry of one email notification whose send failed. Never emitted by a service: it is the
   * dead-letter entry's stored event, which the DLQ retry re-emits. Payload: EmailNotificationRetryPayload
   */
  EMAIL_NOTIFICATION_RETRY = 'notification.email_retry',

  // ── Mover Workflow ─────────────────────────────────
  /** MoverService started a mover run (attribute change, re-evaluation, HR sync). Payload: MoverStartedPayload */
  MOVER_STARTED = 'mover.started',
  /** A mover run completed, changed nothing or was skipped. Payload: MoverCompletedPayload (MoverOutcome) */
  MOVER_COMPLETED = 'mover.completed',
  /** A mover run failed. Payload: MoverFailedPayload (MoverOutcome) */
  MOVER_FAILED = 'mover.failed',
  /**
   * Emitted by HR ingestion after HR_SYNC_COMPLETED's leaver detection answered, so this run's
   * leavers are known. Payload: HrSyncCompletedPayload. The HR mover handler returns MoverSyncSummary.
   */
  HR_SYNC_MOVERS_REQUESTED = 'connector.hr_sync_movers_requested',
  /** An HR sync left more movers than the mass-mover limit: none started, a batch awaits approval. */
  MOVER_BATCH_PAUSED = 'mover.batch_paused',
  MOVER_BATCH_APPROVED = 'mover.batch_approved',
  MOVER_BATCH_REJECTED = 'mover.batch_rejected',
  /** Payload: { changedFields } of the tenant's HR mover policy. */
  MOVER_POLICY_UPDATED = 'mover.policy_updated',

  // ── HR Joiners ─────────────────────────────────────
  /**
   * Emitted by HR ingestion after HR mover detection, once leaver detection answered, so this
   * run's leavers are known. Payload: HrSyncCompletedPayload. The HR joiner handler returns
   * JoinerSyncSummary.
   */
  HR_SYNC_JOINERS_REQUESTED = 'connector.hr_sync_joiners_requested',
  /** An HR sync started the onboarding of a joiner it minted. Payload: JoinerOnboardingStartedPayload */
  JOINER_ONBOARDING_STARTED = 'identity.joiner_onboarding_started',
  /**
   * A joiner's onboarding waits on its HR data (its start date is not a date), emitted once when
   * it starts waiting for that reason. Payload: JoinerOnboardingWaitingPayload
   */
  JOINER_ONBOARDING_WAITING = 'identity.joiner_onboarding_waiting',
  /** An HR sync left more due joiners than the mass-joiner limit: none started, a batch awaits approval. */
  JOINER_BATCH_PAUSED = 'joiner.batch_paused',
  JOINER_BATCH_APPROVED = 'joiner.batch_approved',
  JOINER_BATCH_REJECTED = 'joiner.batch_rejected',
  /** Payload: { changedFields } of the tenant's HR joiner policy. */
  JOINER_POLICY_UPDATED = 'joiner.policy_updated',

  // ── Credential Lifecycle ───────────────────────────
  // credential.rotated and credential.rotation_failed were withdrawn (2026-11-25): EuroID resets
  // no password, so nothing emitted them.
  CREDENTIAL_EXPIRING_SOON = 'credential.expiring_soon',
  CREDENTIAL_INVENTORY_UPDATED = 'credential.inventory_updated',

  // ── Non-Human Identity (NHI) ────────────────────────
  NHI_CREATED = 'nhi.created',
  NHI_REVOKED = 'nhi.revoked',
  NHI_KILL_SWITCH_ENGAGED = 'nhi.kill_switch_engaged',
  NHI_DELEGATED = 'nhi.delegated',
  NHI_CREDENTIAL_ISSUED = 'nhi.credential_issued',
  NHI_CREDENTIAL_ROTATED = 'nhi.credential_rotated',
  /** The agent's owner was offboarded: it gets no new credential until re-owned or revoked. */
  NHI_OWNER_LOST = 'nhi.owner_lost',
  NHI_OWNER_CHANGED = 'nhi.owner_changed',
}
