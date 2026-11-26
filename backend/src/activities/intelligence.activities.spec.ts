/**
 * The nightly intelligence batch's reviewer quality scoring: FOLLOWUPS 2026-11-24
 * (intelligence.activities.ts:108). Each tenant's intelligence.reviewer_quality_scored event says
 * what was scored in that tenant: the campaigns scored and how many reviewers got a score, in the
 * shape event-payload-schemas.ts accepts. A tenant where nothing was scored gets no event.
 */
import { IntelligenceActivities } from './intelligence.activities';
import type { IntelligenceService } from '../modules/intelligence/intelligence.service';
import type { TenantService } from '../infrastructure/multi-tenancy/tenant.service';
import type { DomainEventEmitterService } from '../infrastructure/events/event-emitter.service';
import { DomainEventType } from '../infrastructure/events/event-types';
import { getEventSchema } from '../infrastructure/events/event-payload-schemas';
import { getCurrentTenantId } from '../infrastructure/multi-tenancy/tenant-context.helper';

/** Per tenant, per campaign: the reviewers scored, or an error. */
const SCORED: Record<string, Record<string, string[] | Error>> = {
  t1: { c1: ['r1', 'r2'], c2: ['r1'], c3: new Error('item read failed') },
  t2: { c4: ['r3'] },
  t3: { c5: new Error('item read failed') },
};

describe('IntelligenceActivities.runReviewerQualityScoring', () => {
  const emit = jest.fn();
  let activities: IntelligenceActivities;

  beforeEach(() => {
    emit.mockReset();
    const intelligence = {
      getUnscoredCampaigns: jest.fn(async (tenantId: string) => Object.keys(SCORED[tenantId])),
      scoreCampaign: jest.fn(async (tenantId: string, campaignId: string) => {
        expect(getCurrentTenantId()).toBe(tenantId);
        const scored = SCORED[tenantId][campaignId];
        if (scored instanceof Error) throw scored;
        return scored.map((reviewerId) => ({ reviewerId, campaignId }));
      }),
    };
    const tenants = {
      findAll: jest.fn(async () => [
        { tenantId: 't1', status: 'active' },
        { tenantId: 't2', status: 'active' },
        { tenantId: 't3', status: 'active' },
        { tenantId: 't4', status: 'suspended' },
      ]),
    };
    activities = new IntelligenceActivities(
      intelligence as unknown as IntelligenceService,
      tenants as unknown as TenantService,
      { emit } as unknown as DomainEventEmitterService,
    );
  });

  it('emits per tenant the campaigns scored there and the reviewers they scored', async () => {
    const result = await activities.runReviewerQualityScoring('');

    expect(result).toEqual({ campaignsScored: 3, errors: 2 });
    expect(emit.mock.calls).toEqual([
      [
        DomainEventType.REVIEWER_QUALITY_SCORED,
        't1',
        { tenantId: 't1', campaignId: 'c1', campaignIds: ['c1', 'c2'], reviewersScoredCount: 2 },
      ],
      [
        DomainEventType.REVIEWER_QUALITY_SCORED,
        't2',
        { tenantId: 't2', campaignId: 'c4', campaignIds: ['c4'], reviewersScoredCount: 1 },
      ],
    ]);
    const schema = getEventSchema(DomainEventType.REVIEWER_QUALITY_SCORED);
    for (const [, , payload] of emit.mock.calls) {
      expect(schema.parse(payload)).toEqual(payload);
    }
  });

  it('scores only the tenant asked for', async () => {
    await activities.runReviewerQualityScoring('t2');

    expect(emit.mock.calls.map(([, tenantId]) => tenantId)).toEqual(['t2']);
  });
});
