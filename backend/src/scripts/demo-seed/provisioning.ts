/**
 * Provisioning entries (identity layer 4) of the demo people: one per target system a person has
 * an account in, mostly SYNCED, a few in ERROR with the target's reason, and two failed expiries.
 */
import { EmploymentType } from '@shared/dtos/standard-user.dto';
import type { ProvisioningState } from '@modules/identity/schemas/identity.schema';
import { daysFrom, seededUuid, type SeededRandom } from './random';
import type { TargetSystem } from './pools';
import type { DemoPerson } from './people';
import type { SeedContext } from './context';

/** What a failed sync of each target reported (no personal data, as the connectors log it). */
const ERROR_REASONS: Record<TargetSystem, string> = {
  entra:
    'Graph API 400: Another object with the same value for property userPrincipalName already exists.',
  ad: 'LDAP error 19 (constraintViolation): the password does not meet the domain complexity policy.',
  okta: 'Okta API 429: rate limit exceeded on /api/v1/users, retry after 60 seconds.',
  github: 'GitHub API 422: the organization has no free seats left.',
  'file-outbound': 'SFTP upload failed: connection to payroll.sftp.example.com:22 timed out.',
};

/** Account the target gave the person, kept by the Entra write-back. */
export function entraObjectId(ctx: SeedContext, person: DemoPerson): string {
  return seededUuid(ctx.tenantId, `entra-object|${person.index}`);
}

export function targetsOf(person: DemoPerson): TargetSystem[] {
  const external = [EmploymentType.CONTRACTOR, EmploymentType.CONSULTANT].includes(
    person.employmentType,
  );
  const payroll = [EmploymentType.FULL_TIME, EmploymentType.PART_TIME].includes(
    person.employmentType,
  );
  const targets: TargetSystem[] = ['entra'];
  if (!external) targets.push('ad');
  targets.push(...person.department.extraTargets);
  if (payroll) targets.push('file-outbound');
  return [...new Set(targets)];
}

export interface ProvisioningPlan {
  /** Person index -> the target whose last sync failed. */
  errors: Map<number, TargetSystem>;
  /** Person index -> a time-bound entry whose removal at expiry failed. */
  failedExpiries: Map<number, { target: TargetSystem; retryable: boolean }>;
}

/** Picks the few people whose provisioning is not clean. */
export function planProvisioning(people: DemoPerson[], rng: SeededRandom): ProvisioningPlan {
  const candidates = rng.shuffle(
    people.filter((p) => p.lifecycle === 'active' && p.role === 'member' && !p.conflict),
  );
  const errors = new Map<number, TargetSystem>();
  for (const p of candidates.slice(0, 6)) errors.set(p.index, rng.pick(targetsOf(p)));
  const failedExpiries = new Map<number, { target: TargetSystem; retryable: boolean }>();
  for (const p of candidates.slice(6)) {
    const target = targetsOf(p).find((t) => t === 'github' || t === 'okta');
    if (!target) continue;
    failedExpiries.set(p.index, { target, retryable: failedExpiries.size === 0 });
    if (failedExpiries.size === 2) break;
  }
  return { errors, failedExpiries };
}

function entryFor(
  ctx: SeedContext,
  rng: SeededRandom,
  person: DemoPerson,
  target: TargetSystem,
  plan: ProvisioningPlan,
): ProvisioningState {
  const gone = person.lifecycle === 'terminated' || person.lifecycle === 'soft-deleted';
  const provisionedAt = daysFrom(
    person.startDate < daysFrom(ctx.anchor, -700) ? daysFrom(ctx.anchor, -700) : person.startDate,
    0,
    rng.int(7, 9),
  );
  const entry: ProvisioningState = {
    targetSystem: target,
    status: gone ? 'DEPROVISIONED' : 'SYNCED',
    lastSync:
      gone && person.endDate
        ? daysFrom(person.endDate, 0, 18)
        : daysFrom(ctx.anchor, 0, -rng.int(1, 30)),
    writebackComplete: target === 'entra',
    provisionedAt: gone ? null : provisionedAt,
    grantedBy: 'policy',
  };
  const external = [EmploymentType.CONTRACTOR, EmploymentType.CONSULTANT];
  if (!gone && external.includes(person.employmentType) && target !== 'entra' && person.endDate) {
    entry.expiresAt = person.endDate;
  }
  if (plan.errors.get(person.index) === target) {
    entry.status = 'ERROR';
    entry.errorMsg = ERROR_REASONS[target];
  }
  const failed = plan.failedExpiries.get(person.index);
  if (failed?.target === target) {
    const expiresAt = daysFrom(ctx.anchor, -2);
    entry.expiresAt = expiresAt;
    entry.grantedBy = 'request';
    entry.expiryFailure = {
      expiresAt,
      failedAt: daysFrom(expiresAt, 0, 2),
      reason: failed.retryable
        ? `${ERROR_REASONS[target]} Removal is tried again.`
        : 'The connector cannot remove this access: remove it in the target by hand.',
      retryable: failed.retryable,
      attempts: failed.retryable ? 3 : 1,
      ...(failed.retryable ? { nextAttemptAt: daysFrom(ctx.anchor, 1, 6) } : {}),
    };
  }
  return entry;
}

/** Joiners and unlinked records have no accounts yet; leavers have theirs removed. */
export function buildProvisioning(
  ctx: SeedContext,
  rng: SeededRandom,
  person: DemoPerson,
  plan: ProvisioningPlan,
): ProvisioningState[] {
  const none = ['future-joiner', 'joiner-batch', 'uncorrelated', 'ambiguous'];
  if (none.includes(person.lifecycle)) return [];
  return targetsOf(person).map((target) => entryFor(ctx, rng, person, target, plan));
}
