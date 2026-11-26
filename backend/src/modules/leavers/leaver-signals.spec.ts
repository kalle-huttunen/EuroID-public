import {
  calendarDay,
  dayIsOver,
  evaluateLeaverSignal,
  exceedsMassLeaverLimit,
  leaverEventKey,
  massLeaverAllowance,
} from './leaver-signals';
import { defaultLeaverPolicy, type LeaverPolicySettings } from './leaver-policy.defaults';

const NOW = new Date('2026-11-22T10:00:00Z');

function policy(overrides: Partial<LeaverPolicySettings> = {}): LeaverPolicySettings {
  return { ...defaultLeaverPolicy(), ...overrides };
}

describe('leaver signals', () => {
  describe('terminated status', () => {
    it.each(['terminated', 'Inactive', ' LEFT '])(
      '"%s" is a leaver now when no end date is given',
      (status) => {
        const signal = evaluateLeaverSignal({ hrStatus: status }, policy(), { now: NOW });
        expect(signal).toEqual(expect.objectContaining({ reason: 'terminated' }));
      },
    );

    it('an active or unknown status is not a leaver', () => {
      expect(evaluateLeaverSignal({ hrStatus: 'Active' }, policy(), { now: NOW })).toBeNull();
      expect(evaluateLeaverSignal({ hrStatus: 'on leave' }, policy(), { now: NOW })).toBeNull();
      expect(evaluateLeaverSignal({}, policy(), { now: NOW })).toBeNull();
    });

    it('waits for a future termination date, and fires once that day is over', () => {
      const candidate = { hrStatus: 'terminated', endDate: new Date('2026-11-25') };
      expect(evaluateLeaverSignal(candidate, policy(), { now: NOW })).toBeNull();
      const later = new Date('2026-11-26T00:00:01Z');
      expect(evaluateLeaverSignal(candidate, policy(), { now: later })).toEqual(
        expect.objectContaining({ reason: 'terminated', effectiveDate: candidate.endDate }),
      );
    });

    it('uses the tenant status words, compared case-insensitively', () => {
      const custom = policy({ terminatedStatuses: ['Exited'] });
      expect(evaluateLeaverSignal({ hrStatus: 'exited' }, custom, { now: NOW })?.reason).toBe(
        'terminated',
      );
      expect(evaluateLeaverSignal({ hrStatus: 'terminated' }, custom, { now: NOW })).toBeNull();
    });

    it('is ignored when the signal is switched off', () => {
      const off = policy({
        signals: { terminated: false, endDate: true, missingFromSource: true },
      });
      expect(evaluateLeaverSignal({ hrStatus: 'terminated' }, off, { now: NOW })).toBeNull();
    });
  });

  describe('end date', () => {
    it('fires after the end date, not on it (the end date is the last working day)', () => {
      const onDay = new Date('2026-11-22');
      const dayBefore = new Date('2026-11-21');
      expect(evaluateLeaverSignal({ endDate: onDay }, policy(), { now: NOW })).toBeNull();
      expect(evaluateLeaverSignal({ endDate: dayBefore }, policy(), { now: NOW })).toEqual({
        reason: 'end-date',
        effectiveDate: dayBefore,
        evidence: '2026-11-21',
      });
    });

    it('ends the day in the tenant time zone, not UTC', () => {
      const endDate = new Date('2026-11-20');
      // 22:30 UTC on the 20th is already 00:30 on the 21st in Helsinki (UTC+2).
      const lateEvening = new Date('2026-11-20T22:30:00Z');
      expect(
        evaluateLeaverSignal({ endDate }, policy({ timezone: 'UTC' }), { now: lateEvening }),
      ).toBeNull();
      expect(
        evaluateLeaverSignal({ endDate }, policy({ timezone: 'Europe/Helsinki' }), {
          now: lateEvening,
        })?.reason,
      ).toBe('end-date');
      // ...and New York (UTC-5) is still on the 20th two hours after midnight UTC.
      const nyNight = new Date('2026-11-21T02:00:00Z');
      expect(
        evaluateLeaverSignal({ endDate }, policy({ timezone: 'America/New_York' }), {
          now: nyNight,
        }),
      ).toBeNull();
    });

    it('keeps a date-only value on its own calendar day in any zone', () => {
      const dateOnly = new Date('2026-11-20');
      expect(calendarDay(dateOnly, 'America/New_York')).toBe('2026-11-20');
      expect(calendarDay(dateOnly, 'Asia/Tokyo')).toBe('2026-11-20');
      // A timestamp is read in the zone: 23:30 UTC is the next day in Helsinki.
      expect(calendarDay(new Date('2026-11-20T23:30:00Z'), 'Europe/Helsinki')).toBe('2026-11-21');
      expect(dayIsOver(new Date('2026-11-20T23:30:00Z'), 'Europe/Helsinki', NOW)).toBe(true);
    });

    it('a terminated status outranks the end date as the reason', () => {
      const signal = evaluateLeaverSignal(
        { hrStatus: 'terminated', endDate: new Date('2026-11-01') },
        policy(),
        { now: NOW },
      );
      expect(signal?.reason).toBe('terminated');
    });

    it('ignores an invalid date', () => {
      expect(
        evaluateLeaverSignal({ endDate: new Date('garbage') }, policy(), { now: NOW }),
      ).toBeNull();
    });
  });

  describe('missing from source', () => {
    const cutoff = new Date('2026-11-20T00:00:00Z');

    it('fires only with a cutoff (enough full syncs, this run full)', () => {
      const candidate = { lastSeen: new Date('2026-11-01T00:00:00Z') };
      expect(evaluateLeaverSignal(candidate, policy(), { now: NOW })).toBeNull();
      expect(
        evaluateLeaverSignal(candidate, policy(), { now: NOW, missingCutoff: cutoff }),
      ).toEqual({
        reason: 'missing-from-source',
        effectiveDate: candidate.lastSeen,
        evidence: '2026-11-01T00:00:00.000Z',
      });
    });

    it('a person seen at or after the cutoff is not missing', () => {
      expect(
        evaluateLeaverSignal({ lastSeen: cutoff }, policy(), { now: NOW, missingCutoff: cutoff }),
      ).toBeNull();
    });

    it('is ignored when the signal is switched off', () => {
      const off = policy({
        signals: { terminated: true, endDate: true, missingFromSource: false },
      });
      expect(
        evaluateLeaverSignal({ lastSeen: new Date(0) }, off, { now: NOW, missingCutoff: cutoff }),
      ).toBeNull();
    });
  });

  describe('mass-leaver limit', () => {
    it('defaults: at most 10 leavers or 5% of active identities, the smaller one', () => {
      const p = policy();
      expect(p.massLeaverMaxCount).toBe(10);
      expect(p.massLeaverMaxPercent).toBe(5);
      // 1000 active: 5% = 50, so the count limit (10) wins.
      expect(massLeaverAllowance(p, 1000)).toBe(10);
      expect(exceedsMassLeaverLimit(10, 1000, p)).toBe(false);
      expect(exceedsMassLeaverLimit(11, 1000, p)).toBe(true);
      // 100 active: 5% = 5 wins over 10.
      expect(massLeaverAllowance(p, 100)).toBe(5);
      expect(exceedsMassLeaverLimit(5, 100, p)).toBe(false);
      expect(exceedsMassLeaverLimit(6, 100, p)).toBe(true);
      // 50 active: 5% = 2.5, so a third leaver is "more than 5%".
      expect(exceedsMassLeaverLimit(2, 50, p)).toBe(false);
      expect(exceedsMassLeaverLimit(3, 50, p)).toBe(true);
    });

    it('lets at least 2 leavers through per run, however small the tenant', () => {
      const p = policy();
      expect(p.massLeaverMinCount).toBe(2);
      // 19 active: 5% = 0.95 rounds down to 0, so without the floor every leaver needs approval.
      expect(massLeaverAllowance(p, 19)).toBe(2);
      expect(exceedsMassLeaverLimit(2, 19, p)).toBe(false);
      expect(exceedsMassLeaverLimit(3, 19, p)).toBe(true);
      expect(massLeaverAllowance(p, 0)).toBe(2);
      // 60 active: 5% = 3 is above the floor.
      expect(massLeaverAllowance(p, 60)).toBe(3);
    });

    it('a floor of 0 sends every leaver of a small tenant to approval', () => {
      const p = policy({ massLeaverMinCount: 0 });
      expect(massLeaverAllowance(p, 19)).toBe(0);
      expect(exceedsMassLeaverLimit(1, 19, p)).toBe(true);
    });

    it('follows the tenant settings', () => {
      const p = policy({ massLeaverMaxCount: 100, massLeaverMaxPercent: 50 });
      expect(massLeaverAllowance(p, 40)).toBe(20);
      expect(exceedsMassLeaverLimit(20, 40, p)).toBe(false);
      expect(exceedsMassLeaverLimit(21, 40, p)).toBe(true);
    });
  });

  it('builds one event key per source, reason and evidence', () => {
    const signal = { reason: 'end-date' as const, evidence: '2026-11-21' };
    expect(leaverEventKey('csv-hr', signal)).toBe('csv-hr:end-date:2026-11-21');
  });

  it('makes a departure after a rehire a new event key; never rehired keeps the old key', () => {
    // Same HR status word, no end date: the evidence of both departures is "terminated|"
    const signal = { reason: 'terminated' as const, evidence: 'terminated|' };
    const first = leaverEventKey('csv-hr', signal);
    const rehiredAt = new Date('2026-11-23T09:00:00.000Z');

    expect(leaverEventKey('csv-hr', signal, undefined)).toBe('csv-hr:terminated:terminated|');
    expect(leaverEventKey('csv-hr', signal, rehiredAt)).toBe(
      'csv-hr:terminated:terminated|:rehired:2026-11-23T09:00:00.000Z',
    );
    expect(leaverEventKey('csv-hr', signal, rehiredAt)).not.toBe(first);
  });

  describe('defaults from the environment', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    it('reads limits, words and zone from env, ignoring an unknown zone', () => {
      process.env.LEAVER_MASS_MAX_COUNT = '25';
      process.env.LEAVER_MASS_MAX_PERCENT = '2.5';
      process.env.LEAVER_MISSING_SYNC_THRESHOLD = '5';
      process.env.LEAVER_TERMINATED_STATUSES = 'gone, exited';
      process.env.LEAVER_DEFAULT_TIMEZONE = 'Not/AZone';
      process.env.LEAVER_MASS_MIN_COUNT = '4';
      expect(defaultLeaverPolicy()).toEqual(
        expect.objectContaining({
          massLeaverMaxCount: 25,
          massLeaverMaxPercent: 2.5,
          massLeaverMinCount: 4,
          missingSyncThreshold: 5,
          terminatedStatuses: ['gone', 'exited'],
          timezone: 'UTC',
        }),
      );
    });

    it('never sets the floor above the count limit', () => {
      process.env.LEAVER_MASS_MAX_COUNT = '1';
      process.env.LEAVER_MASS_MIN_COUNT = '5';
      expect(defaultLeaverPolicy()).toEqual(
        expect.objectContaining({ massLeaverMaxCount: 1, massLeaverMinCount: 1 }),
      );
    });
  });
});
