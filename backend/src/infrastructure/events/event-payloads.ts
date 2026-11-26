import type { OffboardingResult } from '@shared/types/deprovision';
import type { MoverOutcome, MoverTrigger } from '@shared/types/mover';
export type {
  AccessReviewAccountRevokedPayload,
  AccessReviewMembershipRevokedPayload,
} from '@shared/types/access-review-revocation';
export type {
  JoinerBatchPayload,
  JoinerOnboardingStartedPayload,
  JoinerOnboardingWaitingPayload,
} from '@shared/types/joiner-events';

/** identity.created (POST /identity, an HR sync's mint). No email: handlers read it by id. */
export interface IdentityCreatedPayload {
  identityId: string;
  sourceSystem: string;
  /** The id the caller of POST /identity gave; absent otherwise (never the email). */
  sourceUserId?: string;
  status: string;
  /** When true, onboarding workflow should be triggered (from POST /identity?triggerWorkflow=true) */
  triggerWorkflow?: boolean;
}

/** identity.updated */
export interface IdentityUpdatedPayload {
  identityId: string;
  changedFields: string[];
  source: string;
  /**
   * From PATCH /identity/:id?syncToEntra=true. That route starts the run itself (the mover through
   * identity.move_requested, else onboarding through identity.provision_requested), so neither
   * the mover nor the onboarding handler starts one for this event.
   */
  syncToEntra?: boolean;
  /**
   * From PATCH /identity/:id: the route asks the mover itself (identity.move_requested) and
   * reports the run or the queued change, so the mover handler starts nothing for this event.
   * Onboarding's handler still takes an edit of an identity the mover does not apply to.
   */
  moverRequested?: boolean;
  /**
   * The before-values of the access attributes whose value the update changed (null for one
   * that had none; shared/utils/access-baseline.ts changedAccessAttributes): which trigger
   * attributes the edit moved, and the mover's "before" profile for an identity without an access
   * baseline (MoverEventHandler; with a baseline the mover takes "before" from it). No names,
   * contact data or identifiers, and an email value (managerEmail) masked: the event reaches the
   * audit log, the analytics index and the tenant websocket. The event carries no email of the
   * identity either: a handler reads it from the identity.
   */
  previousAttributes?: Record<string, unknown>;
  /**
   * A write-back (source 'writeback', WritebackActivities.writebackToIdentity): the connector whose
   * new account was written back. changedFields then names the attributes written to that
   * connector's source entry, and the event carries depth 1, so no mover or onboarding run starts.
   */
  targetSystem?: string;
}

/**
 * identity.move_requested: PATCH /identity/:id asks the mover for an edit that moves a trigger
 * attribute (with ?syncToEntra=true before onboarding).
 */
export interface IdentityMoveRequestedPayload {
  identityId: string;
  /** The fields the PATCH wrote. */
  changedFields: string[];
  /** As identity.updated's previousAttributes. */
  previousAttributes: Record<string, unknown>;
  /** ?syncToEntra=true: the run updates the Entra ID account also without an access change. */
  syncToEntra?: boolean;
}

/** identity.move_requested's answer for an edit queued on the identity's open mover run. */
export interface MoverQueuedAnswer {
  moverQueued: true;
  workflowId: string;
}

/** Whether a listener's answer to identity.move_requested is a queued edit. */
export function isMoverQueuedAnswer(answer: unknown): answer is MoverQueuedAnswer {
  return (
    typeof answer === 'object' &&
    answer !== null &&
    (answer as MoverQueuedAnswer).moverQueued === true &&
    typeof (answer as MoverQueuedAnswer).workflowId === 'string'
  );
}

/** identity.offboard_requested. No email: the handler reads it from the identity by userId. */
export interface IdentityOffboardRequestedPayload {
  userId: string;
  /** Why offboarding starts, e.g. `leaver:terminated`. Unset for a manual DELETE. Kept in the workflow memo. */
  reason?: string;
}

/** Why an HR sync treats an identity as a leaver. */
export type LeaverReason = 'terminated' | 'end-date' | 'missing-from-source';

/** connector.hr_sync_completed: one HR ingest run (no PII, no per-person data). */
export interface HrSyncCompletedPayload {
  connectorName: string;
  /** identity.sources[].sourceName the run wrote (normalised sourceSystem). */
  sourceName: string;
  startedAt: string;
  completedAt: string;
  /** Records the connector returned. */
  fetched: number;
  /** Rows the connector could not map (no id or email). */
  skipped: number;
  ingested: number;
  errorCount: number;
}

