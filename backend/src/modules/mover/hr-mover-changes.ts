/**
 * Which trigger attributes of an identity differ from its access baseline: the pure part of HR
 * mover detection (hr-mover-detection.service.ts) and of approving a paused batch. No I/O.
 */
import { createHash } from 'crypto';
import {
  accessBaselineChanges,
  type AccessBaselineAttributes,
} from '@shared/utils/access-baseline';
import { CRITICAL_FIELDS } from '../identity/identity.constants';
import { provisionedSystems } from '../identity/identity-provisioning.service';
import type { LinkedAccount, ProvisioningState } from '../identity/schemas/identity.schema';
import { UserStatus } from '@shared/dtos/standard-user.dto';

/**
 * The attributes whose HR change moves access: the mover's existing trigger attributes, the
 * same list PATCH /identity/:id starts the mover on (MoverEventHandler).
 */
export const HR_MOVER_ATTRIBUTES: readonly string[] = CRITICAL_FIELDS;

/** Profile statuses an HR mover leaves alone: the identity's access is going or gone. */
export const HR_MOVER_INACTIVE_STATUSES: readonly string[] = [
  UserStatus.TERMINATED,
  UserStatus.DELETED,
  UserStatus.SUSPENDED,
];

/** One trigger attribute: its value in the access baseline and in the profile now. */
export interface TriggerAttributeChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** The identity fields detection reads (lean projection). */
export interface IdentityForHrMover {
  _id: unknown;
  profile?: Record<string, unknown>;
  accessBaseline?: { attributes?: AccessBaselineAttributes };
  provisioning?: Array<
    Pick<ProvisioningState, 'targetSystem' | 'status' | 'provisionedAt' | 'writebackComplete'>
  >;
  sources?: Array<Pick<LinkedAccount, 'sourceName' | 'externalId' | 'sourceRole'>>;
}

/** One identity whose access the HR data moved: what the mover run gets. */
export interface HrMoverCandidate {
  identityId: string;
  email: string;
  changes: TriggerAttributeChange[];
}

function triggerValues(source: Record<string, unknown> | undefined): AccessBaselineAttributes {
  const out: AccessBaselineAttributes = {};
  for (const field of HR_MOVER_ATTRIBUTES) {
    if (source?.[field] !== undefined) out[field] = source[field];
  }
  return out;
}

/**
 * The trigger attributes whose profile value differs from the baseline, in HR_MOVER_ATTRIBUTES
 * order (null for a value either side lacks). Other attributes are not compared.
 */
export function triggerAttributeChanges(
  baseline: AccessBaselineAttributes,
  profile: Record<string, unknown>,
): TriggerAttributeChange[] {
  const current = triggerValues(profile);
  const previous = accessBaselineChanges(triggerValues(baseline), current);
  return HR_MOVER_ATTRIBUTES.filter((field) => field in previous).map((field) => ({
    field,
    before: previous[field] ?? null,
    after: current[field] ?? null,
  }));
}

/**
 * The mover input for these changes: the attributes it evaluates, and their baseline values (the
 * "before" profile the policies are evaluated against).
 */
export function moverInputOf(changes: TriggerAttributeChange[]): {
  changedFields: string[];
  previousAttributes: Record<string, unknown>;
} {
  return {
    changedFields: changes.map((c) => c.field),
    previousAttributes: Object.fromEntries(changes.map((c) => [c.field, c.before])),
  };
}

/**
 * Identifies one set of changes of one identity (same fields, same before and after values):
 * a rejected batch item with this key is not raised again until the HR data or the baseline
 * changes. A hash, so the key carries no attribute values.
 */
export function changeKey(changes: TriggerAttributeChange[]): string {
  const canonical = JSON.stringify(changes.map((c) => [c.field, c.before, c.after]));
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * True when the identity has an account in at least one target system: the rule the mover run
 * itself uses (provisionedSystems), so a system in ERROR after a failed run still counts.
 */
export function isProvisioned(identity: IdentityForHrMover): boolean {
  return provisionedSystems(identity).length > 0;
}

/**
 * The mover candidate an identity is now, or why it is none (`reason`): no email, inactive, not
 * provisioned, no access baseline, or trigger attributes equal to the baseline.
 */
export function hrMoverCandidate(
  identity: IdentityForHrMover,
): { candidate: HrMoverCandidate } | { reason: string; noBaseline?: true } {
  const profile = identity.profile ?? {};
  const email = typeof profile.email === 'string' ? profile.email : '';
  if (!email) {
    return { reason: 'The identity has no email: the mover looks up target accounts by email.' };
  }
  if (HR_MOVER_INACTIVE_STATUSES.includes(String(profile.status))) {
    return { reason: `The identity is ${String(profile.status).toLowerCase()}.` };
  }
  if (!isProvisioned(identity)) {
    return { reason: 'The identity is not provisioned to any target system.' };
  }
  const baseline = identity.accessBaseline?.attributes;
  if (!baseline) {
    return {
      reason: 'The identity has no access baseline: EuroID cannot tell what to remove.',
      noBaseline: true,
    };
  }
  const changes = triggerAttributeChanges(baseline, profile);
  if (changes.length === 0) return { reason: 'Its access already matches the HR data.' };
  return { candidate: { identityId: String(identity._id), email, changes } };
}

/** Lean projection of the identity fields hrMoverCandidate reads. */
export const HR_MOVER_PROJECTION: Record<string, 1> = {
  'profile.email': 1,
  'profile.status': 1,
  ...Object.fromEntries(HR_MOVER_ATTRIBUTES.map((f) => [`profile.${f}`, 1])),
  accessBaseline: 1,
  // What provisionedSystems reads
  'provisioning.targetSystem': 1,
  'provisioning.status': 1,
  'provisioning.provisionedAt': 1,
  'provisioning.writebackComplete': 1,
  'sources.sourceName': 1,
  'sources.externalId': 1,
  'sources.sourceRole': 1,
};
