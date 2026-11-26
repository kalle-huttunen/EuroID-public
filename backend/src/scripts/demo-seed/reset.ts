/**
 * Removes what the demo seed wrote in one tenant, and nothing else. Root documents carry the seed's
 * marker (metadata.demoSeed, createdBy or workflowId 'demo-seed', a 'demo-seed:' correlation id);
 * the rest are found through them: the per-identity records of the seeded identities (timeline,
 * drifts, anomalies, risk scores, joiner, leaver and mover events with their batches), a seeded
 * campaign's items, a seeded subscription's deliveries, and SoD policies naming only seeded
 * catalog entries. Records of other processes (another campaign's items, a request an admin made)
 * are left alone, also when they are about a seeded identity.
 */
import { DEMO_SEED_MARKER } from './context';
import type { DemoCollection, DemoModels } from './models';

export type DemoCounts = Partial<Record<DemoCollection, number>>;

const MARKED = `^${DEMO_SEED_MARKER}:`;

async function values(
  models: DemoModels,
  key: DemoCollection,
  filter: Record<string, unknown>,
  field: string,
): Promise<string[]> {
  const docs = await models[key].find(filter).select(field).lean().exec();
  return docs.map((d) => String((d as Record<string, unknown>)[field]));
}

export async function removeDemoData(models: DemoModels, tenantId: string): Promise<DemoCounts> {
  const marked = { tenantId, 'metadata.demoSeed': true };
  const ids = await values(models, 'identities', marked, '_id');
  const campaignIds = await values(
    models,
    'campaigns',
    { tenantId, createdBy: DEMO_SEED_MARKER },
    'campaignId',
  );
  const subscriptionIds = await values(
    models,
    'subscriptions',
    { tenantId, createdBy: DEMO_SEED_MARKER },
    '_id',
  );
  const nativeIds = await values(models, 'catalog', marked, 'nativeId');
  const ofIdentities = { tenantId, identityId: { $in: ids } };
  const batchIds = async (key: DemoCollection) =>
    (await values(models, key, { ...ofIdentities, batchId: { $exists: true } }, 'batchId')).filter(
      (id) => id !== 'undefined',
    );
  const joinerBatches = await batchIds('joinerEvents');
  const leaverBatches = await batchIds('leaverEvents');
  const moverBatches = await batchIds('moverItems');

  const filters: Record<DemoCollection, Record<string, unknown>> = {
    userEvents: { tenantId, $or: [{ 'metadata.demoSeed': true }, { userId: { $in: ids } }] },
    drifts: { tenantId, $or: [{ workflowId: DEMO_SEED_MARKER }, { userId: { $in: ids } }] },
    anomalies: { tenantId, $or: [{ 'metadata.demoSeed': true }, { identityId: { $in: ids } }] },
    anomalyRiskScores: ofIdentities,
    riskScores: ofIdentities,
    accessRequests: { tenantId, workflowId: { $regex: MARKED } },
    reviewItems: { tenantId, campaignId: { $in: campaignIds } },
    campaigns: { tenantId, createdBy: DEMO_SEED_MARKER },
    deliveryAttempts: { tenantId, subscriptionId: { $in: subscriptionIds } },
    subscriptions: { tenantId, createdBy: DEMO_SEED_MARKER },
    deadLetters: { tenantId, correlationId: { $regex: MARKED } },
    joinerEvents: ofIdentities,
    joinerBatches: { tenantId, _id: { $in: joinerBatches } },
    leaverEvents: ofIdentities,
    leaverBatches: { tenantId, _id: { $in: leaverBatches } },
    moverItems: ofIdentities,
    moverBatches: { tenantId, _id: { $in: moverBatches } },
    sodPolicies: {
      tenantId,
      'conflictingEntitlements.0': { $exists: true },
      conflictingEntitlements: { $not: { $elemMatch: { targetId: { $nin: nativeIds } } } },
    },
    policies: { tenantId, createdBy: DEMO_SEED_MARKER },
    catalog: marked,
    identities: marked,
  };
  const removed: DemoCounts = {};
  for (const [key, filter] of Object.entries(filters) as Array<
    [DemoCollection, Record<string, unknown>]
  >) {
    removed[key] = (await models[key].deleteMany(filter).exec()).deletedCount;
  }
  return removed;
}
