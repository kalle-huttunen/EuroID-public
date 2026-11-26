/**
 * Access review campaigns: an active quarterly review of Engineering with items in every state,
 * and last quarter's completed Finance certification with its revocations.
 */
import { CampaignStatus } from '@modules/access-review/schemas/review-campaign.schema';
import { daysFrom, seededObjectId, seededUuid, type SeededRandom } from './random';
import {
  DEMO_SEED_MARKER,
  fullName,
  managerOf,
  personId,
  sectionRandom,
  workingPeople,
  type SeedContext,
} from './context';
import type { DemoPerson } from './people';
import { catalogEntry } from './catalog';
import { entraObjectId } from './provisioning';
import { timelineEntry, type TimelineEntry } from './timeline';

interface CampaignSpec {
  key: string;
  name: string;
  description: string;
  department: string;
  status: CampaignStatus;
  /** Policy entitlements every member holds, and one that only some hold. */
  entitlements: string[];
  extra: string;
  /** Days from the run's day. */
  created: number;
  deadline: number;
}

function quarter(date: Date, back: number): string {
  const q = Math.floor(date.getUTCMonth() / 3) - back;
  const year = date.getUTCFullYear() + Math.floor(q / 4);
  return `Q${(((q % 4) + 4) % 4) + 1} ${year}`;
}

function specs(anchor: Date): CampaignSpec[] {
  return [
    {
      key: 'active',
      name: `${quarter(anchor, 0)} access review: Engineering`,
      description: 'Quarterly review of the Engineering groups and repositories.',
      department: 'Engineering',
      status: CampaignStatus.ACTIVE,
      entitlements: ['grp-Engineering', 'gh-engineering'],
      extra: 'grp-prod-db',
      created: -9,
      deadline: 14,
    },
    {
      key: 'completed',
      name: `${quarter(anchor, 1)} certification: Finance`,
      description: 'SOX certification of the finance systems.',
      department: 'Finance',
      status: CampaignStatus.COMPLETED,
      entitlements: ['grp-Finance', 'ad-finance-share'],
      extra: 'grp-ap-approvers',
      created: -75,
      deadline: -45,
    },
  ];
}

type Decision = 'pending' | 'approved' | 'revoked' | 'expired';

function decide(spec: CampaignSpec, rng: SeededRandom, k: number): Decision {
  if (spec.status === CampaignStatus.COMPLETED)
    return k === 1 || k === 4 ? 'revoked' : k === 6 ? 'expired' : 'approved';
  const roll = rng.next();
  return roll < 0.55 ? 'pending' : roll < 0.9 ? 'approved' : 'revoked';
}

export interface ReviewData {
  campaigns: Record<string, unknown>[];
  items: Record<string, unknown>[];
  timeline: TimelineEntry[];
}

export function buildReviews(ctx: SeedContext): ReviewData {
  const rng = sectionRandom('reviews');
  const out: ReviewData = { campaigns: [], items: [], timeline: [] };
  specs(ctx.anchor).forEach((spec, c) => {
    const campaignId = seededUuid(ctx.tenantId, `campaign|${spec.key}`);
    const completed = spec.status === CampaignStatus.COMPLETED;
    const deadline = daysFrom(ctx.anchor, spec.deadline);
    const members = workingPeople(ctx).filter(
      (p: DemoPerson) => p.department.name === spec.department && p.role !== 'head',
    );
    const stats = { totalItems: 0, approved: 0, revoked: 0, pending: 0, expired: 0 };
    members.forEach((person, k) => {
      const reviewer = managerOf(ctx, person);
      const decision = decide(spec, rng, k);
      const keys = [...spec.entitlements, ...(rng.chance(0.25) ? [spec.extra] : [])];
      const decidedAt = completed
        ? daysFrom(deadline, -rng.int(1, 20), rng.int(8, 16))
        : daysFrom(ctx.anchor, -rng.int(0, 6), rng.int(8, 16));
      const itemId = seededUuid(ctx.tenantId, `review-item|${spec.key}|${k}`);
      const entitlements = keys.map((key) => {
        const entry = catalogEntry(ctx, key);
        const removed = completed && decision === 'revoked' && key === keys[keys.length - 1];
        return {
          system: entry.system,
          type: entry.type,
          name: entry.name,
          nativeId: entry.nativeId,
          policyManaged: key !== spec.extra,
          riskLevel: entry.riskLevel,
          ...(entry.system === 'entra-id' ? { accountId: entraObjectId(ctx, person) } : {}),
          ...(removed
            ? {
                revocation: {
                  outcome: 'removed',
                  detail: 'Removed from the group.',
                  at: daysFrom(deadline, 1, 2),
                },
              }
            : {}),
        };
      });
      stats.totalItems++;
      stats[decision]++;
      out.items.push({
        _id: seededObjectId(ctx.tenantId, `review-item-${spec.key}`, k),
        tenantId: ctx.tenantId,
        itemId,
        campaignId,
        identityId: personId(ctx, person),
        identityEmail: person.email,
        identityName: fullName(person),
        reviewerId: reviewer?.email ?? 'admin',
        entitlements,
        decision,
        autoExpired: decision === 'expired',
        ...(decision === 'approved' || decision === 'revoked'
          ? {
              decidedBy: reviewer?.email,
              decidedAt,
              justification:
                decision === 'revoked'
                  ? 'No longer needed after the move to another team.'
                  : 'Still needed for the role.',
            }
          : {}),
      });
      if (completed && decision === 'revoked') {
        const removed = entitlements[entitlements.length - 1];
        out.timeline.push(
          timelineEntry(
            personId(ctx, person),
            daysFrom(deadline, 1, 2),
            'GROUP_REMOVED',
            'success',
            `Group membership removed after access review: ${removed.system}`,
            {
              targetSystem: removed.system,
              description: 'Removed from the group.',
              metadata: { campaignId, itemId, groupId: removed.nativeId, outcome: 'removed' },
            },
          ),
        );
      }
    });
    out.campaigns.push({
      _id: seededObjectId(ctx.tenantId, 'review-campaign', c),
      tenantId: ctx.tenantId,
      campaignId,
      name: spec.name,
      description: spec.description,
      scope: { type: 'department', value: spec.department },
      status: spec.status,
      createdBy: DEMO_SEED_MARKER,
      deadline,
      autoRevokeOnExpiry: false,
      stats,
      escalation: { enabled: true, escalateAfterDays: 7, escalateTo: 'MANAGER' },
      ...(completed
        ? {}
        : {
            recurrence: {
              enabled: true,
              frequency: 'QUARTERLY',
              nextRunAt: daysFrom(ctx.anchor, 80),
            },
          }),
      ...(completed
        ? {
            completedAt: daysFrom(deadline, 1, 2),
            revocationSummary: {
              removed: stats.revoked,
              alreadyGone: 0,
              manualActionNeeded: 0,
              failed: 0,
            },
          }
        : {}),
      createdAt: daysFrom(ctx.anchor, spec.created, 9),
    });
  });
  return out;
}
