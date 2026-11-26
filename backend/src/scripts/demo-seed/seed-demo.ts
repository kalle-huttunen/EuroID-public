/**
 * Fills one tenant with the demo company: identities and everything the pages show about them.
 * Runs once per tenant: a second run finds the seeded identities and writes nothing; `reset`
 * removes what the seed wrote (reset.ts) and seeds again.
 */
import type { Connection } from 'mongoose';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { startOfUtcDay } from './random';
import { planPeople } from './people';
import type { SeedContext } from './context';
import { demoModels, type DemoCollection, type DemoModels } from './models';
import { removeDemoData, type DemoCounts } from './reset';
import { buildIdentities } from './identities';
import { buildCatalog } from './catalog';
import { buildPolicies, buildSodPolicies } from './policies';
import { buildTimeline } from './timeline';
import {
  buildAnomalies,
  buildAnomalyRiskScores,
  buildDrifts,
  buildIdentityRiskScores,
} from './signals';
import { buildAccessRequests } from './requests';
import { buildReviews } from './reviews';
import { buildDeadLetters, buildDeliveryAttempts, buildSubscriptions } from './operations';
import { buildBatches } from './batches';

export const DEFAULT_DEMO_COUNT = 200;

export interface DemoSeedOptions {
  tenantId: string;
  /** Identities the identity hub lists (offboarded ones come on top). */
  count?: number;
  reset?: boolean;
  /** The run's time; seeded dates count from midnight UTC of its day. */
  now?: Date;
}

export interface DemoSeedResult {
  /** False when the tenant already had the seed and `reset` was not asked for. */
  seeded: boolean;
  removed?: DemoCounts;
  inserted: DemoCounts;
}

/** Every document the seed writes, per collection, in the order they are inserted. */
export function buildDemoData(
  ctx: SeedContext,
): Partial<Record<DemoCollection, Record<string, unknown>[]>> {
  const { docs: identities, plan } = buildIdentities(ctx);
  const reviews = buildReviews(ctx);
  const batches = buildBatches(ctx, identities);
  return {
    catalog: buildCatalog(ctx),
    policies: buildPolicies(ctx),
    sodPolicies: buildSodPolicies(ctx),
    identities,
    userEvents: [...buildTimeline(ctx, plan), ...reviews.timeline].map((e) => ({
      ...e,
      tenantId: ctx.tenantId,
    })),
    drifts: buildDrifts(ctx),
    anomalies: buildAnomalies(ctx),
    anomalyRiskScores: buildAnomalyRiskScores(ctx),
    riskScores: buildIdentityRiskScores(ctx),
    accessRequests: buildAccessRequests(ctx),
    campaigns: reviews.campaigns,
    reviewItems: reviews.items,
    subscriptions: buildSubscriptions(ctx),
    deliveryAttempts: buildDeliveryAttempts(ctx),
    deadLetters: buildDeadLetters(ctx),
    ...batches,
  };
}

/** A live identity outside the seed with one of the seed's addresses would stop the insert midway. */
async function assertAddressesFree(
  models: DemoModels,
  ctx: SeedContext,
  emails: string[],
): Promise<void> {
  const taken = await models.identities.countDocuments({
    tenantId: ctx.tenantId,
    'profile.email': { $in: emails },
    deletedAt: null,
    'metadata.demoSeed': { $ne: true },
  });
  if (taken > 0) {
    throw new Error(
      `${taken} live identities of tenant ${ctx.tenantId} already use addresses of the demo seed ` +
        '(demo.example.com). Remove or rename them, then run the seed again.',
    );
  }
}

export async function seedDemoData(
  connection: Connection,
  options: DemoSeedOptions,
): Promise<DemoSeedResult> {
  const { tenantId, count = DEFAULT_DEMO_COUNT, reset = false, now = new Date() } = options;
  const anchor = startOfUtcDay(now);
  const ctx: SeedContext = { tenantId, anchor, people: planPeople(count, anchor) };
  const models = demoModels(connection);
  return withTenantContext(
    tenantId,
    async () => {
      const removed = reset ? await removeDemoData(models, tenantId) : undefined;
      if (!reset && (await models.identities.exists({ tenantId, 'metadata.demoSeed': true }))) {
        return { seeded: false, inserted: {} };
      }
      await assertAddressesFree(
        models,
        ctx,
        ctx.people.map((p) => p.email),
      );
      const inserted: DemoCounts = {};
      for (const [key, docs] of Object.entries(buildDemoData(ctx)) as Array<
        [DemoCollection, Record<string, unknown>[]]
      >) {
        if (!docs.length) continue;
        inserted[key] = (await models[key].insertMany(docs, { ordered: true })).length;
      }
      return { seeded: true, removed, inserted };
    },
    { actor: 'demo-seed' },
  );
}
