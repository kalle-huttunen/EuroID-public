/**
 * The MongoDB collections a GDPR erasure reaches besides the ones GdprErasureService handles
 * itself (identities, user_events, audit_events, review_items, review_exclusions, event_outbox).
 * Each holds documents about one identity, found by its id in the identity's tenant.
 *
 * - Deleted: the documents are about the person (consent, credentials, risk, anomalies, joiner,
 *   mover and leaver records, drift findings, access requests for them).
 * - Redacted: the document belongs to something else that stays (an NHI agent the person owns, a
 *   peer group, a policy suggestion); `redact` takes the person out of it.
 *
 * What stays out of reach, and why, is listed in docs/GDPR_COMPLIANCE.md (Cascade Scope).
 */
import type { Connection, Model, Schema } from 'mongoose';
import {
  accessRequestView,
  agentView,
  ownFields,
  peerGroupView,
  pickedFields,
  type DsarView,
} from './dsar-scope-views';
import { Consent, ConsentSchema } from './schemas/consent.schema';
import {
  CredentialInventory,
  CredentialInventorySchema,
} from '../credential-lifecycle/schemas/credential-inventory.schema';
import { IdentityRiskScore, RiskScoreSchema } from '../risk-scoring/schemas/risk-score.schema';
import {
  RiskScore,
  RiskScoreSchema as AnomalyRiskScoreSchema,
} from '../anomaly/schemas/risk-score.schema';
import { Anomaly, AnomalySchema } from '../anomaly/schemas/anomaly.schema';
import { JoinerEvent, JoinerEventSchema } from '../joiners/schemas/joiner-event.schema';
import { LeaverEvent, LeaverEventSchema } from '../leavers/schemas/leaver-event.schema';
import {
  OffboardingRecord,
  OffboardingRecordSchema,
} from '../leavers/schemas/offboarding-record.schema';
import { MoverBatchItem, MoverBatchItemSchema } from '../mover/schemas/mover-batch-item.schema';
import {
  UpcomingOffboarding,
  UpcomingOffboardingSchema,
} from '../analytics/schemas/upcoming-offboarding.schema';
import { Drift, DriftSchema } from '../reconciliation/schemas/drift.schema';
import {
  AccessRequest,
  AccessRequestSchema,
} from '../access-requests/schemas/access-request.schema';
import { AgentIdentity, AgentIdentitySchema } from '../nhi/schemas/agent-identity.schema';
import { PeerGroup, PeerGroupSchema } from '../intelligence/schemas/peer-group.schema';
import {
  PolicySuggestion,
  PolicySuggestionSchema,
} from '../policy-suggestions/schemas/suggestion.schema';

type Filter = Record<string, unknown>;

export interface ErasureTarget {
  /** The collection, as the attestation's documentCounts names it. */
  collection: string;
  /** The Mongoose model name and schema (the owning module registers the same pair). */
  model: string;
  schema: Schema;
  /** The person's documents in the tenant. */
  filter: (tenantId: string, identityId: string) => Filter;
  /**
   * Set when the documents stay: the update that takes the person out of them (an update
   * document, or a pipeline).
   */
  redact?: (identityId: string) => Filter | Filter[];
  /**
   * What the DSAR export (Art. 15) gives of each of the person's documents here
   * (dsar-scope-views.ts), so the export covers exactly what the erasure reaches; `consents`: the
   * export's own `consents` field gives them (ConsentService, expiry marked as of the export).
   */
  dsar: DsarView | 'consents';
}

/** The target's model: the one its module registered, or compiled from its schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the targets are different models
export function scopeModel(connection: Connection, target: ErasureTarget): Model<any> {
  return connection.models[target.model] ?? connection.model(target.model, target.schema);
}

/**
 * What an NHI agent's owner email becomes: the agent stays, its owner id points nowhere, and it is
 * marked ownerless (no new credential until a super-admin gives it a new owner or revokes it).
 */
export const ERASED_OWNER_EMAIL = '(erased)';

/**
 * A pipeline expression: `field` replaced by ERASED_OWNER_EMAIL when it is the agent owner's email
 * (in any case), else as it is (missing stays missing).
 */
function erasedWhenOwner(field: string): Filter {
  return {
    $cond: [
      {
        $and: [
          { $eq: [{ $type: field }, 'string'] },
          { $eq: [{ $toLower: field }, { $toLower: { $ifNull: ['$owner.email', ''] } }] },
        ],
      },
      ERASED_OWNER_EMAIL,
      field,
    ],
  };
}

