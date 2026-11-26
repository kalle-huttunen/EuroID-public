import { z } from 'zod';
import { DomainEventType } from './event-types';
import { ADMIN_USER_EVENT_SCHEMAS } from './admin-user-event-schemas';
import { ENTITLEMENT_EXPIRY_EVENT_SCHEMAS } from './entitlement-expiry-event-schemas';
import { ACCESS_EVENT_SCHEMAS } from './access-event-schemas';
import { DEPROVISION_EVENT_SCHEMAS } from './deprovision-event-schemas';

// No email: the offboarding handler reads the address from the identity by userId
const identityOffboardRequestedSchema = z.object({
  userId: z.string(),
  reason: z.string().optional(),
});

// ── HR leavers (event-payloads.ts: HrSyncCompletedPayload, Leaver*Payload) ──────

const leaverReasonSchema = z.enum(['terminated', 'end-date', 'missing-from-source']);

const hrSyncCompletedSchema = z.object({
  connectorName: z.string(),
  sourceName: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  fetched: z.number(),
  skipped: z.number(),
  ingested: z.number(),
  errorCount: z.number(),
});

const leaverDetectedSchema = z.object({
  identityId: z.string(),
  leaverEventId: z.string(),
  reason: leaverReasonSchema,
  sourceName: z.string(),
  effectiveDate: z.string().optional(),
  paused: z.boolean(),
  batchId: z.string().optional(),
});

const leaverOffboardingStartedSchema = z.object({
  identityId: z.string(),
  leaverEventId: z.string(),
  reason: leaverReasonSchema,
  workflowId: z.string(),
  batchId: z.string().optional(),
});

const offboardingCompletedSchema = z.object({
  identityId: z.string(),
  workflowId: z.string(),
  status: z.enum(['completed', 'partial-failure']),
  hubStatus: z.enum(['deleted', 'suspended']),
  systems: z.array(
    z.object({
      system: z.string(),
      outcome: z.enum([
        'deprovisioned',
        'already-gone',
        'not-applicable',
        'failed',
        'removed-manually',
      ]),
      detail: z.string().optional(),
      reason: z.string().optional(),
      manualRemoval: z.object({ by: z.string(), at: z.string(), reason: z.string() }).optional(),
    }),
  ),
  linkedAdmins: z
    .array(
      z.object({
        identityId: z.string(),
        workflowId: z.string(),
        outcome: z.enum(['offboarded', 'failed', 'running-elsewhere']),
        reason: z.string().optional(),
      }),
    )
    .optional(),
});

const offboardingTargetRemovedManuallySchema = z.object({
  identityId: z.string(),
  leaverEventId: z.string().optional(),
  workflowId: z.string(),
  system: z.string(),
  reason: z.string(),
  offboardingComplete: z.boolean(),
});

// ── Mover (event-payloads.ts: MoverStartedPayload, MoverOutcome) ──────────────

const moverTriggerSchema = z.enum(['attribute-change', 're-evaluate', 'hr-sync']);

const moverStartedSchema = z.object({
  identityId: z.string(),
  workflowId: z.string(),
  trigger: moverTriggerSchema,
  changedFields: z.array(z.string()),
});

const moverOutcomeSchema = z.object({
  identityId: z.string(),
  workflowId: z.string(),
  trigger: moverTriggerSchema,
  status: z.enum(['completed', 'no-change', 'skipped', 'failed']),
  changedFields: z.array(z.string()),
  added: z.number(),
  removed: z.number(),
  systems: z.array(
    z.object({
      system: z.string(),
      outcome: z.enum(['updated', 'failed', 'not-supported', 'not-attempted', 'no-account']),
      added: z.array(z.string()),
      removed: z.array(z.string()),
      reason: z.string().optional(),
    }),
  ),
  reason: z.string().optional(),
  durationMs: z.number(),
});

const leaverBatchSchema = z.object({
  batchId: z.string(),
  sourceName: z.string(),
  identityCount: z.number(),
  limit: z.number().optional(),
  activeIdentityCount: z.number().optional(),
  started: z.number().optional(),
  comment: z.string().optional(),
});

const leaverPolicyUpdatedSchema = z.object({
  changedFields: z.array(z.string()),
});

// ── HR movers (event-payloads.ts: MoverBatchPayload) ───────────────────────────

