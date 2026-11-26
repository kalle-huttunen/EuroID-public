/**
 * Items as the Leavers page lists them. Leaver events: who (name and email from the identity),
 * why, since when, what became of them and the offboarding's per-system result. Failed
 * offboardings: the result of any offboarding with a failed target, with the leaver event that
 * started it when there is one. Results come from offboarding_records, by workflow id.
 */
import { isValidObjectId, Model } from 'mongoose';
import type { LeaverReason } from '@infrastructure/events/event-payloads';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import type {
  LeaverEvent,
  LeaverEventDocument,
  LeaverEventStatus,
} from './schemas/leaver-event.schema';
import type {
  OffboardingRecord,
  OffboardingRecordDocument,
  StoredOffboardingResult,
} from './schemas/offboarding-record.schema';

export interface LeaverBatchItem {
  leaverEventId: string;
  identityId: string;
  displayName: string;
  email?: string;
  reason: LeaverReason;
  effectiveDate?: Date;
  status: LeaverEventStatus;
  workflowId?: string;
  closeReason?: string;
  /** Why its offboarding could not start (it stays queued; the next sync tries again). */
  startError?: string;
  /** Per-system result of the started offboarding, once it finished or stopped. */
  offboarding?: StoredOffboardingResult;
}

/** An offboarding that left a target or a linked admin account failed, whatever started it. */
export interface FailedOffboardingItem {
  workflowId: string;
  identityId: string;
  displayName: string;
  email?: string;
  /** The HR leaver event that started it; absent for DELETE /identity/:id. */
  leaver?: {
    leaverEventId: string;
    sourceName: string;
    reason: LeaverReason;
    effectiveDate?: Date;
  };
  offboarding: StoredOffboardingResult;
}

export type StoredLeaverEvent = LeaverEvent & { _id: unknown };
export type StoredRecord = OffboardingRecord & { _id: unknown };

export type IdentityName = { displayName: string; email?: string };

/**
 * Display name and email of each identity (falls back to the id when none is found). Also used by
 * the HR mover batches (modules/mover/hr-mover-batch.service.ts).
 */
export async function identityNames(
  identityModel: Model<IdentityDocument>,
  tenantId: string,
  identityIds: string[],
): Promise<Map<string, IdentityName>> {
  const docs = (await identityModel
    .find({ tenantId, _id: { $in: identityIds.filter((id) => isValidObjectId(id)) } })
    .select('profile.firstName profile.lastName profile.displayName profile.email')
    .lean()
    .exec()) as Array<{
    _id: unknown;
    profile?: { firstName?: string; lastName?: string; displayName?: string; email?: string };
  }>;
  return new Map(
    docs.map((d) => [
      String(d._id),
      {
        displayName:
          d.profile?.displayName ||
          [d.profile?.firstName, d.profile?.lastName].filter(Boolean).join(' ') ||
          String(d._id),
        email: d.profile?.email,
      },
    ]),
  );
}

const resultOf = (r: StoredRecord): StoredOffboardingResult => ({
  status: r.status,
  hubStatus: r.hubStatus,
  systems: r.systems,
  ...(r.linkedAdmins?.length ? { linkedAdmins: r.linkedAdmins } : {}),
  finishedAt: r.finishedAt,
});

/** The events as page items, in the order given, each started one with its stored result. */
export async function toLeaverItems(
  identityModel: Model<IdentityDocument>,
  recordModel: Model<OffboardingRecordDocument>,
  tenantId: string,
  events: StoredLeaverEvent[],
): Promise<LeaverBatchItem[]> {
  const workflowIds = events
    .filter((e) => e.status === 'started' && e.workflowId)
    .map((e) => e.workflowId as string);
  const [names, records] = await Promise.all([
    identityNames(
      identityModel,
      tenantId,
      events.map((e) => e.identityId),
    ),
    workflowIds.length
      ? (recordModel
          .find({ tenantId, workflowId: { $in: workflowIds } })
          .lean()
          .exec() as unknown as Promise<StoredRecord[]>)
      : Promise.resolve([] as StoredRecord[]),
  ]);
  const results = new Map(records.map((r) => [r.workflowId, resultOf(r)]));
  return events.map((e) => ({
    leaverEventId: String(e._id),
    identityId: e.identityId,
    displayName: names.get(e.identityId)?.displayName ?? e.identityId,
    email: names.get(e.identityId)?.email,
    reason: e.reason,
    effectiveDate: e.effectiveDate,
    status: e.status,
    workflowId: e.workflowId,
    closeReason: e.closeReason,
    startError: e.startError,
    offboarding: e.status === 'started' && e.workflowId ? results.get(e.workflowId) : undefined,
  }));
}

/**
 * The records as Failed offboardings items, in the order given, each with the newest started
 * leaver event of its workflow when there is one.
 */
export async function toFailedOffboardingItems(
  identityModel: Model<IdentityDocument>,
  eventModel: Model<LeaverEventDocument>,
  tenantId: string,
  records: StoredRecord[],
): Promise<FailedOffboardingItem[]> {
  const [names, events] = await Promise.all([
    identityNames(
      identityModel,
      tenantId,
      records.map((r) => r.identityId),
    ),
    eventModel
      .find({ tenantId, status: 'started', workflowId: { $in: records.map((r) => r.workflowId) } })
      .sort({ startedAt: 1 })
      .lean()
      .exec() as unknown as Promise<StoredLeaverEvent[]>,
  ]);
  // Sorted oldest first, so the newest event of a workflow is the one left in the map
  const leaverOf = new Map(events.map((e) => [e.workflowId as string, e]));
  return records.map((r) => {
    const event = leaverOf.get(r.workflowId);
    return {
      workflowId: r.workflowId,
      identityId: r.identityId,
      displayName: names.get(r.identityId)?.displayName ?? r.identityId,
      email: names.get(r.identityId)?.email,
      ...(event
        ? {
            leaver: {
              leaverEventId: String(event._id),
              sourceName: event.sourceName,
              reason: event.reason,
              effectiveDate: event.effectiveDate,
            },
          }
        : {}),
      offboarding: resultOf(r),
    };
  });
}
