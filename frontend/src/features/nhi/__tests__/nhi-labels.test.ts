/**
 * The backend rules the page mirrors: the expiry limits of create and delegate, and which actions
 * an agent's status allows. Who a revoke reaches is the API's dry run, not computed here.
 */
import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import {
  delegateBlocker,
  expiryProblem,
  issueBlocker,
  killBlocker,
  ownerProblem,
  revokeBlocker,
} from '../nhi-labels';
import { expiredWorkload, killedBot, oldExporter, payrollBot } from './NhiPage.fixtures';

describe('expiryProblem', () => {
  const now = dayjs('2026-11-24T12:00:00Z');

  it('takes a future date at most 90 days away', () => {
    expect(expiryProblem(now.add(90, 'day'), now)).toBeUndefined();
    expect(expiryProblem(now.subtract(1, 'minute'), now)).toBe('The expiry must be in the future');
    expect(expiryProblem(now.add(91, 'day'), now)).toBe('At most 90 days from now');
    expect(expiryProblem(null, now)).toBe('Choose when the agent expires');
  });

  it('keeps a delegated agent within its parent’s expiry', () => {
    const parent = now.add(10, 'day').toISOString();
    expect(expiryProblem(now.add(10, 'day'), now, parent)).toBeUndefined();
    expect(expiryProblem(now.add(11, 'day'), now, parent)).toMatch(
      /^No later than the parent's expiry/,
    );
  });
});

describe('action rules', () => {
  it('lets only an active agent delegate or get a credential', () => {
    expect(delegateBlocker(payrollBot)).toBeUndefined();
    expect(delegateBlocker(expiredWorkload)).toMatch(/this one is expired/);
    expect(issueBlocker(payrollBot, true)).toBeUndefined();
    expect(issueBlocker(payrollBot, undefined)).toBeUndefined();
    expect(issueBlocker(payrollBot, false)).toMatch(/signing is not configured/);
    expect(issueBlocker(expiredWorkload, true)).toMatch(/expired/);
    expect(issueBlocker(killedBot, true)).toMatch(/kill switch is engaged/);
  });

  it('revokes anything not yet revoked; the kill switch needs only that it is not engaged yet', () => {
    expect(revokeBlocker(expiredWorkload)).toBeUndefined();
    expect(revokeBlocker(oldExporter)).toMatch(/already revoked/);
    expect(killBlocker(expiredWorkload)).toBeUndefined();
    // The API engages it on a revoked agent too: flag, critical audit entry, kill signal
    expect(killBlocker(oldExporter)).toBeUndefined();
    expect(killBlocker(killedBot)).toMatch(/already engaged/);
  });

  it('refuses an owner whose status is not ACTIVE, as the API does', () => {
    expect(ownerProblem({ id: '1', status: 'ACTIVE' })).toBeUndefined();
    expect(ownerProblem({ id: '1' })).toBeUndefined();
    expect(ownerProblem({ id: '1', status: 'SUSPENDED' })).toBe('not active (SUSPENDED)');
  });
});