/** identity.leaver_detected */
export interface LeaverDetectedPayload {
  identityId: string;
  leaverEventId: string;
  reason: LeaverReason;
  sourceName: string;
  /** ISO date the leaver became effective (end date or last seen), when known. */
  effectiveDate?: string;
  /** True when the run exceeded the mass-leaver limit and the leaver waits in a batch. */
  paused: boolean;
  batchId?: string;
}

/** identity.leaver_offboarding_started */
export interface LeaverOffboardingStartedPayload {
  identityId: string;
  leaverEventId: string;
  reason: LeaverReason;
  workflowId: string;
  batchId?: string;
}

/**
 * identity.offboarding_completed: the per-system outcome of one offboarding run (deprovisioned,
 * already-gone, not-applicable, failed with reason) and what became of the Golden Record.
 * Carries system names, outcomes and reasons only, no names or emails.
 */
export type OffboardingCompletedPayload = OffboardingResult;

/**
 * identity.offboarding_target_removed_manually: an admin (event actor) confirmed that `system`,
 * which the offboarding `workflowId` reported failed, no longer has the account. `leaverEventId`
 * is the HR leaver event that started that offboarding, absent when DELETE /identity/:id did.
 * `reason` is the admin's note. `offboardingComplete`: no target of that offboarding is left
 * failed, so the Golden Record is deleted like after a fully successful offboarding.
 */
export interface OffboardingTargetRemovedManuallyPayload {
  identityId: string;
  leaverEventId?: string;
  workflowId: string;
  system: string;
  reason: string;
  offboardingComplete: boolean;
}

/** leaver.batch_paused | leaver.batch_approved | leaver.batch_rejected */
export interface LeaverBatchPayload {
  batchId: string;
  sourceName: string;
  identityCount: number;
  /** batch_paused: the limit the run exceeded and the active identity count it came from. */
  limit?: number;
  activeIdentityCount?: number;
  /**
   * batch_approved before 2026-11-24: how many offboardings the approval started. Since then the
   * approval answers before they start and leaves it out; each start is its own
   * identity.leaver_offboarding_started.
   */
  started?: number;
  comment?: string;
}

/** leaver.policy_updated */
export interface LeaverPolicyUpdatedPayload {
  changedFields: string[];
}

/** identity.offboard_impact_query — controller emits, handler returns active requests for identity */
export interface IdentityOffboardImpactQueryPayload {
  identityId: string;
}

/** identity.entitlements_query — identity service emits, policy and access-request handlers return grants */
export interface IdentityEntitlementsQueryPayload {
  identityId: string;
}

/** One entitlement an identity should hold, as reported by a query handler. */
export interface IdentityEntitlementGrant {
  grantedBy: 'policy' | 'request';
  /** Group name, license SKU, role, etc. */
  entitlement: string;
  /** Entitlement kind (group, license, role, ...). */
  type: string;
  targetSystem: string;
  /** Human-readable origin: policy name or access request ID. */
  source: string;
  /** Access request lifecycle status (request grants only). */
  requestStatus?: string;
  /** End of the access a time-bound request grants, ISO 8601 (request grants only). */
  expiresAt?: string;
}

/** Handler result for identity.entitlements_query. `kind` tells it apart from wildcard listeners' results. */
export interface IdentityEntitlementsQueryResult {
  kind: 'identity-entitlements';
  grants: IdentityEntitlementGrant[];
}

/**
 * identity.provision_requested: controller emits, handler returns workflowId. The event's
 * aggregate is the identity's id, which the run's workflow id is built from. No email: the
 * handler reads it from the identity.
 */
export interface IdentityProvisionRequestedPayload {
  /** From PATCH /identity/:id?syncToEntra=true: onboarding provisions Entra ID even when SYNCED */
  syncToEntra?: boolean;
  /** Why onboarding starts, e.g. `joiner:hr-sync:csv-hr`. Unset for a manual start. Kept in the workflow memo. */
  reason?: string;
}

/** identity.deleted */
export interface IdentityDeletedPayload {
  identityId: string;
  reason: string;
}

/**
 * discovery.completed under the system: a connector's discovery was written to the entitlement
 * catalog (EntitlementCatalogService.absorbDiscovered). Counts only; the catalog has the entries.
 */
export interface DiscoveryCompletedPayload {
  system: string;
  /** Entitlements the discovery returned. */
  discovered: number;
  /** The system's catalog entries removed because discovery no longer returned them. */
  removed: number;
}