const moverBatchSchema = z.object({
  batchId: z.string(),
  sourceName: z.string(),
  identityCount: z.number(),
  limit: z.number().optional(),
  activeIdentityCount: z.number().optional(),
  started: z.number().optional(),
  comment: z.string().optional(),
});

// ── HR joiners (event-payloads.ts: JoinerOnboardingStartedPayload, JoinerBatchPayload) ──────

const joinerOnboardingStartedSchema = z.object({
  identityId: z.string(),
  joinerEventId: z.string(),
  sourceName: z.string(),
  workflowId: z.string(),
  batchId: z.string().optional(),
  rehire: z.boolean().optional(),
});

const joinerOnboardingWaitingSchema = z.object({
  identityId: z.string(),
  joinerEventId: z.string(),
  sourceName: z.string(),
  reason: z.enum(['start-date-unreadable']),
});

const joinerBatchSchema = z.object({
  batchId: z.string(),
  sourceName: z.string(),
  identityCount: z.number(),
  limit: z.number().optional(),
  activeIdentityCount: z.number().optional(),
  started: z.number().optional(),
  comment: z.string().optional(),
});

const identityOffboardImpactQuerySchema = z.object({
  identityId: z.string(),
});

const identityEntitlementsQuerySchema = z.object({
  identityId: z.string(),
});

// No email: the identity is the aggregate, the onboarding handler reads the address by it
const identityProvisionRequestedSchema = z.object({
  syncToEntra: z.boolean().optional(),
  reason: z.string().optional(),
});

// ── Critical event schemas (matching event-payloads.ts) ────────────────────────

// No email: handlers read the address from the identity by identityId
const identityCreatedSchema = z.object({
  identityId: z.string(),
  sourceSystem: z.string(),
  sourceUserId: z.string().optional(),
  status: z.string(),
  triggerWorkflow: z.boolean().optional(),
});

const identityUpdatedSchema = z.object({
  identityId: z.string(),
  changedFields: z.array(z.string()),
  source: z.string(),
  syncToEntra: z.boolean().optional(),
  // PATCH /identity/:id asks the mover itself (identity.move_requested)
  moverRequested: z.boolean().optional(),
  // The mover's "before" profile (access attributes only, an email value masked;
  // IdentityMutationService). No email of the identity: handlers read it from the identity.
  previousAttributes: z.record(z.unknown()).optional(),
  // A write-back (source 'writeback'): the connector whose new account was written back
  targetSystem: z.string().optional(),
});

const identityMoveRequestedSchema = z.object({
  identityId: z.string(),
  changedFields: z.array(z.string()),
  previousAttributes: z.record(z.unknown()),
  syncToEntra: z.boolean().optional(),
});

const identityDeletedSchema = z.object({
  identityId: z.string(),
  reason: z.string(),
});

// identityId is absent when the caller passed a profile without the identity's id (bulk rows,
// PAM admin profiles): the event then goes under its connector, never under an email.
const provisioningCompletedSchema = z.object({
  identityId: z.string().optional(),
  connector: z.string(),
  targetUserId: z.string().optional(),
  operations: z.array(
    z.object({
      action: z.enum(['add', 'remove']),
      type: z.enum(['group', 'license', 'role']),
      targetId: z.string(),
      success: z.boolean(),
    }),
  ),
  detail: z.string().optional(),
  durationMs: z.number(),
});

const provisioningFailedSchema = z.object({
  identityId: z.string().optional(),
  // Access request fulfilment and revoke: the request whose change Graph refused
  accessRequestId: z.string().optional(),
  connector: z.string(),
  error: z.string(),
  retryable: z.boolean(),
  partialFailure: z.boolean().optional(),
  operation: z.string().optional(),
  targetId: z.string().optional(),
});

const policyEvaluatedSchema = z.object({
  identityId: z.string().optional(),
  matchedPolicies: z.array(z.string()),
  generatedOperations: z.number(),
  durationMs: z.number(),
  forProvisioning: z.boolean().optional(),
});

