/**
 * Identity timeline entries (user_events) for a sample of the demo people, in the shapes the
 * timeline handlers record: created, onboarding, policy evaluation, provisioning, a move, an
 * offboarding.
 */
import { daysFrom, type SeededRandom } from './random';
import { PRIMARY_HR, SECONDARY_HR, type TargetSystem } from './pools';
import { personId, sectionRandom, type SeedContext } from './context';
import type { DemoPerson } from './people';
import { targetsOf, type ProvisioningPlan } from './provisioning';

type Severity = 'info' | 'success' | 'warning' | 'error';

export interface TimelineEntry {
  userId: string;
  type: string;
  severity: Severity;
  timestamp: Date;
  title: string;
  description?: string;
  actor: string;
  targetSystem?: string;
  metadata: Record<string, unknown>;
}

export function timelineEntry(
  person: string,
  at: Date,
  type: string,
  severity: Severity,
  title: string,
  extra: Partial<TimelineEntry> = {},
): TimelineEntry {
  return {
    userId: person,
    type,
    severity,
    timestamp: at,
    title,
    actor: 'system',
    ...extra,
    metadata: { ...(extra.metadata ?? {}), demoSeed: true },
  };
}

/** Timeline entries older than the user_events TTL (about 13 months) are left out. */
function onboardingEntries(ctx: SeedContext, person: DemoPerson, plan: ProvisioningPlan) {
  const id = personId(ctx, person);
  const source = person.lifecycle === 'uncorrelated' ? SECONDARY_HR : PRIMARY_HR;
  const created =
    person.startDate > ctx.anchor
      ? daysFrom(ctx.anchor, -5, 4)
      : daysFrom(person.startDate, -10, 4);
  const entries = [
    timelineEntry(id, created, 'USER_CREATED', 'success', `Created via ${source}`, {
      description: 'User account created',
      metadata: { sourceSystem: source },
    }),
  ];
  if (['future-joiner', 'joiner-batch', 'uncorrelated', 'ambiguous'].includes(person.lifecycle)) {
    return entries;
  }
  const start = daysFrom(person.startDate, 0, 6);
  const targets = targetsOf(person);
  entries.push(
    timelineEntry(id, start, 'WORKFLOW_STARTED', 'info', 'Onboarding started by HR sync', {
      metadata: { workflowId: `onboarding-${id}` },
    }),
    timelineEntry(id, daysFrom(start, 0, 0.1), 'POLICY_EVALUATED', 'info', 'Policy evaluated', {
      description: `Matched: All employees: baseline access. ${targets.length + 1} operations.`,
      metadata: {
        matchedPolicies: ['All employees: baseline access'],
        generatedOperations: targets.length + 1,
      },
    }),
  );
  targets.forEach((target: TargetSystem, k) => {
    const at = daysFrom(start, 0, 0.2 + k * 0.05);
    const failed = plan.errors.get(person.index) === target;
    entries.push(
      failed
        ? timelineEntry(
            id,
            daysFrom(ctx.anchor, -1, 3),
            'USER_PROVISIONED',
            'error',
            `Provisioning failed to ${target}`,
            {
              targetSystem: target,
              description: 'The target refused the update; see the provisioning status.',
            },
          )
        : timelineEntry(id, at, 'USER_PROVISIONED', 'success', `Provisioned to ${target}`, {
            targetSystem: target,
            description: `${k === 0 ? 3 : 1} operations executed`,
          }),
    );
  });
  return entries;
}