/** identity.status_changed */
export interface IdentityStatusChangedPayload {
  identityId: string;
  previousStatus: string;
  newStatus: string;
  reason: string;
}

/**
 * provisioning.completed under the identity's id; for a profile without `_id` (bulk rows, PAM
 * profiles) under the connector, identityId absent (no timeline entry). No email, name or UPN.
 */
export interface ProvisioningCompletedPayload {
  identityId?: string;
  connector: string;
  /** The account's id in the target; absent for a target that keeps no account. */
  targetUserId?: string;
  operations: Array<{
    action: 'add' | 'remove';
    type: 'group' | 'license' | 'role';
    targetId: string;
    success: boolean;
  }>;
  /** What a target that keeps no account did (TargetProvisionResult.detail). */
  detail?: string;
  durationMs: number;
}

/** provisioning.failed: identity as in provisioning.completed; the error has emails masked. */
export interface ProvisioningFailedPayload {
  identityId?: string;
  /** Access request fulfilment and revoke: the request whose change Graph refused. */
  accessRequestId?: string;
  connector: string;
  error: string;
  retryable: boolean;
  partialFailure?: boolean;
  operation?: string;
  targetId?: string;
}

/** policy.evaluated under the identity's id; for a profile without `_id` under 'policy-engine'. */
export interface PolicyEvaluatedPayload {
  identityId?: string;
  matchedPolicies: string[];
  generatedOperations: number;
  durationMs: number;
  /** A workflow provisions from it (evaluateUser): the timeline records it. Not for what-ifs. */
  forProvisioning?: boolean;
}

/** drift.detected */
export interface DriftDetectedPayload {
  identityId: string;
  system: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  discrepancies: Array<{
    field: string;
    expected: string;
    actual: string;
    action: 'REVERT' | 'ABSORB' | 'IGNORE';
  }>;
}

/** simulation.completed */
export interface SimulationCompletedPayload {
  policyId: string;
  affectedUsers: number;
  additions: number;
  removals: number;
  highRiskChanges: number;
  durationMs: number;
}

/** policy.created */
export interface PolicyCreatedPayload {
  policyId: string;
  name: string;
  createdBy: string;
}

/** policy.updated */
export interface PolicyUpdatedPayload {
  policyId: string;
  changedFields: string[];
  /** The status before: activate's, or a policy a role bundle edit sent back to DRAFT. */
  previousStatus?: string;
}

/** policy.deleted */
export interface PolicyDeletedPayload {
  policyId: string;
  name: string;
}

/** drift.resolved */
export interface DriftResolvedPayload {
  driftId: string;
  identityId: string;
  system: string;
  resolutionAction: string;
}

/**
 * reconciliation.drift_threshold_exceeded (aggregate: the run id): a reconciliation run reached
 * maxDriftsBeforeAlert or criticalDriftAlertThreshold with notifyOnDrift on. Counts and the
 * run's ids only: no identity, account or address.
 */
export interface DriftThresholdExceededPayload {
  /** `t-<tenant>-daily-recon`: GET /reconciliation/result/:workflowId answers the run's report. */
  workflowId: string;
  runId: string;
  totalDrifts: number;
  criticalDrifts: number;
  alerts: Array<{
    threshold: 'maxDriftsBeforeAlert' | 'criticalDriftAlertThreshold';
    limit: number;
    found: number;
  }>;
}

/** drift.circuit_breaker_tripped */
export interface CircuitBreakerTrippedPayload {
  system: string;
  reason: string;
}

/** orphan.detected */
export interface OrphanDetectedPayload {
  driftId: string;
  targetSystem: string;
  externalId: string;
  accountIdentifier: string;
  tenantId: string;
}

/** anomaly.detected */
export interface AnomalyDetectedPayload {
  anomalyId: string;
  identityId: string;
  type: string;
  severity: string;
  riskScore: number;
}

/** anomaly.resolved */
export interface AnomalyResolvedPayload {
  anomalyId: string;
  identityId: string;
  status: 'dismissed' | 'resolved';
}

/** access_review.campaign_created */
export interface AccessReviewCampaignCreatedPayload {
  campaignId: string;
  name: string;
  createdBy: string;
  scope: { type: string; value?: string };
}

/** access_review.campaign_activated */
export interface AccessReviewCampaignActivatedPayload {
  campaignId: string;
  name: string;
  itemCount: number;
  deadline: Date;
}

/** access_review.campaign_completed */
export interface AccessReviewCampaignCompletedPayload {
  campaignId: string;
  stats: {
    totalItems: number;
    approved: number;
    revoked: number;
    pending: number;
    expired: number;
  };
}

