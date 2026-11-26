import { MockActivityEnvironment } from '@temporalio/testing';
import { RiskScoreActivities } from './risk-score.activities';
import { DomainEventType } from '../infrastructure/events/event-types';
import type { RiskScoringService } from '../modules/risk-scoring/risk-scoring.service';
import type { TenantService } from '../infrastructure/multi-tenancy/tenant.service';
import type { DomainEventEmitterService } from '../infrastructure/events/event-emitter.service';

/**
 * The nightly batch's risk_scores.calculated event: avgScore is the tenant's average score (it
 * was the mean of the ten riskiest identities), top10IdentityIds the riskiest ones.
 */
describe('RiskScoreActivities.runRiskScoreBatch', () => {
  const emit = jest.fn();
  const riskScoring = {
    batchCalculate: jest.fn(async () => ({ processed: 40, errors: 0 })),
    getTopRisky: jest.fn(async () => [
      { identityId: 'id-1', score: 95 },
      { identityId: 'id-2', score: 90 },
    ]),
    getAverageScore: jest.fn(async () => 12.5),
  };
  const activities = new RiskScoreActivities(
    riskScoring as unknown as RiskScoringService,
    { findAll: jest.fn() } as unknown as TenantService,
    { emit } as unknown as DomainEventEmitterService,
  );

  it("reports the tenant's average score and its riskiest identities", async () => {
    await activities.runRiskScoreBatch('tenant-a', '2026-11-25T02:00:00.000Z');

    expect(riskScoring.getAverageScore).toHaveBeenCalledWith('tenant-a');
    expect(emit).toHaveBeenCalledWith(DomainEventType.RISK_SCORES_CALCULATED, 'tenant-a', {
      tenantId: 'tenant-a',
      processed: 40,
      errors: 0,
      avgScore: 12.5,
      top10IdentityIds: ['id-1', 'id-2'],
    });
  });
});

/**
 * Per tenant (workflow patch risk-score-calculation:per-tenant, r2-05 N6): the tenants are listed
 * once and each is scored in its own activity, which heartbeats the batch's progress and, when
 * Temporal retries it, resumes from the last heartbeat instead of starting over.
 */
describe('RiskScoreActivities per tenant', () => {
  const emit = jest.fn();
  const progress = { offset: 3, processed: 3, errors: 0, orgAverage: 4 };
  const riskScoring = {
    batchCalculate: jest.fn(),
    getTopRisky: jest.fn(async () => [{ identityId: 'id-1', score: 95 }]),
    getAverageScore: jest.fn(async () => 20),
  };
  const findAll = jest.fn(async () => [
    { tenantId: 'tenant-a', status: 'active' },
    { tenantId: 'tenant-b', status: 'suspended' },
    { tenantId: 'tenant-c', status: 'active' },
  ]);
  const activities = new RiskScoreActivities(
    riskScoring as unknown as RiskScoringService,
    { findAll } as unknown as TenantService,
    { emit } as unknown as DomainEventEmitterService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('lists the active tenants, or only the one the run names', async () => {
    await expect(activities.listRiskScoreTenants('')).resolves.toEqual(['tenant-a', 'tenant-c']);
    await expect(activities.listRiskScoreTenants('tenant-b')).resolves.toEqual(['tenant-b']);
  });

  it("heartbeats the batch's progress and reports the tenant's scores", async () => {
    riskScoring.batchCalculate.mockImplementation(async (_t, _s, _n, p) => {
      p.onProgress(progress);
      return { processed: 5, errors: 1 };
    });
    const env = new MockActivityEnvironment();
    const beats: unknown[] = [];
    env.on('heartbeat', (details: unknown) => beats.push(details));

    const result = await env.run(() =>
      activities.runRiskScoreTenant('tenant-a', '2026-11-26T02:00:00.000Z', 50),
    );

    expect(result).toEqual({ processed: 5, errors: 1 });
    expect(beats).toEqual([progress]);
    expect(riskScoring.batchCalculate).toHaveBeenCalledWith(
      'tenant-a',
      50,
      new Date('2026-11-26T02:00:00.000Z'),
      expect.objectContaining({ resume: undefined }),
    );
    expect(emit).toHaveBeenCalledWith(
      DomainEventType.RISK_SCORES_CALCULATED,
      'tenant-a',
      expect.objectContaining({ tenantId: 'tenant-a', processed: 5, errors: 1, avgScore: 20 }),
    );
  });

  it('resumes from the last heartbeat when Temporal retries it', async () => {
    riskScoring.batchCalculate.mockResolvedValue({ processed: 5, errors: 1 });
    const env = new MockActivityEnvironment({ attempt: 2, heartbeatDetails: progress });

    await env.run(() => activities.runRiskScoreTenant('tenant-a', '2026-11-26T02:00:00.000Z', 50));

    expect(riskScoring.batchCalculate).toHaveBeenCalledWith(
      'tenant-a',
      50,
      new Date('2026-11-26T02:00:00.000Z'),
      expect.objectContaining({ resume: progress }),
    );
  });

  it('fails when the batch fails, for Temporal to retry it', async () => {
    riskScoring.batchCalculate.mockRejectedValue(new Error('MongoServerSelectionError'));
    const env = new MockActivityEnvironment();

    await expect(
      env.run(() => activities.runRiskScoreTenant('tenant-a', '2026-11-26T02:00:00.000Z', 50)),
    ).rejects.toThrow('MongoServerSelectionError');
    expect(emit).not.toHaveBeenCalled();
  });
});
