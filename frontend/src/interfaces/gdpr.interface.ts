/**
 * GDPR requests (backend modules/compliance-reporting, GdprComplianceController, mounted under
 * /identity): consent records (Article 6), the data subject access export (Articles 15 and 20)
 * and erasure (Article 17). Every route takes the identity's `_id` (ObjectId). The generated types
 * carry no response bodies for these routes, so the shapes follow the services.
 */

/** Nothing in the backend sets `expired`: a consent past its `expiresAt` stays `granted`. */
export type ConsentStatus = 'granted' | 'revoked' | 'expired';

/** One consent record, as GET /identity/:id/consent lists it (one per purpose). */
export interface IConsent {
  _id: string;
  identityId: string;
  /** Free text, e.g. data_processing, analytics, marketing. */
  purpose: string;
  status: ConsentStatus;
  /** ISO, the last grant. */
  grantedAt?: string;
  /** ISO, set by a revoke; a later grant clears it. */
  revokedAt?: string;
  /** Who recorded the last grant (the admin's email from the JWT). */
  grantedBy: string;
  /** How consent was collected (free text: web-form, api, email, contract). */
  method?: string;
  /** ISO. Nothing acts on it: the consent stays granted after this date. */
  expiresAt?: string;
  tenantId: string;
  createdAt?: string;
  updatedAt?: string;
}

/** POST /identity/:id/consent body: grants (or grants again) one purpose. */
export interface IConsentGrant {
  purpose: string;
  method?: string;
  /** ISO date-time. */
  expiresAt?: string;
}

/** GET /identity/compliance/consent-report: consent records of the tenant per purpose. */
export interface IConsentReport {
  tenantId: string;
  /** Distinct identities with at least one consent record, not all identities. */
  totalIdentities: number;
  byPurpose: Array<{ purpose: string; granted: number; revoked: number; expired: number }>;
}

/** The collections and stores the erasure counts, in the attestation's `documentCounts`. */
export type ErasureCollection =
  | 'identities'
  | 'user_events'
  | 'audit_events'
  | 'review_items'
  | 'review_exclusions'
  | 'outbox_events'
  | 'consents'
  | 'credential_inventory'
  | 'identity_risk_scores'
  | 'risk_scores'
  | 'anomalies'
  | 'joiner_events'
  | 'leaver_events'
  | 'offboarding_records'
  | 'mover_batch_items'
  | 'upcoming_offboardings'
  | 'drift_records'
  | 'access_requests'
  | 'agent_identities'
  | 'peer_groups'
  | 'policy_suggestions'
  | 'access_graph'
  | 'elasticsearch_audit_events';

/** DELETE /identity/:id/gdpr-erase (with `?dryRun=true`: what would be erased, nothing deleted). */
export interface IErasureAttestation {
  /** ISO */
  erasedAt: string;
  /** The super-admin's email from the JWT, or `unknown`. */
  erasedBy: string;
  identityId: string;
  /** The collections with a count above zero. */
  collectionsAffected: string[];
  /** Counted before the delete (the access graph and the index: what was deleted). */
  documentCounts: Partial<Record<ErasureCollection, number>>;
  dryRun: boolean;
  /** Stores the erasure could not reach, which may still hold the person; empty when none. */
  notReached: string[];
  /** The person's linked admin identities, erased with them (counted on a dry run). */
  linkedAdminIdentities?: ILinkedAdminErasure[];
}

/** A linked admin identity in the erasure attestation, with its own counts. */
export interface ILinkedAdminErasure {
  identityId: string;
  adminTier?: string;
  collectionsAffected: string[];
  documentCounts: Partial<Record<ErasureCollection, number>>;
  notReached: string[];
}

/**
 * GET /identity/:id/dsar-export: everything the export reads about one identity, unmasked (it is
 * the person's own data). The page saves it as a file and keeps only the counts.
 */
export interface IDsarExportPackage {
  exportedAt: string;
  exportedBy: string;
  dataSubjectId: string;
  identity: Record<string, unknown>;
  timeline: Record<string, unknown>[];
  auditTrail: Record<string, unknown>[];
  accessReviews: Record<string, unknown>[];
  accessReviewExclusions: Record<string, unknown>[];
  /** The access the person holds, as the identity page lists it (policy and request grants). */
  entitlements: Record<string, unknown>[];
  /** The person's consent per purpose, with its status at the export. */
  consents: IDsarConsent[];
  /**
   * The person's records in every other collection a GDPR erasure reaches, keyed by collection
   * (credential metadata, risk, anomalies, joiner, mover and leaver records, drifts, access
   * requests, owned agents, peer groups, policy suggestions); other people's data left out.
   */
  records?: Record<string, Record<string, unknown>[]>;
  /** The person's linked admin identities, each with its document and the same sections. */
  linkedAdminIdentities?: Array<Record<string, unknown>>;
  attestation: string;
}

/** A consent record in the export (dates as ISO strings). */
export interface IDsarConsent {
  purpose: string;
  status: string;
  grantedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  method?: string;
}

/** What the page shows after an export: the file name and the record counts, no personal data. */
export interface IDsarExportSummary {
  fileName: string;
  exportedAt: string;
  exportedBy: string;
  counts: {
    timeline: number;
    auditTrail: number;
    accessReviews: number;
    accessReviewExclusions: number;
    entitlements: number;
    consents: number;
    /** Records in the erasure scope's other collections, all collections together. */
    records: number;
    linkedAdminIdentities: number;
  };
}
