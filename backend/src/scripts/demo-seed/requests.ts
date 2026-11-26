/**
 * A dozen access requests in different states (pending, approved and active, rejected, expired),
 * approved by the requester's manager and the entitlement's owner as the catalog's chain says.
 */
import { daysFrom, seededObjectId, seededUuid } from './random';
import {
  DEMO_SEED_MARKER,
  managerOf,
  personId,
  sectionRandom,
  workingPeople,
  type SeedContext,
} from './context';
import type { DemoPerson } from './people';
import { catalogEntry, type CatalogEntry } from './catalog';

type RequestState = 'PENDING_APPROVAL' | 'PENDING_OWNER' | 'ACTIVE' | 'REJECTED' | 'EXPIRED';

const STATES: RequestState[] = [
  'PENDING_APPROVAL',
  'PENDING_APPROVAL',
  'PENDING_APPROVAL',
  'PENDING_OWNER',
  'ACTIVE',
  'ACTIVE',
  'ACTIVE',
  'ACTIVE',
  'REJECTED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED',
];

const WANTS: Record<string, string[]> = {
  Engineering: ['grp-prod-db', 'gh-platform-admins', 'grp-cab'],
  Finance: ['grp-ap-clerks', 'grp-ap-approvers', 'lic-powerbi'],
  'Human Resources': ['grp-hr-records', 'grp-payroll'],
  Product: ['lic-powerbi', 'lic-visio'],
};

const WHY: Record<string, string> = {
  'grp-prod-db': 'Investigating slow queries in the billing service this sprint.',
  'gh-platform-admins': 'Rotating the deploy keys of the platform repositories.',
  'grp-cab': 'Joining the change advisory board as the team representative.',
  'grp-ap-clerks': 'Covering supplier invoices during the month-end close.',
  'grp-ap-approvers': 'Deputy approver while the controller is on leave.',
  'lic-powerbi': 'Building the quarterly KPI report for the leadership team.',
  'grp-hr-records': 'Updating contracts after the salary review.',
  'grp-payroll': 'Backup for the payroll run during the holidays.',
  'lic-visio': 'Process maps for the onboarding redesign.',
  'grp-vpn': 'Working from the Tampere client site two days a week.',
  'lic-e5': 'Needs the advanced eDiscovery features for a legal hold.',
};

function step(
  order: number,
  type: 'MANAGER' | 'OWNER',
  approver: DemoPerson | undefined,
  ctx: SeedContext,
  decision?: { status: 'APPROVED' | 'REJECTED' | 'SKIPPED'; at: Date; justification?: string },
) {
  return {
    stepOrder: order,
    approverType: type,
    approverId: approver ? personId(ctx, approver) : undefined,
    approverEmail: approver?.email,
    status: decision?.status ?? 'PENDING',
    ...(decision && decision.status !== 'SKIPPED'
      ? {
          decidedAt: decision.at,
          decidedBy: approver?.email,
          justification: decision.justification,
        }
      : {}),
  };
}

export function buildAccessRequests(ctx: SeedContext): Record<string, unknown>[] {
  const rng = sectionRandom('access-requests');
  const requesters = rng
    .shuffle(workingPeople(ctx).filter((p) => p.role === 'member' && p.managerIndex !== undefined))
    .slice(0, STATES.length);
  return STATES.map((state, i) => {
    const person = requesters[i];
    const key = rng.pick(
      WANTS[person.department.name] ?? ['grp-vpn', 'lic-e5', 'lic-powerbi', 'lic-visio'],
    );
    const entry: CatalogEntry = catalogEntry(ctx, key);
    const manager = managerOf(ctx, person);
    const owner = ctx.people.find((p) => p.email === entry.owner);
    const requestId = seededUuid(ctx.tenantId, `access-request|${i}`);
    const age = { PENDING_APPROVAL: 2, PENDING_OWNER: 3, ACTIVE: 8, REJECTED: 15, EXPIRED: 80 }[
      state
    ];
    const createdAt = daysFrom(ctx.anchor, -age - rng.int(0, 4), rng.int(7, 10));
    const approvedAt = daysFrom(createdAt, 0, rng.int(2, 20));
    const ownerAt = daysFrom(approvedAt, 0, rng.int(1, 6));
    const days = key === 'gh-platform-admins' ? 14 : key === 'grp-prod-db' ? 30 : 60;
    const timeBound = state === 'EXPIRED' || key === 'gh-platform-admins' || key === 'grp-prod-db';
    const expiresAt = daysFrom(ownerAt, days);
    const approved = {
      status: 'APPROVED' as const,
      at: approvedAt,
      justification: 'Approved for the stated purpose.',
    };
    const steps =
      state === 'PENDING_APPROVAL'
        ? [step(0, 'MANAGER', manager, ctx), step(1, 'OWNER', owner, ctx)]
        : state === 'PENDING_OWNER'
          ? [step(0, 'MANAGER', manager, ctx, approved), step(1, 'OWNER', owner, ctx)]
          : state === 'REJECTED'
            ? [
                step(0, 'MANAGER', manager, ctx, {
                  status: 'REJECTED',
                  at: approvedAt,
                  justification:
                    'Not needed for the current project; use the shared report instead.',
                }),
                step(1, 'OWNER', owner, ctx, { status: 'SKIPPED', at: approvedAt }),
              ]
            : [
                step(0, 'MANAGER', manager, ctx, approved),
                step(1, 'OWNER', owner, ctx, { ...approved, at: ownerAt }),
              ];
    // A Warn match is stored with the request; a Block match is refused before it is stored
    const sodWarning = key === 'grp-hr-records';
    const done = state === 'ACTIVE' || state === 'EXPIRED';
    return {
      _id: seededObjectId(ctx.tenantId, 'access-request', i),
      tenantId: ctx.tenantId,
      requestId,
      requesterId: personId(ctx, person),
      requesterEmail: person.email,
      targetIdentityId: personId(ctx, person),
      entitlements: [
        {
          catalogEntryId: entry.id,
          system: entry.system,
          entitlementName: entry.name,
          nativeId: entry.nativeId,
          entitlementType: entry.type,
          justification: WHY[key] ?? 'Needed for my work.',
        },
      ],
      status: state === 'PENDING_OWNER' ? 'PENDING_APPROVAL' : state,
      approvalSteps: steps,
      ...(timeBound ? { timeConstraint: { requestedDurationDays: days, expiresAt } } : {}),
      sodCheckResult: {
        passed: true,
        violations: sodWarning
          ? [
              {
                policyName: 'Payroll vs. HR records',
                severity: 'HIGH',
                action: 'WARN',
                conflictingEntitlements: [`${entry.system}:${entry.nativeId}`],
              },
            ]
          : [],
      },
      workflowId: `${DEMO_SEED_MARKER}:access-request-${requestId}`,
      ...(done ? { provisionedAt: daysFrom(ownerAt, 0, 0.2) } : {}),
      ...(done && timeBound ? { expiresAt } : {}),
      createdAt,
      updatedAt: state.startsWith('PENDING') ? createdAt : ownerAt,
    };
  });
}
