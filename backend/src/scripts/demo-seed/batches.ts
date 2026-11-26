/**
 * HR lifecycle batches waiting for an admin: joiners (with the future joiners still waiting for
 * their start date), movers and leavers, as an HR sync over the mass limits leaves them.
 * Approving one starts the real onboarding, mover or offboarding workflows.
 */
import { changeKey, triggerAttributeChanges } from '@modules/mover/hr-mover-changes';
import { calendarDay, leaverEventKey } from '@modules/leavers/leaver-signals';
import { toAccessBaseline } from '@shared/utils/access-baseline';
import { daysFrom, seededObjectId } from './random';
import { PRIMARY_HR } from './pools';
import { personId, workingPeople, type SeedContext } from './context';
import type { DemoPerson, Lifecycle } from './people';

/** What a tenant whose mass limits allow two per sync run would see. */
const ALLOWANCE = 2;

export interface BatchDocs {
  joinerBatches: Record<string, unknown>[];
  joinerEvents: Record<string, unknown>[];
  leaverBatches: Record<string, unknown>[];
  leaverEvents: Record<string, unknown>[];
  moverBatches: Record<string, unknown>[];
  moverItems: Record<string, unknown>[];
}

function members(ctx: SeedContext, lifecycle: Lifecycle): DemoPerson[] {
  return ctx.people.filter((p) => p.lifecycle === lifecycle);
}

function batch(ctx: SeedContext, kind: string, count: number, extra: Record<string, unknown>) {
  return {
    _id: seededObjectId(ctx.tenantId, `${kind}-batch`, 0),
    tenantId: ctx.tenantId,
    sourceName: PRIMARY_HR,
    status: 'pending',
    identityCount: count,
    allowance: ALLOWANCE,
    activeIdentityCount: workingPeople(ctx).length,
    ...extra,
    createdAt: daysFrom(ctx.anchor, 0, -5),
  };
}

function joiners(ctx: SeedContext): Pick<BatchDocs, 'joinerBatches' | 'joinerEvents'> {
  const pending = members(ctx, 'joiner-batch');
  const joinerBatch = batch(ctx, 'joiner', pending.length, {});
  const event = (p: DemoPerson, k: number, waiting: boolean) => ({
    _id: seededObjectId(ctx.tenantId, 'joiner-event', k),
    tenantId: ctx.tenantId,
    identityId: personId(ctx, p),
    sourceName: PRIMARY_HR,
    status: waiting ? 'waiting' : 'pending-approval',
    open: true,
    detectedAt: daysFrom(ctx.anchor, waiting ? -4 : 0, waiting ? 3 : -5),
    ...(waiting ? { waitReason: 'start-date' } : { batchId: String(joinerBatch._id) }),
  });
  return {
    joinerBatches: [joinerBatch],
    joinerEvents: [
      ...pending.map((p, k) => event(p, k, false)),
      ...members(ctx, 'future-joiner').map((p, k) => event(p, pending.length + k, true)),
    ],
  };
}

function leavers(ctx: SeedContext): Pick<BatchDocs, 'leaverBatches' | 'leaverEvents'> {
  const pending = members(ctx, 'leaver-batch');
  const leaverBatch = batch(ctx, 'leaver', pending.length, {
    reasonCounts: { 'end-date': pending.length },
  });
  return {
    leaverBatches: [leaverBatch],
    leaverEvents: pending.map((p, k) => {
      const endDate = p.endDate ?? ctx.anchor;
      const signal = {
        reason: 'end-date' as const,
        effectiveDate: endDate,
        evidence: calendarDay(endDate, 'UTC'),
      };
      return {
        _id: seededObjectId(ctx.tenantId, 'leaver-event', k),
        tenantId: ctx.tenantId,
        identityId: personId(ctx, p),
        sourceName: PRIMARY_HR,
        reason: signal.reason,
        eventKey: leaverEventKey(PRIMARY_HR, signal),
        effectiveDate: endDate,
        status: 'pending-approval',
        open: true,
        batchId: String(leaverBatch._id),
        detectedAt: daysFrom(ctx.anchor, 0, -5),
      };
    }),
  };
}

/**
 * The changes are the app's own comparison of the person's access baseline (the department and
 * title before the move, identities.ts) with the profile now.
 */
function movers(
  ctx: SeedContext,
  identities: Map<string, Record<string, unknown>>,
): Pick<BatchDocs, 'moverBatches' | 'moverItems'> {
  const pending = members(ctx, 'mover-batch');
  const items = pending.map((p, k) => {
    const doc = identities.get(personId(ctx, p));
    const baseline = (doc?.accessBaseline as { attributes?: Record<string, unknown> })?.attributes;
    const profile = (doc?.profile ?? {}) as Record<string, unknown>;
    const changes = triggerAttributeChanges(baseline ?? {}, toAccessBaseline(profile));
    return {
      _id: seededObjectId(ctx.tenantId, 'mover-item', k),
      tenantId: ctx.tenantId,
      identityId: personId(ctx, p),
      sourceName: PRIMARY_HR,
      changes,
      changeKey: changeKey(changes),
      status: 'pending-approval',
      open: true,
    };
  });
  const fieldCounts: Record<string, number> = {};
  for (const item of items) {
    for (const change of item.changes)
      fieldCounts[change.field] = (fieldCounts[change.field] ?? 0) + 1;
  }
  const moverBatch = batch(ctx, 'mover', items.length, { fieldCounts });
  return {
    moverBatches: [moverBatch],
    moverItems: items.map((item) => ({ ...item, batchId: String(moverBatch._id) })),
  };
}

export function buildBatches(ctx: SeedContext, identityDocs: Record<string, unknown>[]): BatchDocs {
  const byId = new Map(identityDocs.map((doc) => [String(doc._id), doc]));
  return { ...joiners(ctx), ...leavers(ctx), ...movers(ctx, byId) };
}