/**
 * access_review.campaign_cancelled (AccessReviewCampaignService.cancel). Actor: the super-admin
 * who cancelled; `reason`: their free text, when given.
 */
export interface AccessReviewCampaignCancelledPayload {
  campaignId: string;
  name: string;
  previousStatus: 'DRAFT' | 'ACTIVE';
  reason?: string;
}

/** access_review.item_approved */
export interface AccessReviewItemApprovedPayload {
  itemId: string;
  campaignId: string;
  identityId: string;
  decidedBy: string;
}

/** access_review.item_revoked */
export interface AccessReviewItemRevokedPayload {
  itemId: string;
  campaignId: string;
  identityId: string;
  decidedBy: string;
  justification?: string;
}

/** access_review.item_expired */
export interface AccessReviewItemExpiredPayload {
  itemId: string;
  campaignId: string;
  identityId: string;
  reviewerId: string;
}

/** mover.started: no names or emails. Actor: the operator (re-evaluate) or the change's actor. */
export interface MoverStartedPayload {
  identityId: string;
  workflowId: string;
  trigger: MoverTrigger;
  /** The attributes whose change the run evaluates. */
  changedFields: string[];
}

/** mover.completed (completed, no-change, skipped): per system what changed. No names or emails. */
export type MoverCompletedPayload = MoverOutcome;

/** mover.failed: how far the run got and why it failed (emails masked). */
export type MoverFailedPayload = MoverOutcome;

/** mover.batch_paused | mover.batch_approved | mover.batch_rejected (HR-driven movers). No PII. */
export interface MoverBatchPayload {
  batchId: string;
  sourceName: string;
  identityCount: number;
  /** batch_paused: the limit the run exceeded and the active identity count it came from. */
  limit?: number;
  activeIdentityCount?: number;
  /**
   * batch_approved before 2026-11-24: how many mover runs the approval started. Since then the
   * approval answers before they start and leaves it out (the batch's startedCount has them).
   */
  started?: number;
  comment?: string;
}

/**
 * credential.expiring_soon (nightly credential rotation run): a password due within its policy's
 * warning window, or already due (daysRemaining 0 or less, with `reason`: it was not reset).
 * `externalId` has the name in an AD DN masked.
 */
export interface CredentialExpiringSoonPayload {
  identityId: string;
  targetSystem: string;
  externalId: string;
  expiresAt?: string;
  daysRemaining: number;
  /** Set when the credential is due: why the run did not reset it. */
  reason?: string;
}

/**
 * credential.inventory_updated (nightly credential rotation run): one per tenant and run, its
 * aggregateId the tenant. Counts only, no identity, account or person.
 */
export interface CredentialInventoryUpdatedPayload {
  /** Entra ID and AD accounts read this run, a row written for each. */
  refreshed: number;
  /**
   * Rows whose password status changed this run: a read row whose status is not what it was (a
   * new row counts), and a row not read this run that its due date moved to EXPIRED.
   */
  changed: number;
  /** Of the rows read, those written UNKNOWN (with the reason on the row). */
  unknown: number;
  /** Rows deleted: the identity no longer has that account. */
  removed: number;
}

/**
 * access_request.closed (AccessRequestClosureService, actor `system`): the system ended the
 * request, with the reason it stored as the request's statusReason. No requester or approver.
 * With `removedManually` (AccessRequestManualRemovalService, the admin as actor): an admin closed
 * an ACTIVE request whose removal kept failing as removed by hand, EXPIRED, `reason` their note.
 */
export interface AccessRequestClosedPayload {
  requestId: string;
  status: 'EXPIRED' | 'CANCELLED';
  reason: string;
  removedManually?: true;
}

/**
 * access_review.item_escalated (AccessReviewActivities.checkAndEscalateOverdue). No reviewer
 * address: the item (by itemId) names its new reviewer.
 */
export interface AccessReviewEscalatedPayload {
  itemId: string;
  campaignId: string;
  daysOverdue: number;
}

/**
 * entitlement.expiring_soon (7 days left) and entitlement.expiring_tomorrow: one time-bound
 * provisioning entry (`provisioning[].expiresAt`), from the hourly entitlementExpiryWorkflow.
 * No email (events from before 2.0dn had it): the mail module reads the identity's.
 */
export interface EntitlementExpiringPayload {
  identityId: string;
  targetSystem: string;
  expiresAt: Date | string;
}