function moverEntries(ctx: SeedContext, person: DemoPerson): ReturnType<typeof timelineEntry>[] {
  const id = personId(ctx, person);
  const fields = ['departmentName', 'jobTitle'];
  const at =
    person.lifecycle === 'mover-batch' ? daysFrom(ctx.anchor, -1, 2) : daysFrom(ctx.anchor, -21, 2);
  const out = [
    timelineEntry(id, at, 'USER_UPDATED', 'info', `Updated: ${fields.join(', ')}`, {
      description: `${fields.length} field(s) updated`,
      metadata: { changedFields: fields, source: PRIMARY_HR },
    }),
  ];
  if (person.lifecycle === 'mover-done') {
    out.push(
      timelineEntry(
        id,
        daysFrom(at, 0, 0.2),
        'WORKFLOW_STARTED',
        'info',
        'Access change started by HR sync',
      ),
      timelineEntry(
        id,
        daysFrom(at, 0, 0.3),
        'USER_PROVISIONED',
        'success',
        'Access updated: entra',
        {
          targetSystem: 'entra',
        },
      ),
      timelineEntry(
        id,
        daysFrom(at, 0, 0.4),
        'WORKFLOW_COMPLETED',
        'success',
        'Access change completed',
        {
          description: `+1 / -1 entitlements (${fields.join(', ')}).`,
        },
      ),
    );
  }
  return out;
}

function leaverEntries(ctx: SeedContext, person: DemoPerson): ReturnType<typeof timelineEntry>[] {
  const id = personId(ctx, person);
  const at = daysFrom(person.endDate ?? ctx.anchor, 1, 1);
  if (person.lifecycle === 'leaver-batch') {
    return [
      timelineEntry(
        id,
        daysFrom(ctx.anchor, 0, -20),
        'LEAVER_DETECTED',
        'warning',
        'Leaver detected by HR sync',
        {
          description:
            'The end date in HR has passed. The offboarding waits for an admin to approve the batch.',
          metadata: { sourceName: PRIMARY_HR, reason: 'end-date' },
        },
      ),
    ];
  }
  return [
    timelineEntry(id, at, 'LEAVER_DETECTED', 'warning', 'Leaver detected by HR sync', {
      metadata: { sourceName: PRIMARY_HR, reason: 'terminated' },
    }),
    timelineEntry(
      id,
      daysFrom(at, 0, 0.5),
      'STATUS_CHANGE',
      'warning',
      'Status changed from ACTIVE to TERMINATED',
    ),
    ...targetsOf(person).map((target) =>
      timelineEntry(
        id,
        daysFrom(at, 0, 1),
        'USER_DEPROVISIONED',
        'success',
        `Deprovisioned from ${target}`,
        {
          targetSystem: target,
        },
      ),
    ),
  ];
}

/** A recent access re-evaluation, for people whose onboarding is older than the timeline keeps. */
function reEvaluationEntries(ctx: SeedContext, person: DemoPerson, rng: SeededRandom) {
  const id = personId(ctx, person);
  const at = daysFrom(ctx.anchor, -rng.int(5, 80), 10);
  return [
    timelineEntry(id, at, 'WORKFLOW_STARTED', 'info', 'Access re-evaluation started', {
      actor: 'admin',
    }),
    timelineEntry(
      id,
      daysFrom(at, 0, 0.1),
      'WORKFLOW_COMPLETED',
      'info',
      'Access change: nothing to change',
      {
        description: 'The policies give the same entitlements.',
      },
    ),
  ];
}

/** Every person with a lifecycle of their own, and about one in five of the others. */
export function buildTimeline(ctx: SeedContext, plan: ProvisioningPlan): TimelineEntry[] {
  const rng: SeededRandom = sectionRandom('timeline');
  const oldest = daysFrom(ctx.anchor, -380);
  const entries: TimelineEntry[] = [];
  for (const person of ctx.people) {
    const special = person.lifecycle !== 'active' || plan.errors.has(person.index);
    if (!special && !rng.chance(0.2)) continue;
    entries.push(...onboardingEntries(ctx, person, plan));
    if (person.lifecycle === 'active' && person.startDate < oldest) {
      entries.push(...reEvaluationEntries(ctx, person, rng));
    }
    if (person.previous) entries.push(...moverEntries(ctx, person));
    if (['terminated', 'soft-deleted', 'leaver-batch'].includes(person.lifecycle)) {
      entries.push(...leaverEntries(ctx, person));
    }
  }
  return entries.filter((e) => e.timestamp >= oldest);
}
