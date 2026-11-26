/**
 * The app's Mongoose models the demo seed writes through (schemas, defaults, enums, the tenant
 * plugin), registered on a connection under the names the app's modules give them.
 */
import type { Connection, Model, Schema } from 'mongoose';
import { Identity, IdentitySchema } from '@modules/identity/schemas/identity.schema';
import { UserEvent, UserEventSchema } from '@modules/identity/schemas/user-event.schema';
import {
  EntitlementCatalog,
  EntitlementCatalogSchema,
} from '@modules/entitlement-catalog/schemas/entitlement-catalog.schema';
import { Policy, PolicySchema } from '@modules/policy/schemas/policy.schema';
import { SodPolicy, SodPolicySchema } from '@modules/policy/schemas/sod-policy.schema';
import { Drift, DriftSchema } from '@modules/reconciliation/schemas/drift.schema';
import { Anomaly, AnomalySchema } from '@modules/anomaly/schemas/anomaly.schema';
import { RiskScore, RiskScoreSchema } from '@modules/anomaly/schemas/risk-score.schema';
import {
  IdentityRiskScore,
  RiskScoreSchema as IdentityRiskScoreSchema,
} from '@modules/risk-scoring/schemas/risk-score.schema';
import {
  AccessRequest,
  AccessRequestSchema,
} from '@modules/access-requests/schemas/access-request.schema';
import {
  ReviewCampaign,
  ReviewCampaignSchema,
} from '@modules/access-review/schemas/review-campaign.schema';
import { ReviewItem, ReviewItemSchema } from '@modules/access-review/schemas/review-item.schema';
import {
  EventSubscription,
  EventSubscriptionSchema,
} from '@modules/event-subscriptions/schemas/event-subscription.schema';
import {
  DeliveryAttempt,
  DeliveryAttemptSchema,
} from '@modules/event-subscriptions/schemas/delivery-attempt.schema';
import {
  DeadLetterEntry,
  DeadLetterEntrySchema,
} from '@modules/dead-letter/schemas/dead-letter.schema';
import { JoinerBatch, JoinerBatchSchema } from '@modules/joiners/schemas/joiner-batch.schema';
import { JoinerEvent, JoinerEventSchema } from '@modules/joiners/schemas/joiner-event.schema';
import { LeaverBatch, LeaverBatchSchema } from '@modules/leavers/schemas/leaver-batch.schema';
import { LeaverEvent, LeaverEventSchema } from '@modules/leavers/schemas/leaver-event.schema';
import { MoverBatch, MoverBatchSchema } from '@modules/mover/schemas/mover-batch.schema';
import {
  MoverBatchItem,
  MoverBatchItemSchema,
} from '@modules/mover/schemas/mover-batch-item.schema';

const SCHEMAS = {
  identities: [Identity.name, IdentitySchema],
  userEvents: [UserEvent.name, UserEventSchema],
  catalog: [EntitlementCatalog.name, EntitlementCatalogSchema],
  policies: [Policy.name, PolicySchema],
  sodPolicies: [SodPolicy.name, SodPolicySchema],
  drifts: [Drift.name, DriftSchema],
  anomalies: [Anomaly.name, AnomalySchema],
  anomalyRiskScores: [RiskScore.name, RiskScoreSchema],
  riskScores: [IdentityRiskScore.name, IdentityRiskScoreSchema],
  accessRequests: [AccessRequest.name, AccessRequestSchema],
  campaigns: [ReviewCampaign.name, ReviewCampaignSchema],
  reviewItems: [ReviewItem.name, ReviewItemSchema],
  subscriptions: [EventSubscription.name, EventSubscriptionSchema],
  deliveryAttempts: [DeliveryAttempt.name, DeliveryAttemptSchema],
  deadLetters: [DeadLetterEntry.name, DeadLetterEntrySchema],
  joinerBatches: [JoinerBatch.name, JoinerBatchSchema],
  joinerEvents: [JoinerEvent.name, JoinerEventSchema],
  leaverBatches: [LeaverBatch.name, LeaverBatchSchema],
  leaverEvents: [LeaverEvent.name, LeaverEventSchema],
  moverBatches: [MoverBatch.name, MoverBatchSchema],
  moverItems: [MoverBatchItem.name, MoverBatchItemSchema],
} as const satisfies Record<string, readonly [string, Schema]>;

export type DemoCollection = keyof typeof SCHEMAS;
export type DemoModels = Record<DemoCollection, Model<Record<string, unknown>>>;

/**
 * The models on `connection`, reusing one the connection already has. Register the tenant plugin
 * (mongoose.plugin(tenantPlugin)) before the first call: plugins apply when a model compiles.
 */
export function demoModels(connection: Connection): DemoModels {
  const out = {} as DemoModels;
  for (const [key, [name, schema]] of Object.entries(SCHEMAS)) {
    out[key as DemoCollection] = (connection.models[name] ??
      connection.model(name, schema)) as unknown as Model<Record<string, unknown>>;
  }
  return out;
}