const byField =
  (field: string) =>
  (tenantId: string, identityId: string): Filter => ({ tenantId, [field]: identityId });

const deleted = (
  collection: string,
  model: string,
  schema: Schema,
  dsar: ErasureTarget['dsar'],
  field = 'identityId',
): ErasureTarget => ({ collection, model, schema, filter: byField(field), dsar });

// Who decided a batch, acknowledged or dismissed an anomaly, or decided an orphan is another
// person: the export leaves those fields out
export const ERASURE_TARGETS: ErasureTarget[] = [
  deleted('consents', Consent.name, ConsentSchema, 'consents'),
  deleted('credential_inventory', CredentialInventory.name, CredentialInventorySchema, ownFields()),
  deleted('identity_risk_scores', IdentityRiskScore.name, RiskScoreSchema, ownFields()),
  deleted('risk_scores', RiskScore.name, AnomalyRiskScoreSchema, ownFields()),
  deleted(
    'anomalies',
    Anomaly.name,
    AnomalySchema,
    ownFields('acknowledgedBy', 'resolvedBy', 'evidence.details.actors'),
  ),
  deleted('joiner_events', JoinerEvent.name, JoinerEventSchema, ownFields('decidedBy')),
  deleted('leaver_events', LeaverEvent.name, LeaverEventSchema, ownFields('decidedBy')),
  deleted('offboarding_records', OffboardingRecord.name, OffboardingRecordSchema, ownFields()),
  deleted('mover_batch_items', MoverBatchItem.name, MoverBatchItemSchema, ownFields('decidedBy')),
  deleted(
    'upcoming_offboardings',
    UpcomingOffboarding.name,
    UpcomingOffboardingSchema,
    ownFields(),
  ),
  // A drift of the person's accounts names them (userEmail, userDisplayName)
  deleted('drift_records', Drift.name, DriftSchema, ownFields('orphanDetails.decidedBy'), 'userId'),
  {
    // Requests for the person: for them (targetIdentityId), or their own (no target). Requests
    // they made for someone else or approved are that person's records and stay.
    collection: 'access_requests',
    model: AccessRequest.name,
    schema: AccessRequestSchema,
    filter: (tenantId, identityId) => ({
      tenantId,
      $or: [
        { targetIdentityId: identityId },
        { requesterId: identityId, targetIdentityId: { $in: [null, ''] } },
      ],
    }),
    dsar: accessRequestView,
  },
  {
    collection: 'agent_identities',
    model: AgentIdentity.name,
    schema: AgentIdentitySchema,
    filter: byField('owner.identityId'),
    // A pipeline, so an agent already ownerless (its owner offboarded first, or marked by
    // NhiOwnershipService.markOwnerless just before, with its audit entry and nhi.owner_lost)
    // keeps its date; a revoked agent gets the mark here without them
    // Who created or revoked the agent (NhiService records the acting admin's email) is the
    // person too when it is the owner's email, an admin who made an agent for themselves: taken
    // out with it (all expressions of one $set read the document as it was)
    redact: () => [
      {
        $set: {
          'owner.email': ERASED_OWNER_EMAIL,
          createdBy: erasedWhenOwner('$createdBy'),
          revokedBy: erasedWhenOwner('$revokedBy'),
          ownerlessReason: 'erased',
          ownerlessSince: { $ifNull: ['$ownerlessSince', '$$NOW'] },
        },
      },
    ],
    dsar: agentView,
  },
  {
    collection: 'peer_groups',
    model: PeerGroup.name,
    schema: PeerGroupSchema,
    filter: (tenantId, identityId) => ({
      tenantId,
      $or: [{ memberIds: identityId }, { 'outliers.identityId': identityId }],
    }),
    redact: (identityId) => ({ $pull: { memberIds: identityId, outliers: { identityId } } }),
    dsar: peerGroupView,
  },
  {
    collection: 'policy_suggestions',
    model: PolicySuggestion.name,
    schema: PolicySuggestionSchema,
    filter: byField('evidence.sampleUserIds'),
    redact: (identityId) => ({ $pull: { 'evidence.sampleUserIds': identityId } }),
    // That the subject is in the suggestion's sample: which suggestion, not the others in it
    dsar: pickedFields('suggestionId', 'type', 'title', 'status', 'createdAt'),
  },
];
