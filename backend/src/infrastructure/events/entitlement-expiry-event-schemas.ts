/**
 * Payload schemas of the time-bound access events (entitlement expiry), merged into EVENT_SCHEMAS
 * (event-payload-schemas.ts). Ids, the target system and dates only: no email since plan 2.0dn.
 * Interfaces: event-payloads.ts.
 */
import { z } from 'zod';
import { DomainEventType } from './event-types';

// entitlement.expiring_soon / _tomorrow (EntitlementExpiringPayload): no email since plan 2.0dn
const entitlementExpiringSchema = z.object({
  identityId: z.string(),
  targetSystem: z.string(),
  // The stored Date; an ISO string once the event went through JSON (dead-letter retry)
  expiresAt: z.union([z.date(), z.string()]),
});

const entitlementExpiredSchema = entitlementExpiringSchema.extend({
  outcome: z.enum(['deprovisioned', 'already-gone', 'not-applicable']).optional(),
  detail: z.string().optional(),
});

const entitlementExpiryFailedSchema = z.object({
  identityId: z.string(),
  targetSystem: z.string(),
  expiresAt: z.string(),
  reason: z.string(),
  retryable: z.boolean(),
  attempts: z.number().int().positive(),
  nextAttemptAt: z.string().optional(),
});

const entitlementExpiryRetryRequestedSchema = z.object({
  identityId: z.string(),
  targetSystem: z.string(),
  expiresAt: z.string(),
  failureReason: z.string(),
});

const entitlementExpiryRemovedManuallySchema = entitlementExpiryRetryRequestedSchema.extend({
  reason: z.string(),
});

export const ENTITLEMENT_EXPIRY_EVENT_SCHEMAS: Partial<Record<DomainEventType, z.ZodSchema>> = {
  [DomainEventType.ENTITLEMENT_EXPIRING_SOON]: entitlementExpiringSchema,
  [DomainEventType.ENTITLEMENT_EXPIRING_TOMORROW]: entitlementExpiringSchema,
  [DomainEventType.ENTITLEMENT_EXPIRED]: entitlementExpiredSchema,
  [DomainEventType.ENTITLEMENT_EXPIRY_FAILED]: entitlementExpiryFailedSchema,
  [DomainEventType.ENTITLEMENT_EXPIRY_RETRY_REQUESTED]: entitlementExpiryRetryRequestedSchema,
  [DomainEventType.ENTITLEMENT_EXPIRY_REMOVED_MANUALLY]: entitlementExpiryRemovedManuallySchema,
};