const driftDetectedSchema = z.object({
  identityId: z.string(),
  system: z.string(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  discrepancies: z.array(
    z.object({
      field: z.string(),
      expected: z.string(),
      actual: z.string(),
      action: z.enum(['REVERT', 'ABSORB', 'IGNORE']),
    }),
  ),
});

const driftResolvedSchema = z.object({
  driftId: z.string(),
  identityId: z.string(),
  system: z.string(),
  resolutionAction: z.string(),
});

// ── Additional event schemas (matching event-payloads.ts interfaces) ────────────

const identityStatusChangedSchema = z.object({
  identityId: z.string(),
  previousStatus: z.string(),
  newStatus: z.string(),
  reason: z.string(),
});

const policyCreatedSchema = z.object({
  policyId: z.string(),
  name: z.string(),
  createdBy: z.string(),
});

const policyUpdatedSchema = z.object({
  policyId: z.string(),
  changedFields: z.array(z.string()),
  // The status before (PolicyStatus): activate's, or a role bundle edit sending it to DRAFT
  previousStatus: z.string().optional(),
});

const policyDeletedSchema = z.object({
  policyId: z.string(),
  name: z.string(),
});

const circuitBreakerTrippedSchema = z.object({
  system: z.string(),
  reason: z.string(),
});

// event-payloads.ts: DriftThresholdExceededPayload (counts and the run's ids only)
const driftThresholdExceededSchema = z.object({
  workflowId: z.string(),
  runId: z.string(),
  totalDrifts: z.number().int().nonnegative(),
  criticalDrifts: z.number().int().nonnegative(),
  alerts: z.array(
    z.object({
      threshold: z.enum(['maxDriftsBeforeAlert', 'criticalDriftAlertThreshold']),
      limit: z.number().int().positive(),
      found: z.number().int().nonnegative(),
    }),
  ),
});

// event-payloads.ts: DiscoveryCompletedPayload (counts only; the catalog has the entries)
const discoveryCompletedSchema = z.object({
  system: z.string(),
  discovered: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});

const orphanDetectedSchema = z.object({
  driftId: z.string(),
  targetSystem: z.string(),
  externalId: z.string(),
  accountIdentifier: z.string(),
  tenantId: z.string(),
});

const simulationCompletedSchema = z.object({
  policyId: z.string(),
  affectedUsers: z.number(),
  additions: z.number(),
  removals: z.number(),
  highRiskChanges: z.number(),
  durationMs: z.number(),
});

const anomalyDetectedSchema = z.object({
  anomalyId: z.string(),
  identityId: z.string(),
  type: z.string(),
  severity: z.string(),
  riskScore: z.number(),
});

const anomalyResolvedSchema = z.object({
  anomalyId: z.string(),
  identityId: z.string(),
  status: z.enum(['dismissed', 'resolved']),
});

const accessReviewCampaignCreatedSchema = z.object({
  campaignId: z.string(),
  name: z.string(),
  createdBy: z.string(),
  scope: z.object({ type: z.string(), value: z.string().optional() }),
});

const accessReviewCampaignActivatedSchema = z.object({
  campaignId: z.string(),
  name: z.string(),
  itemCount: z.number(),
  deadline: z.any(), // Date or ISO string from workflows
});

const accessReviewCampaignCompletedSchema = z.object({
  campaignId: z.string(),
  stats: z.object({
    totalItems: z.number(),
    approved: z.number(),
    revoked: z.number(),
    pending: z.number(),
    expired: z.number(),
  }),
});

/** The admin is the event's actor; `reason` is their free text from the cancel, when given. */
const accessReviewCampaignCancelledSchema = z.object({
  campaignId: z.string(),
  name: z.string(),
  previousStatus: z.enum(['DRAFT', 'ACTIVE']),
  reason: z.string().optional(),
});

const accessReviewItemDecidedSchema = z.object({
  itemId: z.string(),
  campaignId: z.string(),
  identityId: z.string(),
  decidedBy: z.string(),
  justification: z.string().optional(),
});

const accessReviewItemExpiredSchema = z.object({
  itemId: z.string(),
  campaignId: z.string(),
  identityId: z.string(),
  reviewerId: z.string(),
});

const accessReviewAccountRevokedSchema = z.object({
  identityId: z.string(),
  campaignId: z.string(),
  itemId: z.string(),
  targetSystem: z.string(),
  outcome: z.enum(['removed', 'already-gone', 'manual-action-needed', 'failed']),
  detail: z.string().optional(),
  reason: z.string().optional(),
});

// ── Intelligence event schemas ──────────────────────────────────────────────────

const peerGroupUpdatedSchema = z.object({
  tenantId: z.string(),
  groupKey: z.string(),
  memberCount: z.number(),
  outlierCount: z.number(),
});

const peerDeviationDetectedSchema = z.object({
  tenantId: z.string(),
  identityId: z.string(),
  groupKey: z.string(),
  deviationScore: z.number(),
  uniqueEntitlements: z.array(z.string()),
});

/** One per tenant and batch run that scored at least one campaign. */
const reviewerQualityScoredSchema = z.object({
  tenantId: z.string(),
  /** The first of campaignIds; kept for subscribers that read it. */
  campaignId: z.string(),
  /** The campaigns scored in this tenant by this run. */
  campaignIds: z.array(z.string()).min(1),
  /** Distinct reviewers who got a score in those campaigns. */
  reviewersScoredCount: z.number(),
});

// ── Webhook event schemas ────────────────────────────────────────────────────

const webhookDeliveryFailedSchema = z.object({
  subscriptionId: z.string(),
  eventType: z.string(),
  eventId: z.string(),
  error: z.string(),
  attempts: z.number(),
});

const webhookSubscriptionCreatedSchema = z.object({
  subscriptionId: z.string(),
  name: z.string(),
  /** The URL's host (and port): never the URL, whose path or query can carry the receiver's token. */
  webhookHost: z.string(),
});

const webhookSubscriptionUpdatedSchema = z.object({
  subscriptionId: z.string(),
  name: z.string(),
  /** The fields the PATCH set: name, status, filters, webhook.url, webhook.headers, webhook.signingSecret. */
  changed: z.array(z.string()),
  /** The new URL's host (and port), only when the URL changed: never the URL itself. */
  webhookHost: z.string().optional(),
});

const webhookSubscriptionDeletedSchema = z.object({
  subscriptionId: z.string(),
  name: z.string(),
});

// ── Dead Letter Queue event schemas ─────────────────────────────────────────

const dlqEntryRetriedSchema = z.object({
  entryId: z.string(),
  type: z.string(),
  source: z.string(),
  retryCount: z.number(),
});

const dlqEntryFailedPermanentlySchema = z.object({
  entryId: z.string(),
  type: z.string(),
  source: z.string(),
  retryCount: z.number(),
  error: z.string(),
});

// ── Credential lifecycle (event-payloads.ts: CredentialInventoryUpdatedPayload) ────────────────

const count = z.number().int().nonnegative();

// Counts only: z.object strips any other key before a handler, the audit log or a webhook sees it
const credentialInventoryUpdatedSchema = z.object({
  refreshed: count,
  changed: count,
  unknown: count,
  removed: count,
});

// ── NHI event schemas ──────────────────────────────────────────────────────────

const nhiCreatedSchema = z.object({
  agentId: z.string(),
  kind: z.string(),
  ownerIdentityId: z.string(),
  riskTier: z.string(),
});

const nhiRevokedSchema = z.object({
  agentId: z.string(),
  reason: z.string(),
  killSwitch: z.boolean(),
});

const nhiDelegatedSchema = z.object({
  parentAgentId: z.string(),
  childAgentId: z.string(),
});

// Ids only: the owner's email stays out of the audit log and webhooks
const nhiOwnerLostSchema = z.object({
  agentId: z.string(),
  ownerIdentityId: z.string(),
  reason: z.enum(['offboarded', 'erased']),
});

const nhiOwnerChangedSchema = z.object({
  agentId: z.string(),
  previousOwnerIdentityId: z.string(),
  ownerIdentityId: z.string(),
});

const nhiCredentialIssuedSchema = z.object({
  agentId: z.string(),
  spiffeId: z.string(),
  expiresAt: z.string(),
  fingerprint: z.string(),
});

// Permissive fallback for events without typed payloads (connectors, pipeline, etc.)
const fallbackSchema = z.object({}).passthrough();

/**
 * Registry mapping DomainEventType to Zod schema for runtime payload validation.
 * Event types without a schema use a permissive record (not z.any()).
 */
export const EVENT_SCHEMAS: Partial<Record<DomainEventType, z.ZodSchema>> = {
  // Identity Lifecycle
  [DomainEventType.IDENTITY_CREATED]: identityCreatedSchema,
  [DomainEventType.IDENTITY_UPDATED]: identityUpdatedSchema,
  [DomainEventType.IDENTITY_DELETED]: identityDeletedSchema,
  [DomainEventType.IDENTITY_STATUS_CHANGED]: identityStatusChangedSchema,
  [DomainEventType.IDENTITY_OFFBOARD_REQUESTED]: identityOffboardRequestedSchema,
  [DomainEventType.IDENTITY_OFFBOARD_IMPACT_QUERY]: identityOffboardImpactQuerySchema,
  [DomainEventType.IDENTITY_ENTITLEMENTS_QUERY]: identityEntitlementsQuerySchema,
  [DomainEventType.IDENTITY_PROVISION_REQUESTED]: identityProvisionRequestedSchema,
  [DomainEventType.IDENTITY_MOVE_REQUESTED]: identityMoveRequestedSchema,

  // HR leavers
  [DomainEventType.HR_SYNC_COMPLETED]: hrSyncCompletedSchema,
  [DomainEventType.LEAVER_DETECTED]: leaverDetectedSchema,
  [DomainEventType.LEAVER_OFFBOARDING_STARTED]: leaverOffboardingStartedSchema,
  [DomainEventType.IDENTITY_OFFBOARDING_COMPLETED]: offboardingCompletedSchema,
  [DomainEventType.IDENTITY_OFFBOARDING_TARGET_REMOVED_MANUALLY]:
    offboardingTargetRemovedManuallySchema,
  [DomainEventType.LEAVER_BATCH_PAUSED]: leaverBatchSchema,
  [DomainEventType.LEAVER_BATCH_APPROVED]: leaverBatchSchema,
  [DomainEventType.LEAVER_BATCH_REJECTED]: leaverBatchSchema,
  [DomainEventType.LEAVER_POLICY_UPDATED]: leaverPolicyUpdatedSchema,

  // Mover
  [DomainEventType.HR_SYNC_MOVERS_REQUESTED]: hrSyncCompletedSchema,
  [DomainEventType.MOVER_BATCH_PAUSED]: moverBatchSchema,
  [DomainEventType.MOVER_BATCH_APPROVED]: moverBatchSchema,
  [DomainEventType.MOVER_BATCH_REJECTED]: moverBatchSchema,
  [DomainEventType.MOVER_POLICY_UPDATED]: leaverPolicyUpdatedSchema,
  [DomainEventType.MOVER_STARTED]: moverStartedSchema,
  [DomainEventType.MOVER_COMPLETED]: moverOutcomeSchema,
  [DomainEventType.MOVER_FAILED]: moverOutcomeSchema,

  // HR joiners
  [DomainEventType.HR_SYNC_JOINERS_REQUESTED]: hrSyncCompletedSchema,
  [DomainEventType.JOINER_ONBOARDING_STARTED]: joinerOnboardingStartedSchema,
  [DomainEventType.JOINER_ONBOARDING_WAITING]: joinerOnboardingWaitingSchema,
  [DomainEventType.JOINER_BATCH_PAUSED]: joinerBatchSchema,
  [DomainEventType.JOINER_BATCH_APPROVED]: joinerBatchSchema,
  [DomainEventType.JOINER_BATCH_REJECTED]: joinerBatchSchema,
  [DomainEventType.JOINER_POLICY_UPDATED]: leaverPolicyUpdatedSchema,

  // Provisioning
  [DomainEventType.PROVISIONING_COMPLETED]: provisioningCompletedSchema,
  [DomainEventType.PROVISIONING_FAILED]: provisioningFailedSchema,
  ...DEPROVISION_EVENT_SCHEMAS,

  // Policy
  [DomainEventType.POLICY_CREATED]: policyCreatedSchema,
  [DomainEventType.POLICY_UPDATED]: policyUpdatedSchema,
  [DomainEventType.POLICY_DELETED]: policyDeletedSchema,
  [DomainEventType.POLICY_EVALUATED]: policyEvaluatedSchema,

  // Reconciliation & Drift
  [DomainEventType.DRIFT_DETECTED]: driftDetectedSchema,
  [DomainEventType.DRIFT_RESOLVED]: driftResolvedSchema,
  [DomainEventType.CIRCUIT_BREAKER_TRIPPED]: circuitBreakerTrippedSchema,
  [DomainEventType.RECONCILIATION_DRIFT_THRESHOLD_EXCEEDED]: driftThresholdExceededSchema,
  [DomainEventType.ORPHAN_DETECTED]: orphanDetectedSchema,

  // Connector
  [DomainEventType.DISCOVERY_COMPLETED]: discoveryCompletedSchema,

  // Simulation
  [DomainEventType.SIMULATION_COMPLETED]: simulationCompletedSchema,

  // Anomaly
  [DomainEventType.ANOMALY_DETECTED]: anomalyDetectedSchema,
  [DomainEventType.ANOMALY_RESOLVED]: anomalyResolvedSchema,

  // Access Review
  [DomainEventType.ACCESS_REVIEW_CAMPAIGN_CREATED]: accessReviewCampaignCreatedSchema,
  [DomainEventType.ACCESS_REVIEW_CAMPAIGN_ACTIVATED]: accessReviewCampaignActivatedSchema,
  [DomainEventType.ACCESS_REVIEW_CAMPAIGN_COMPLETED]: accessReviewCampaignCompletedSchema,
  [DomainEventType.ACCESS_REVIEW_CAMPAIGN_CANCELLED]: accessReviewCampaignCancelledSchema,
  [DomainEventType.ACCESS_REVIEW_ITEM_APPROVED]: accessReviewItemDecidedSchema,
  [DomainEventType.ACCESS_REVIEW_ITEM_REVOKED]: accessReviewItemDecidedSchema,
  [DomainEventType.ACCESS_REVIEW_ITEM_EXPIRED]: accessReviewItemExpiredSchema,
  [DomainEventType.ACCESS_REVIEW_ACCOUNT_REVOKED]: accessReviewAccountRevokedSchema,

  // Intelligence
  [DomainEventType.PEER_GROUP_UPDATED]: peerGroupUpdatedSchema,
  [DomainEventType.PEER_DEVIATION_DETECTED]: peerDeviationDetectedSchema,
  [DomainEventType.REVIEWER_QUALITY_SCORED]: reviewerQualityScoredSchema,

  // Webhooks
  [DomainEventType.WEBHOOK_DELIVERY_FAILED]: webhookDeliveryFailedSchema,
  [DomainEventType.WEBHOOK_SUBSCRIPTION_CREATED]: webhookSubscriptionCreatedSchema,
  [DomainEventType.WEBHOOK_SUBSCRIPTION_UPDATED]: webhookSubscriptionUpdatedSchema,
  [DomainEventType.WEBHOOK_SUBSCRIPTION_DELETED]: webhookSubscriptionDeletedSchema,

  // Dead Letter Queue
  [DomainEventType.DLQ_ENTRY_RETRIED]: dlqEntryRetriedSchema,
  [DomainEventType.DLQ_ENTRY_FAILED_PERMANENTLY]: dlqEntryFailedPermanentlySchema,

  // Credential lifecycle
  [DomainEventType.CREDENTIAL_INVENTORY_UPDATED]: credentialInventoryUpdatedSchema,

  // NHI
  [DomainEventType.NHI_CREATED]: nhiCreatedSchema,
  [DomainEventType.NHI_REVOKED]: nhiRevokedSchema,
  [DomainEventType.NHI_KILL_SWITCH_ENGAGED]: nhiRevokedSchema,
  [DomainEventType.NHI_DELEGATED]: nhiDelegatedSchema,
  [DomainEventType.NHI_CREDENTIAL_ISSUED]: nhiCredentialIssuedSchema,
  [DomainEventType.NHI_CREDENTIAL_ROTATED]: nhiCredentialIssuedSchema,
  [DomainEventType.NHI_OWNER_LOST]: nhiOwnerLostSchema,
  [DomainEventType.NHI_OWNER_CHANGED]: nhiOwnerChangedSchema,

  // Time-bound access (entitlement-expiry-event-schemas.ts)
  ...ENTITLEMENT_EXPIRY_EVENT_SCHEMAS,

  // Console admins and invites (admin-user-event-schemas.ts)
  ...ADMIN_USER_EVENT_SCHEMAS,

  // Access requests, review escalation and exclusions, PAM admin accounts (access-event-schemas.ts)
  ...ACCESS_EVENT_SCHEMAS,
};

/**
 * Get schema for an event type. Returns fallback when no schema is registered.
 */
export function getEventSchema(type: DomainEventType): z.ZodSchema {
  return EVENT_SCHEMAS[type] ?? fallbackSchema;
}
