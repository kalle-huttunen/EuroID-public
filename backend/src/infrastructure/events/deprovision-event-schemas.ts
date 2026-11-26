/**
 * provisioning.deprovisioned: its payload and schema, merged into EVENT_SCHEMAS
 * (event-payload-schemas.ts). A connector's deprovision activity emits it once the target removed
 * (deleted, disabled or deactivated) an account: Entra ID (deleteUser: offboarding, entitlement
 * expiry, access review, orphan cleanup, bulk delete), AD, Okta, SCIM, GitHub and ServiceNow.
 * An account that was already gone emits nothing.
 *
 * Ids only: no email, name or UPN, and no AD DN (it holds the person's name). Under the identity's
 * id when the caller named the identity, else under the connector (orphan cleanup and bulk delete
 * remove accounts of no identity).
 *
 * The audit log records it (AuditEventHandler listens to every event). No timeline handler listens:
 * offboarding, entitlement expiry and access review write their own timeline entry for the same
 * removal.
 */
import { z } from 'zod';
import { DomainEventType } from './event-types';

export interface ProvisioningDeprovisionedPayload {
  identityId?: string;
  connector: string;
  /** The account's id in the target (eventAccountId: never an email or UPN); absent for AD. */
  targetUserId?: string;
  /** What the target did (DeprovisionResult.detail): "deleted", "disabled", "deactivated", ... */
  detail?: string;
}

const provisioningDeprovisionedSchema = z.object({
  identityId: z.string().optional(),
  connector: z.string(),
  targetUserId: z.string().optional(),
  detail: z.string().optional(),
});

export const DEPROVISION_EVENT_SCHEMAS: Partial<Record<DomainEventType, z.ZodSchema>> = {
  [DomainEventType.PROVISIONING_DEPROVISIONED]: provisioningDeprovisionedSchema,
};
