/**
 * Payload schemas of access request, access review escalation, membership revocation and
 * exclusion, PAM admin account and tenant identity limit events, merged into EVENT_SCHEMAS
 * (event-payload-schemas.ts).
 * Ids only, never an address: every event reaches the audit log and the tenant websocket, and a
 * failed handler stores the payload in the dead-letter store. A handler that needs an address
 * reads it by the id.
 */
import { z } from 'zod';
import { DomainEventType } from './event-types';

/**
 * access_request.created (AccessRequestCreationService). requesterId only when it is an identity
 * id: a requester without an identity is known by their email, which the event leaves out.
 */
const accessRequestCreatedSchema = z.object({
  requestId: z.string(),
  requesterId: z.string().optional(),
  status: z.string(),
});

/**
 * access_request.closed (AccessRequestClosureService, actor `system`): the system ended the
 * request, EXPIRED (its end date passed before approval completed) or CANCELLED (its approval
 * workflow had ended when an approver decided), with the reason stored on it. No requester or
 * approver. `removedManually` (AccessRequestManualRemovalService, the admin as actor): an admin
 * closed an ACTIVE request whose removal kept failing as removed by hand; `reason` is their note.
 */
const accessRequestClosedSchema = z.object({
  requestId: z.string(),
  status: z.enum(['EXPIRED', 'CANCELLED']),
  reason: z.string(),
  removedManually: z.literal(true).optional(),
});

/**
 * access_review.item_escalated (AccessReviewActivities.checkAndEscalateOverdue). No reviewer: the
 * mail handler reads the item's new reviewer by itemId.
 */
const accessReviewEscalatedSchema = z.object({
  itemId: z.string(),
  campaignId: z.string(),
  daysOverdue: z.number(),
});

/**
 * access_review.membership_revoked (AccessReviewRevocationActivities.recordRevocationResults): a
 * revoked group membership's removal at campaign close. The group by its id in the target, no
 * name; detail and reason masked.
 */
const accessReviewMembershipRevokedSchema = z.object({
  identityId: z.string(),
  campaignId: z.string(),
  itemId: z.string(),
  targetSystem: z.string(),
  groupId: z.string().optional(),
  outcome: z.enum(['removed', 'already-gone', 'manual-action-needed', 'failed']),
  detail: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * access_review.exclusion_created (ReviewExclusionService.record, at campaign close): the identity
 * is the aggregate. The entitlement by its id in the target, no name; no reviewer (the event's
 * actor) and no justification (free text, on the exclusion only).
 */
const accessReviewExclusionCreatedSchema = z.object({
  exclusionId: z.string(),
  identityId: z.string(),
  targetSystem: z.string(),
  scope: z.enum(['entitlement', 'account']),
  entitlementType: z.string(),
  entitlementId: z.string().optional(),
  campaignId: z.string(),
  itemId: z.string(),
  decision: z.enum(['revoked', 'expired']),
  grantingPolicyIds: z.array(z.string()),
});

/**
 * access_review.exclusion_lifted (ReviewExclusionService.lift: the admin is the actor;
 * endForOffboarding: the system, with `reason` 'identity offboarded').
 */
const accessReviewExclusionLiftedSchema = z.object({
  exclusionId: z.string(),
  identityId: z.string(),
  targetSystem: z.string(),
  scope: z.enum(['entitlement', 'account']),
  campaignId: z.string(),
  reason: z.string().optional(),
});

/** admin_account.created (PrivilegedAccessService): the admin identity is the aggregate. */
const adminAccountCreatedSchema = z.object({
  parentIdentityId: z.string(),
  adminTier: z.string(),
});

// Ids, the target's status and dates only: no login or email of the admin account or its owner
const adminAccountActivationPendingSchema = z.object({
  parentIdentityId: z.string(),
  targetSystem: z.string(),
  targetStatus: z.string(),
  pendingSince: z.string(),
  alertAfterDays: z.number().int(),
});

// Counts only
const tenantIdentityLimitExceededSchema = z.object({
  limit: z.number().int(),
  count: z.number().int(),
});

export const ACCESS_EVENT_SCHEMAS: Partial<Record<DomainEventType, z.ZodSchema>> = {
  [DomainEventType.ACCESS_REQUEST_CREATED]: accessRequestCreatedSchema,
  [DomainEventType.ACCESS_REQUEST_CLOSED]: accessRequestClosedSchema,
  [DomainEventType.ACCESS_REVIEW_ESCALATED]: accessReviewEscalatedSchema,
  [DomainEventType.ACCESS_REVIEW_MEMBERSHIP_REVOKED]: accessReviewMembershipRevokedSchema,
  [DomainEventType.ACCESS_REVIEW_EXCLUSION_CREATED]: accessReviewExclusionCreatedSchema,
  [DomainEventType.ACCESS_REVIEW_EXCLUSION_LIFTED]: accessReviewExclusionLiftedSchema,
  [DomainEventType.ADMIN_ACCOUNT_CREATED]: adminAccountCreatedSchema,
  [DomainEventType.ADMIN_ACCOUNT_ACTIVATION_PENDING]: adminAccountActivationPendingSchema,
  [DomainEventType.TENANT_IDENTITY_LIMIT_EXCEEDED]: tenantIdentityLimitExceededSchema,
};
