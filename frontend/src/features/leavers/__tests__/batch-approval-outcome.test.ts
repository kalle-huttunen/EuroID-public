import { describe, it, expect } from 'vitest';
import { approvalOutcome } from '../batch-approval-outcome';

describe('approvalOutcome', () => {
  it('is a success when every member started', () => {
    expect(
      approvalOutcome({ identityCount: 3, startedCount: 3, items: [] }, 'onboarding run'),
    ).toEqual({ level: 'success', text: 'Started 3 onboarding runs' });
    expect(
      approvalOutcome({ identityCount: 1, startedCount: 1, items: [] }, 'offboarding'),
    ).toEqual({ level: 'success', text: 'Started 1 offboarding' });
  });

  it('warns with the start error when nothing started', () => {
    const failed = { startError: 'Temporal is not connected.' };
    expect(
      approvalOutcome(
        { identityCount: 3, startedCount: 0, items: [failed, failed, failed] },
        'onboarding run',
      ),
    ).toEqual({
      level: 'warning',
      text: 'Started 0 of 3 onboarding runs. Not started: 3. Reason: Temporal is not connected. The batch history shows each one.',
    });
  });

  it('warns with why a member was closed when only some started', () => {
    const closed = { closeReason: 'HR marks the person as left (status "terminated")' };
    expect(
      approvalOutcome({ identityCount: 3, startedCount: 2, items: [{}, {}, closed] }, 'mover run'),
    ).toEqual({
      level: 'warning',
      text: 'Started 2 of 3 mover runs. Not started: 1. Reason: HR marks the person as left (status "terminated"). The batch history shows each one.',
    });
  });

  it('names the first reason as the first when members have different ones', () => {
    const outcome = approvalOutcome(
      {
        identityCount: 2,
        startedCount: 0,
        items: [{ closeReason: 'The identity was deleted' }, { startError: 'Temporal is down' }],
      },
      'onboarding run',
    );
    // A start that failed is what the admin can act on, so it comes before a closed member.
    expect(outcome.text).toBe(
      'Started 0 of 2 onboarding runs. Not started: 2. First reason: Temporal is down. The batch history shows each one.',
    );
  });

  it('warns without a reason when the answer names none', () => {
    expect(
      approvalOutcome({ identityCount: 2, startedCount: 1, items: [{}, {}] }, 'offboarding'),
    ).toEqual({
      level: 'warning',
      text: 'Started 1 of 2 offboardings. Not started: 1. The batch history shows each one.',
    });
  });

  it('counts a missing started count as none started', () => {
    expect(approvalOutcome({ identityCount: 2, items: [] }, 'mover run').level).toBe('warning');
  });

  // A leaver batch answers before its offboardings start: its members are still queued
  it('says the offboardings are starting when the answer comes before they start', () => {
    const queued = { status: 'queued' };
    expect(
      approvalOutcome({ identityCount: 3, items: [queued, queued, queued] }, 'offboarding'),
    ).toEqual({
      level: 'success',
      text: 'Starting 3 offboardings. The batch history shows each one as it starts, or why it does not.',
    });
  });

  it('counts waiting joiners and pending movers in an approve answer as starting', () => {
    const waiting = { status: 'waiting' };
    expect(
      approvalOutcome({ identityCount: 2, items: [waiting, waiting] }, 'onboarding run'),
    ).toEqual({
      level: 'success',
      text: 'Starting 2 onboarding runs. The batch history shows each one as it starts, or why it does not.',
    });
    const pending = { status: 'pending-approval' };
    const gone = { status: 'superseded', closeReason: 'The identity was deleted.' };
    expect(approvalOutcome({ identityCount: 2, items: [pending, gone] }, 'mover run')).toEqual({
      level: 'warning',
      text: 'Starting 1 of 2 mover runs. Not started: 1. Reason: The identity was deleted. The batch history shows each one.',
    });
  });

  it('warns about a member closed at approval while the others are starting', () => {
    const queued = { status: 'queued' };
    const back = {
      status: 'superseded',
      closeReason: 'Back in the HR feed when the batch was approved',
    };
    expect(
      approvalOutcome({ identityCount: 3, items: [queued, queued, back] }, 'offboarding'),
    ).toEqual({
      level: 'warning',
      text: 'Starting 2 of 3 offboardings. Not started: 1. Reason: Back in the HR feed when the batch was approved. The batch history shows each one.',
    });
  });

  it('never counts a queued member whose start failed as starting', () => {
    const failed = { status: 'queued', startError: 'Temporal is not connected.' };
    expect(
      approvalOutcome({ identityCount: 2, items: [{ status: 'queued' }, failed] }, 'offboarding'),
    ).toEqual({
      level: 'warning',
      text: 'Starting 1 of 2 offboardings. Not started: 1. Reason: Temporal is not connected. The batch history shows each one.',
    });
  });
});
