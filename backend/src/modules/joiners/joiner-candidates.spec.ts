import { joinerState, type IdentityForJoiner, type JoinerRuleContext } from './joiner-candidates';
import { defaultJoinerPolicy, massJoinerAllowance } from './joiner-policy.defaults';

const NOW = new Date('2026-11-23T10:00:00.000Z');
const RUN_START = new Date('2026-11-23T09:59:00.000Z');

function ctx(overrides: Partial<JoinerRuleContext> = {}): JoinerRuleContext {
  return {
    sourceName: 'csv-hr',
    now: NOW,
    timezone: 'Europe/Helsinki',
    terminatedStatuses: ['terminated', 'inactive', 'left'],
    hasLeaverEvent: false,
    deliveredSince: RUN_START,
    ...overrides,
  };
}

/** A freshly minted HR identity, delivered by this run; `raw` is its csv-hr record. */
function minted(
  raw: Record<string, unknown> = {},
  overrides: Partial<IdentityForJoiner> = {},
): IdentityForJoiner {
  return {
    _id: 'id-1',
    deletedAt: null,
    profile: { email: 'ada@acme.test', status: 'ACTIVE' },
    provisioning: [],
    sources: [
      {
        sourceName: 'csv-hr',
        lastSync: new Date('2026-11-23T09:59:30.000Z'),
        rawData: { status: 'ACTIVE', customAttributes: { hrStatus: 'Active' }, ...raw },
      },
    ],
    ...overrides,
  };
}