/**
 * entitlement.expiry_failed: entitlementExpiryWorkflow could not deprovision an expired provisioning
 * entry. `retryable` false: later runs skip the entry until its expiresAt changes; true: tried again
 * from `nextAttemptAt`. `reason` has emails and LDAP DN names masked. Dates are ISO strings.
 */
export interface EntitlementExpiryFailedPayload {
  identityId: string;
  targetSystem: string;
  expiresAt: string;
  reason: string;
  retryable: boolean;
  attempts: number;
  nextAttemptAt?: string;
}

/**
 * entitlement.expired: entitlementExpiryWorkflow ended an expired provisioning entry (now
 * DEPROVISIONED). `outcome` as in offboarding: the target removed or disabled the account
 * (deprovisioned), had no such account any more (already-gone), or keeps no account
 * (not-applicable); `detail` says what the target did. Events from before 2.0dp have neither.
 */
export interface EntitlementExpiredPayload extends EntitlementExpiringPayload {
  outcome?: 'deprovisioned' | 'already-gone' | 'not-applicable';
  detail?: string;
}

/**
 * entitlement.expiry_retry_requested: an admin cleared the expiry failure of an entry
 * (POST /identity/:id/access/expiry/retry), so the next hourly run tries to remove it again.
 * `failureReason` is the failure that was cleared (masked). The actor is the admin.
 */
export interface EntitlementExpiryRetryRequestedPayload {
  identityId: string;
  targetSystem: string;
  /** ISO */
  expiresAt: string;
  failureReason: string;
}

/**
 * entitlement.expiry_removed_manually: an admin removed expired access the run could not remove
 * by hand and closed the entry (POST /identity/:id/access/expiry/removed-manually); the entry is
 * DEPROVISIONED. EuroID did not remove it. `reason` is the admin's note, `failureReason` the
 * expiry failure it closes. The actor is the admin.
 */
export interface EntitlementExpiryRemovedManuallyPayload {
  identityId: string;
  targetSystem: string;
  /** ISO */
  expiresAt: string;
  reason: string;
  failureReason: string;
}

/**
 * invite.cancelled: a super-admin cancelled a pending invite (DELETE /auth/invites/:id); its code
 * no longer registers anyone. Ids and roles only, as invite.created (same aggregateId, the
 * invite's id): no email, and the code is never in an event.
 */
export interface InviteCancelledPayload {
  roles: string[];
  /** The inviter's id as their token named it. */
  createdBy: string;
  cancelledBy: string;
  /** ISO: when the invite would have expired. */
  expiresAt: string;
}

/**
 * admin_user.role_changed: a super-admin gave a console admin (admin_users) another tenant role
 * (PATCH /auth/users/:id). It applies from the admin's next request. Ids and roles only.
 */
export interface AdminUserRoleChangedPayload {
  adminUserId: string;
  previousRole: string;
  newRole: string;
  changedBy: string;
}

/**
 * admin_user.password_reset_requested: someone asked for a password reset link for a console
 * admin's address (public POST /auth/password-reset/request) and a token was mailed (`mailSent`
 * false when the send failed). Only for an active account that signs in with a password. Never
 * the token or the address; the actor is `anonymous`.
 */
export interface AdminUserPasswordResetRequestedPayload {
  adminUserId: string;
  mailSent: boolean;
}

/**
 * admin_user.password_reset_issued: a super-admin issued a one-time password reset code for an
 * admin of the tenant (POST /auth/users/:id/password-reset). Never the code.
 */
export interface AdminUserPasswordResetIssuedPayload {
  adminUserId: string;
  issuedBy: string;
  /** ISO */
  expiresAt: string;
}

/**
 * admin_user.password_reset_completed: a reset token set a new password (public POST
 * /auth/password-reset/confirm); every session of the admin ended. Never the token or the
 * password; the actor is `anonymous`.
 */
export interface AdminUserPasswordResetCompletedPayload {
  adminUserId: string;
}

/** notification.email_retry: the dead-letter entry of an email whose send failed */
export interface EmailNotificationRetryPayload {
  notificationId: string;
  kind: string;
}

/** webhook.delivery_retry: the dead-letter entry of a webhook delivery that ran out of attempts */
export interface WebhookDeliveryRetryPayload {
  subscriptionId: string;
  /** The delivery attempt record (`webhook_delivery_attempts`), also the X-EuroID-Delivery id. */
  deliveryId: string;
  eventType: string;
  eventId: string;
  /** The JSON body as delivered: ids only, no personal data (webhook-payload.ts). */
  body: Record<string, unknown>;
}
