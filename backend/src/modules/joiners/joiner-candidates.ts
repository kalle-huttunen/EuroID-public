/**
 * Joiner rules: pure functions, no I/O. Given what the hub holds about an identity an HR sync
 * minted, decide whether its onboarding is due now, has to wait, or will never come from the
 * joiner path. JoinerExecutionService feeds them one identity at a time.
 */
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { calendarDay, dayIsOver, todayIn } from '../leavers/leaver-signals';

/** The projected identity fields the rules read. */
export interface IdentityForJoiner {
  _id: unknown;
  deletedAt?: Date | null;
  profile?: { email?: string; status?: string };
  provisioning?: Array<{ targetSystem?: string; status?: string; lastSync?: Date | string }>;
  sources?: Array<{
    sourceName: string;
    lastSync?: Date | string;
    rawData?: {
      status?: string;
      startDate?: Date | string;
      endDate?: Date | string;
      /**
       * startDateUnreadable: the HR start date as sent, when it is not a date (the connector left
       * `startDate` out; hr/hr-lifecycle-fields.ts).
       */
      customAttributes?: { hrStatus?: string; startDateUnreadable?: string };
    };
  }>;
}

export const JOINER_PROJECTION = {
  deletedAt: 1,
  'profile.email': 1,
  'profile.status': 1,
  'provisioning.targetSystem': 1,
  'provisioning.status': 1,
  'provisioning.lastSync': 1,
  'sources.sourceName': 1,
  'sources.lastSync': 1,
  'sources.rawData.status': 1,
  'sources.rawData.startDate': 1,
  'sources.rawData.endDate': 1,
  'sources.rawData.customAttributes.hrStatus': 1,
  'sources.rawData.customAttributes.startDateUnreadable': 1,
} as const;

export interface JoinerRuleContext {
  /** The joiner's source: its own record (`sources[].rawData`) is read, as leaver detection does. */
  sourceName: string;
  now: Date;
  /** Leaver policy: the zone a start or end date's day is read in, and the "left" status words. */
  timezone: string;
  terminatedStatuses: string[];
  /** An HR leaver event is open or started for the identity (leaver_events). */
  hasLeaverEvent: boolean;
  /**
   * Start of the full sync that evaluates the joiner: the person must be in it. Unset for a batch
   * approval, which does not ask for a delivery.
   */
  deliveredSince?: Date;
  /**
   * Set for a rehire: when the sync revived the deleted identity. Targets its earlier employment
   * left deprovisioned (DEPROVISIONED, last written before then) do not make it onboarded.
   */
  rehiredAt?: Date;
}

/** Why a joiner keeps waiting. */
export type JoinerWaitReason =
  | 'start-date'
  | 'start-date-unreadable'
  | 'not-delivered'
  | 'inactive';

export type JoinerState =
  | { due: true; email: string }
  | { wait: JoinerWaitReason; reason: string }
  | { close: string };

function toDate(value: Date | string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** A target the rehired person's earlier employment left deprovisioned (before `rehiredAt`). */
function leftByEarlierEmployment(
  entry: { status?: string; lastSync?: Date | string },
  rehiredAt: Date,
): boolean {
  if (entry.status !== 'DEPROVISIONED') return false;
  const lastSync = toDate(entry.lastSync);
  return !lastSync || lastSync <= rehiredAt;
}

/**
 * Due, waiting or closed, first match wins: gone or already onboarded (a rehire: since the
 * rehire) closes; left in HR (status TERMINATED or DELETED, an HR status word the leaver policy
 * reads as "left", an end date that is over, an HR leaver event) closes; no email closes;
 * SUSPENDED or INACTIVE waits; a full sync that did not deliver the person waits; a start date
 * after today (in the policy zone) waits, and so does a start date HR sent that is not a date.
 */
export function joinerState(
  identity: IdentityForJoiner | null,
  ctx: JoinerRuleContext,
): JoinerState {
  if (!identity || identity.deletedAt) return { close: 'The identity was deleted.' };
  const { rehiredAt } = ctx;
  const provisioning = (identity.provisioning ?? []).filter(
    (p) => !rehiredAt || !leftByEarlierEmployment(p, rehiredAt),
  );
  if (provisioning.length > 0) {
    return { close: 'The identity was already onboarded (its provisioning is recorded).' };
  }
  const status = identity.profile?.status;
  if (status === UserStatus.TERMINATED || status === UserStatus.DELETED) {
    return { close: `The identity is ${status}.` };
  }
  const record = identity.sources?.find((s) => s.sourceName === ctx.sourceName);
  const raw = record?.rawData ?? {};
  const hrStatus = (raw.customAttributes?.hrStatus ?? raw.status)?.trim().toLowerCase();
  const leftWords = ctx.terminatedStatuses.map((s) => s.trim().toLowerCase());
  if (hrStatus && leftWords.includes(hrStatus)) {
    return { close: `HR marks the person as left (status "${hrStatus}").` };
  }
  const endDate = toDate(raw.endDate);
  if (endDate && dayIsOver(endDate, ctx.timezone, ctx.now)) {
    return { close: `The employment ended in HR (${calendarDay(endDate, ctx.timezone)}).` };
  }
  if (ctx.hasLeaverEvent) return { close: 'An HR leaver event exists for the identity.' };
  const email = identity.profile?.email;
  if (!email) return { close: 'The identity has no email.' };

  if (status === UserStatus.SUSPENDED || status === UserStatus.INACTIVE) {
    return { wait: 'inactive', reason: `The identity is ${status}.` };
  }
  if (ctx.deliveredSince) {
    const lastSync = toDate(record?.lastSync);
    if (!lastSync || lastSync < ctx.deliveredSince) {
      return { wait: 'not-delivered', reason: 'The full sync did not deliver the person.' };
    }
  }
  const startDate = toDate(raw.startDate);
  if (startDate) {
    const startDay = calendarDay(startDate, ctx.timezone);
    if (startDay > todayIn(ctx.timezone, ctx.now)) {
      return { wait: 'start-date', reason: `The start date is ${startDay}.` };
    }
  } else if (raw.customAttributes?.startDateUnreadable) {
    // Onboarding now could give access before the real start: wait for a readable date
    const sent = raw.customAttributes.startDateUnreadable;
    return {
      wait: 'start-date-unreadable',
      reason: `Start date unreadable: the HR record's start date "${sent}" is not a date.`,
    };
  }
  return { due: true, email };
}