describe('joinerState', () => {
  it('is due for an active person the run delivered, with the email to onboard', () => {
    expect(joinerState(minted(), ctx())).toEqual({ due: true, email: 'ada@acme.test' });
  });

  it('is due on the start date itself and after it', () => {
    expect(joinerState(minted({ startDate: new Date('2026-11-23') }), ctx())).toEqual(
      expect.objectContaining({ due: true }),
    );
    expect(joinerState(minted({ startDate: '2026-11-01' }), ctx())).toEqual(
      expect.objectContaining({ due: true }),
    );
  });

  it('waits for a start date ahead, read as a calendar day in the policy zone', () => {
    expect(joinerState(minted({ startDate: new Date('2026-11-24') }), ctx())).toEqual({
      wait: 'start-date',
      reason: 'The start date is 2026-11-24.',
    });
    // 23:30 UTC on the 23rd is already the 24th in Helsinki
    expect(joinerState(minted({ startDate: new Date('2026-11-23T23:30:00.000Z') }), ctx())).toEqual(
      expect.objectContaining({ wait: 'start-date' }),
    );
    expect(
      joinerState(
        minted({ startDate: new Date('2026-11-23T23:30:00.000Z') }),
        ctx({ timezone: 'UTC' }),
      ),
    ).toEqual(expect.objectContaining({ due: true }));
  });

  it('waits while the start date is unreadable, until a sync reads a date', () => {
    const unreadable = { customAttributes: { startDateUnreadable: '31.13.2026' } };
    expect(joinerState(minted(unreadable), ctx())).toEqual({
      wait: 'start-date-unreadable',
      reason: 'Start date unreadable: the HR record\'s start date "31.13.2026" is not a date.',
    });
    // Not even at a batch approval: onboarding at once would give access before the start
    expect(joinerState(minted(unreadable), ctx({ deliveredSince: undefined }))).toEqual(
      expect.objectContaining({ wait: 'start-date-unreadable' }),
    );
    // A later sync reads a date: the start date rules apply again
    expect(joinerState(minted({ startDate: '2026-11-01' }), ctx())).toEqual(
      expect.objectContaining({ due: true }),
    );
  });

  it('waits when the full sync did not deliver the person, but not at a batch approval', () => {
    const stale = minted();
    stale.sources![0].lastSync = new Date('2026-11-20T09:00:00.000Z');
    expect(joinerState(stale, ctx())).toEqual(expect.objectContaining({ wait: 'not-delivered' }));
    expect(joinerState(stale, ctx({ deliveredSince: undefined }))).toEqual(
      expect.objectContaining({ due: true }),
    );
  });

  it('waits while the identity is suspended or inactive', () => {
    for (const status of ['SUSPENDED', 'INACTIVE']) {
      expect(
        joinerState(minted({}, { profile: { email: 'ada@acme.test', status } }), ctx()),
      ).toEqual(expect.objectContaining({ wait: 'inactive' }));
    }
  });

  it.each([
    ['the identity is gone', null, {}, /deleted/],
    ['the identity is soft-deleted', minted({}, { deletedAt: NOW }), {}, /deleted/],
    [
      'onboarding already recorded a target',
      minted({}, { provisioning: [{ targetSystem: 'entra-id', status: 'PENDING' }] }),
      {},
      /already onboarded/,
    ],
    [
      'the Golden Record is TERMINATED',
      minted({}, { profile: { email: 'ada@acme.test', status: 'TERMINATED' } }),
      {},
      /TERMINATED/,
    ],
    [
      'HR marks the person as left in the same export',
      minted({ customAttributes: { hrStatus: 'Terminated' } }),
      {},
      /left \(status "terminated"\)/,
    ],
    [
      'the HR status word is left even with an end date ahead',
      minted({ customAttributes: { hrStatus: 'Left' }, endDate: '2026-12-31' }),
      {},
      /left/,
    ],
    ['the end date is over', minted({ endDate: '2026-11-22' }), {}, /ended in HR \(2026-11-22\)/],
    ['an HR leaver event exists', minted(), { hasLeaverEvent: true }, /leaver event/],
    ['there is no email', minted({}, { profile: { status: 'ACTIVE' } }), {}, /no email/],
  ])('closes when %s', (_label, identity, overrides, reason) => {
    const state = joinerState(identity as IdentityForJoiner | null, ctx(overrides));
    expect('close' in state && state.close).toMatch(reason);
  });

  describe('a rehire (the sync revived a deleted identity)', () => {
    const REHIRED_AT = new Date('2026-11-23T09:59:20.000Z');
    const deprovisioned = (lastSync?: string) => ({
      targetSystem: 'entra-id',
      status: 'DEPROVISIONED',
      ...(lastSync ? { lastSync: new Date(lastSync) } : {}),
    });

    it('is due although its earlier employment left deprovisioned targets', () => {
      const rehire = minted(
        {},
        { provisioning: [deprovisioned('2026-03-01T12:00:00.000Z'), deprovisioned()] },
      );
      expect(joinerState(rehire, ctx({ rehiredAt: REHIRED_AT }))).toEqual({
        due: true,
        email: 'ada@acme.test',
      });
    });

    it('closes once it is onboarded since the rehire, or a target was removed since', () => {
      for (const entry of [
        { targetSystem: 'okta', status: 'SYNCING' },
        deprovisioned('2026-11-23T09:59:40.000Z'),
      ]) {
        const rehire = minted({}, { provisioning: [deprovisioned('2026-03-01'), entry] });
        const state = joinerState(rehire, ctx({ rehiredAt: REHIRED_AT }));
        expect('close' in state && state.close).toMatch(/already onboarded/);
      }
    });

    it('a first hire still counts a deprovisioned target as onboarded', () => {
      const state = joinerState(minted({}, { provisioning: [deprovisioned('2026-03-01')] }), ctx());
      expect('close' in state && state.close).toMatch(/already onboarded/);
    });
  });

  it('keeps an end date that is not over yet: the person still joins', () => {
    expect(joinerState(minted({ endDate: '2026-11-23' }), ctx())).toEqual(
      expect.objectContaining({ due: true }),
    );
  });

  it("reads the joiner's own source record, not another source's", () => {
    const identity = minted();
    identity.sources!.push({
      sourceName: 'json-api-hr',
      rawData: { customAttributes: { hrStatus: 'Terminated' } },
    });
    expect(joinerState(identity, ctx())).toEqual(expect.objectContaining({ due: true }));
  });
});

describe('massJoinerAllowance', () => {
  const defaults = { massJoinerMaxCount: 10, massJoinerMaxPercent: 5, massJoinerMinCount: 2 };

  it.each([
    [3, 2],
    [59, 2],
    [60, 3],
    [199, 9],
    [200, 10],
    [5000, 10],
  ])('allows max(2, min(10, 5 %% of %i)) = %i', (active, allowed) => {
    expect(massJoinerAllowance(defaults, active)).toBe(allowed);
  });

  it('pauses every joiner with a floor and count of 0', () => {
    expect(
      massJoinerAllowance(
        { massJoinerMaxCount: 0, massJoinerMaxPercent: 5, massJoinerMinCount: 0 },
        1000,
      ),
    ).toBe(0);
  });

  it('reads the defaults from the environment, the floor never above the count', () => {
    const saved = { ...process.env };
    try {
      process.env.JOINER_MASS_MAX_COUNT = '3';
      process.env.JOINER_MASS_MAX_PERCENT = '20';
      process.env.JOINER_MASS_MIN_COUNT = '7';
      expect(defaultJoinerPolicy()).toEqual({
        massJoinerMaxCount: 3,
        massJoinerMaxPercent: 20,
        massJoinerMinCount: 3,
      });
      process.env.JOINER_MASS_MAX_PERCENT = '150';
      expect(defaultJoinerPolicy().massJoinerMaxPercent).toBe(5);
    } finally {
      process.env = saved;
    }
  });
});
