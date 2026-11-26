/**
 * The pure rules of HR mover detection: which trigger attributes differ from the access baseline,
 * when an identity is a mover candidate at all, the change key, and the mass-mover allowance with
 * its floor.
 */
import {
  changeKey,
  hrMoverCandidate,
  moverInputOf,
  triggerAttributeChanges,
  HR_MOVER_ATTRIBUTES,
  type IdentityForHrMover,
} from './hr-mover-changes';
import { defaultMoverPolicy, massMoverAllowance } from './hr-mover-policy.defaults';

const BASELINE = {
  departmentName: 'Sales',
  jobTitle: 'Rep',
  location: 'Helsinki',
  managerEmail: 'boss@corp.example',
  employmentType: 'FULL_TIME',
  costCenter: 'CC-1',
};

function identity(over: Partial<IdentityForHrMover> = {}): IdentityForHrMover {
  return {
    _id: 'id-1',
    profile: { email: 'ada@corp.example', status: 'ACTIVE', ...BASELINE },
    accessBaseline: { attributes: { ...BASELINE } },
    provisioning: [{ targetSystem: 'entra-id', status: 'SYNCED' }],
    ...over,
  };
}

describe('HR mover changes', () => {
  it('compares exactly the four existing trigger attributes', () => {
    expect(HR_MOVER_ATTRIBUTES).toEqual(['departmentName', 'jobTitle', 'location', 'managerEmail']);
  });

  it('reports a moved department with the baseline value as before', () => {
    expect(
      triggerAttributeChanges(BASELINE, { ...BASELINE, departmentName: 'Engineering' }),
    ).toEqual([{ field: 'departmentName', before: 'Sales', after: 'Engineering' }]);
  });

  it('ignores attributes outside the trigger list (employmentType, costCenter)', () => {
    expect(
      triggerAttributeChanges(BASELINE, {
        ...BASELINE,
        employmentType: 'PART_TIME',
        costCenter: 'CC-2',
      }),
    ).toEqual([]);
  });

  it('treats a cleared value as a change to null, and a missing baseline value as null', () => {
    const { location: _gone, ...withoutLocation } = BASELINE;
    expect(triggerAttributeChanges(BASELINE, withoutLocation)).toEqual([
      { field: 'location', before: 'Helsinki', after: null },
    ]);
    expect(triggerAttributeChanges(withoutLocation, BASELINE)).toEqual([
      { field: 'location', before: null, after: 'Helsinki' },
    ]);
  });

  it('lists several changes in trigger-list order', () => {
    const changes = triggerAttributeChanges(BASELINE, {
      ...BASELINE,
      managerEmail: 'new.boss@corp.example',
      departmentName: 'Engineering',
    });
    expect(changes.map((c) => c.field)).toEqual(['departmentName', 'managerEmail']);
    expect(moverInputOf(changes)).toEqual({
      changedFields: ['departmentName', 'managerEmail'],
      previousAttributes: { departmentName: 'Sales', managerEmail: 'boss@corp.example' },
    });
  });

  describe('candidate', () => {
    it('is a candidate when provisioned, active and moved', () => {
      const result = hrMoverCandidate(
        identity({ profile: { email: 'ada@corp.example', ...BASELINE, jobTitle: 'Lead' } }),
      );
      expect(result).toEqual({
        candidate: {
          identityId: 'id-1',
          email: 'ada@corp.example',
          changes: [{ field: 'jobTitle', before: 'Rep', after: 'Lead' }],
        },
      });
    });

    it('is none when access already matches', () => {
      expect(hrMoverCandidate(identity())).toEqual({ reason: expect.stringMatching(/matches/) });
    });

    it('flags a missing baseline (counted, not failed)', () => {
      const result = hrMoverCandidate(
        identity({
          accessBaseline: undefined,
          profile: { email: 'ada@corp.example', ...BASELINE, jobTitle: 'Lead' },
        }),
      );
      expect(result).toEqual(expect.objectContaining({ noBaseline: true }));
    });

    it.each(['TERMINATED', 'SUSPENDED', 'DELETED'])('leaves a %s identity alone', (status) => {
      const result = hrMoverCandidate(
        identity({ profile: { email: 'ada@corp.example', status, ...BASELINE, jobTitle: 'X' } }),
      );
      expect('candidate' in result).toBe(false);
    });

    it('needs a target with an account and an email', () => {
      const moved = { ...BASELINE, jobTitle: 'Lead' };
      expect(
        'candidate' in
          hrMoverCandidate(
            identity({
              profile: { email: 'ada@corp.example', ...moved },
              // Onboarding failed there before an account existed
              provisioning: [{ targetSystem: 'okta', status: 'ERROR' }],
            }),
          ),
      ).toBe(false);
      expect('candidate' in hrMoverCandidate(identity({ profile: moved }))).toBe(false);
    });

    it('is a candidate when its only target is in ERROR after a failed mover run', () => {
      // The rule the mover itself uses (provisionedSystems): provisioned once, until a deprovision
      const result = hrMoverCandidate(
        identity({
          profile: { email: 'ada@corp.example', ...BASELINE, jobTitle: 'Lead' },
          provisioning: [
            { targetSystem: 'okta', status: 'ERROR', provisionedAt: new Date('2026-11-02') },
          ],
        }),
      );
      expect('candidate' in result).toBe(true);
    });
  });

  it('gives the same key for the same changes and another for other values', () => {
    const a = [{ field: 'departmentName', before: 'Sales', after: 'Engineering' }];
    const b = [{ field: 'departmentName', before: 'Sales', after: 'Finance' }];
    expect(changeKey(a)).toBe(changeKey([...a]));
    expect(changeKey(a)).not.toBe(changeKey(b));
    expect(changeKey(a)).not.toContain('Engineering');
  });

  describe('mass-mover allowance', () => {
    const policy = { massMoverMaxCount: 10, massMoverMaxPercent: 5, massMoverMinCount: 2 };

    it.each([
      [0, 2],
      [10, 2],
      [19, 2],
      [59, 2],
      [60, 3],
      [200, 10],
      [10000, 10],
    ])('with %i active identities allows %i', (active, allowed) => {
      expect(massMoverAllowance(policy, active)).toBe(allowed);
    });

    it('a floor of 0 pauses every change in a tiny tenant (the 2.1 leaver behaviour)', () => {
      expect(massMoverAllowance({ ...policy, massMoverMinCount: 0 }, 10)).toBe(0);
    });

    it('defaults to 10, 5 % and a floor of 2', () => {
      expect(defaultMoverPolicy()).toEqual(policy);
    });

    it('reads the defaults from the environment, the floor never above the count', () => {
      process.env.MOVER_MASS_MAX_COUNT = '2';
      process.env.MOVER_MASS_MAX_PERCENT = '150';
      process.env.MOVER_MASS_MIN_COUNT = '5';
      try {
        expect(defaultMoverPolicy()).toEqual({
          massMoverMaxCount: 2,
          massMoverMaxPercent: 5,
          massMoverMinCount: 2,
        });
      } finally {
        delete process.env.MOVER_MASS_MAX_COUNT;
        delete process.env.MOVER_MASS_MAX_PERCENT;
        delete process.env.MOVER_MASS_MIN_COUNT;
      }
    });
  });
});
