/**
 * Types for the Identity 360 page (IdentityDetailPage) and its tabs.
 * Augments the generated StandardUserDto with backend-returned fields
 * not yet in the Swagger spec (metadata, Refine's `id` alias).
 */

import type { IStandardUser } from '../../../interfaces';

/** Snapshot of an identity record used in conflict side-by-side comparison */
export interface IdentitySnapshot {
  sourceName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  departmentName?: string;
  jobTitle?: string;
}

/** Conflict details returned by the correlation engine */
export interface CorrelationConflictDetails {
  matchedBy: string;
  matchedValue?: string;
  confidence?: number;
  existingSnapshot?: IdentitySnapshot;
  incomingSnapshot?: IdentitySnapshot;
}

/** Identity metadata — fields added by the backend but not in the Swagger spec */
export interface IdentityMetadata {
  requiresReview?: boolean;
  correlationConflict?: boolean;
  conflictDetails?: CorrelationConflictDetails;
  correlationStatus?: string;
}

/** Extended user type with backend-added fields not in the generated DTO */
export interface IStandardUserWithMeta extends IStandardUser {
  id?: string; // Refine data provider alias for _id
  metadata?: IdentityMetadata;
}

/** Drift map entry for a single field */
export interface DriftMapEntry {
  actualValue?: string;
  connector?: string;
  driftId?: string;
  autoCorrectEligible?: boolean;
}

/** Resolves an identity ID from the various shapes the user object may have */
export function resolveIdentityId(
  user: IStandardUserWithMeta | null | undefined,
): string | undefined {
  return user?._id?.toString?.() || user?.id || user?.email;
}
