/**
 * RiskScoringService.batchCalculate reports its progress and resumes from it. The nightly run
 * scored every identity of every tenant in one 30-minute activity that kept nothing when it
 * timed out (r2-05 N6). Each tenant now has its own activity, which heartbeats what onProgress
 * reports and, retried, hands the last heartbeat back as `resume`: the batch goes on from that
 * identity with the counts and organisation average it had.
 */
import { RiskScoringService } from './risk-scoring.service';

type Ctor = ConstructorParameters<typeof RiskScoringService>;

const NOW = new Date('2026-11-26T02:00:00.000Z');
const IDS = ['id-0', 'id-1', 'id-2', 'id-3', 'id-4'];

describe('RiskScoringService.batchCalculate progress', () => {
  const findUsersPageForReconciliation = jest.fn(async (skip: number, limit: number) => ({
    users: IDS.slice(skip, skip + limit).map((_id) => ({ _id })),
    total: skip === 0 ? IDS.length : undefined,
  }));
  const evaluateForRiskScoring = jest.fn(async () => ({
    intent: { operations: [{ action: 'add', type: 'group', targetId: 'g' }] },
    sodViolationCount: 0,
  }));
  let service: RiskScoringService;
  let scored: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RiskScoringService(
      {} as Ctor[0],
      {} as Ctor[1],
      {} as Ctor[2],
      {} as Ctor[3],
      { findUsersPageForReconciliation } as unknown as Ctor[4],
      { evaluateForRiskScoring } as unknown as Ctor[5],
      {} as Ctor[6],
      {} as Ctor[7],
      {} as Ctor[8],
    );
    scored = [];
    jest.spyOn(service, 'calculateForIdentity').mockImplementation(async (_t, id) => {
      if (id === 'id-3') throw new Error('policy evaluation failed');
      scored.push(id);
      return {} as never;
    });
  });

  it('reports the next identity to score after each one, with the counts so far', async () => {
    const onProgress = jest.fn();

    const result = await service.batchCalculate('tenant-a', 2, NOW, { onProgress });

    expect(result).toEqual({ processed: 4, errors: 1 });
    expect(onProgress.mock.calls.map(([p]) => [p.offset, p.processed, p.errors])).toEqual([
      [1, 1, 0],
      [2, 2, 0],
      [3, 3, 0],
      [4, 3, 1],
      [5, 4, 1],
    ]);
    expect(onProgress.mock.calls[0][0].orgAverage).toBe(1);
  });

  it('resumes from the reported identity with its counts and average, scoring none twice', async () => {
    const onProgress = jest.fn();

    const result = await service.batchCalculate('tenant-a', 2, NOW, {
      resume: { offset: 3, processed: 3, errors: 0, orgAverage: 4 },
      onProgress,
    });

    expect(scored).toEqual(['id-4']);
    expect(result).toEqual({ processed: 4, errors: 1 });
    expect(service.calculateForIdentity).toHaveBeenCalledWith('tenant-a', 'id-4', 4, NOW);
    // The average came with the resume: no identity is evaluated for it again
    expect(evaluateForRiskScoring).not.toHaveBeenCalled();
  });
});
