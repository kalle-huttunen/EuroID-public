/**
 * GDPR page labels and the rules the backend applies (consent.service.ts, dsar-export.service.ts,
 * gdpr-erasure.service.ts): what a consent status means, what the export file holds, and what an
 * erasure deletes and what it leaves.
 */
import type { IdentityOption } from '@api/identity-api';
import type {
  ConsentStatus,
  ErasureCollection,
  IConsent,
  IDsarExportSummary,
} from '../../interfaces';

export const CONSENT_STATUS_LABEL: Record<ConsentStatus, string> = {
  granted: 'Granted',
  revoked: 'Revoked',
  expired: 'Expired',
};

/** Ant Design Tag preset per status (theme-driven, no raw colors). */
export const CONSENT_STATUS_TAG: Record<ConsentStatus, string> = {
  granted: 'success',
  revoked: 'default',
  expired: 'warning',
};

/** Suggestions only: the API stores any text as the method. */
export const CONSENT_METHODS = ['web-form', 'email', 'contract', 'api'];

/**
 * A granted consent past its expiry date. The API marks such a record `expired` when it lists
 * the consents, so this shows only for one whose expiry passed after the list loaded.
 */
export const isPastExpiry = (consent: IConsent, now: Date) =>
  consent.status === 'granted' && !!consent.expiresAt && new Date(consent.expiresAt) < now;

/** How the picker and the confirmations name a person: name and work email, else the id. */
export const identityLabel = (identity: IdentityOption) =>
  identity.email && identity.displayName && identity.displayName !== identity.email
    ? `${identity.displayName} (${identity.email})`
    : identity.displayName || identity.email || identity.id;

/** A picker option: the person, marked when offboarded. */
export const pickerLabel = (identity: IdentityOption) =>
  identity.offboarded ? `${identityLabel(identity)}, offboarded` : identityLabel(identity);

/** What the operator types to confirm an erasure: the work email, or the id without one. */
export const erasureConfirmText = (identity: IdentityOption) => identity.email || identity.id;

/** The export file's sections with a count, in file order. */
export const EXPORT_COUNT_LABEL: Record<keyof IDsarExportSummary['counts'], string> = {
  timeline: 'Timeline events',
  auditTrail: 'Audit entries filed under the person',
  accessReviews: 'Access review items',
  accessReviewExclusions: 'Access review exclusions',
  entitlements: 'Access the person holds (policy and request grants)',
  consents: 'Consent records',
  records:
    'Other records (credentials metadata, risk, anomalies, joiner, mover and leaver records, drifts, access requests, owned agents, peer groups, policy suggestions)',
  linkedAdminIdentities: 'Linked admin identities (each with the same sections)',
};

/** What the erasure deletes, per collection it counts (gdpr-erasure.service.ts). */
export const ERASURE_ROWS: Array<{ key: ErasureCollection; label: string; note?: string }> = [
  { key: 'identities', label: 'Identity record (Golden Record, sources, provisioning state)' },
  { key: 'user_events', label: 'Timeline events' },
  {
    key: 'audit_events',
    label: 'Audit entries filed under the person',
    note: 'Erasure and dry-run entries are kept and not counted.',
  },
  { key: 'review_items', label: 'Access review items' },
  { key: 'review_exclusions', label: 'Access review exclusions (with reviewer and reason)' },
  {
    key: 'outbox_events',
    label: 'Outbox events',
    note: 'Only published ones are deleted and counted; pending and failed ones stay.',
  },
  { key: 'consents', label: 'Consent records' },
  { key: 'credential_inventory', label: 'Credential inventory (password and MFA state)' },
  { key: 'identity_risk_scores', label: 'Risk scores' },
  { key: 'risk_scores', label: 'Anomaly risk scores' },
  { key: 'anomalies', label: 'Anomalies' },
  { key: 'joiner_events', label: 'Joiner records' },
  { key: 'mover_batch_items', label: 'Mover records (with the changed values)' },
  { key: 'leaver_events', label: 'Leaver records' },
  { key: 'offboarding_records', label: 'Offboarding results' },
  { key: 'upcoming_offboardings', label: 'Upcoming offboarding entry' },
  { key: 'drift_records', label: 'Reconciliation drift findings' },
  {
    key: 'access_requests',
    label: 'Access requests for the person',
    note: 'Requests the person made for someone else, or approved, stay with that person.',
  },
  {
    key: 'agent_identities',
    label: 'Non-human identities the person owns',
    note: 'Kept: the owner email is removed and each gets no new credential until it has a new owner. Give each a new owner or revoke it.',
  },
  { key: 'peer_groups', label: 'Peer groups', note: 'Kept: the person is taken out.' },
  {
    key: 'policy_suggestions',
    label: 'Policy suggestions',
    note: 'Kept: the person is taken out.',
  },
  { key: 'access_graph', label: 'Access graph node (Neo4j)' },
  {
    key: 'elasticsearch_audit_events',
    label: 'Audit search index entries (Elasticsearch)',
    note: 'Erasure entries are kept, as in the audit log.',
  },
];

/**
 * What the erasure leaves in place (besides its own audit entry, which the modal names): the
 * stores outside the rows above (docs: GDPR_COMPLIANCE.md, Cascade Scope).
 */
export const ERASURE_KEPT: string[] = [
  'Accounts in connected systems (Entra ID, AD, Okta and the others): offboard the person first.',
  "Other people's records that name the person: requests they made for someone else or approved, reviews they did, the manager field of their reports (HR writes it again).",
  'Audit entries filed under another resource, and entries where the person is the actor.',
  'Short-lived copies that expire on their own: sent emails, webhook deliveries and dead letters (30 to 90 days).',
  'Temporal workflow history and cold-storage audit archives: see the GDPR documentation.',
];

/** What to do about a store the erasure could not reach, per `notReached` entry. */
export const NOT_REACHED_REMEDY: Record<string, string> = {
  access_graph:
    'Access graph (Neo4j): a super-admin runs Resync on the Access explorer page once the graph is connected; it removes the node.',
  elasticsearch_audit_events:
    'Audit search index (Elasticsearch): rebuild the index from the audit log once the API is connected to it.',
};

export const LEGAL_HOLD_NOTE =
  'EuroID has no legal hold: nothing here checks one. Make sure no hold or retention duty covers this person before you erase.';
