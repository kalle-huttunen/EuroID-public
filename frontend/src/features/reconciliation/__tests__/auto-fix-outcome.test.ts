import { describe, it, expect } from 'vitest';
import { autoFixOutcome } from '../auto-fix-outcome';

describe('autoFixOutcome', () => {
  it('is a success when every chosen drift was corrected', () => {
    expect(autoFixOutcome({ corrected: 3, failed: 0, failures: [] }, 3)).toEqual({
      level: 'success',
      text: 'Auto-Fix corrected 3 drifts.',
    });
    expect(autoFixOutcome({ corrected: 1, failed: 0, failures: [] }, 1).text).toBe(
      'Auto-Fix corrected 1 drift.',
    );
  });

  it('warns with the reason when nothing was corrected', () => {
    const failure = { driftId: 'd1', error: 'The user was not found in entra-id.' };
    expect(
      autoFixOutcome(
        { corrected: 0, failed: 2, failures: [failure, { ...failure, driftId: 'd2' }] },
        2,
      ),
    ).toEqual({
      level: 'warning',
      text: 'Auto-Fix corrected 0 of 2 drifts. Not corrected: 2. Reason: The user was not found in entra-id.',
    });
  });

  it('names the first reason as the first when the drifts have different ones', () => {
    const outcome = autoFixOutcome(
      {
        corrected: 1,
        failed: 2,
        failures: [
          { driftId: 'd2', error: 'Unsupported drift type: GROUP_MISMATCH' },
          { driftId: 'd3', error: 'Drift d3 not found' },
        ],
      },
      3,
    );
    expect(outcome).toEqual({
      level: 'warning',
      text: 'Auto-Fix corrected 1 of 3 drifts. Not corrected: 2. First reason: Unsupported drift type: GROUP_MISMATCH.',
    });
  });

  it('warns without a reason when the answer names none', () => {
    // An answer without the counts (an older API) reads as nothing corrected.
    expect(autoFixOutcome({}, 2)).toEqual({
      level: 'warning',
      text: 'Auto-Fix corrected 0 of 2 drifts. Not corrected: 2.',
    });
  });
});
