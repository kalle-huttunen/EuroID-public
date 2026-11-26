import { PII_FIELDS } from '../../modules/identity/identity-pii';
import {
  ACCESS_BASELINE_EXCLUDED_KEYS,
  accessBaselineChanges,
  appliedAttributes,
  changedAccessAttributes,
  toAccessBaseline,
} from './access-baseline';

describe('access baseline', () => {
  it('never keeps the PII fields the API masks', () => {
    expect(ACCESS_BASELINE_EXCLUDED_KEYS).toEqual(expect.arrayContaining([...PII_FIELDS]));
  });

  it('keeps the attributes policies read and leaves names, contact data and bookkeeping out', () => {
    const baseline = toAccessBaseline({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@acme.test',
      mobilePhone: '+358 40 123 4567',
      userPrincipalName: 'ada@acme.onmicrosoft.com',
      sourceSystem: 'csv-hr',
      departmentName: 'Engineering',
      jobTitle: 'Engineer',
      costCenter: 'CC-7',
      customAttributes: { clearance: 'L2' },
      contracts: [{ id: 'c-1', title: 'Engineer', department: 'Engineering' }],
      endDate: undefined,
    });

    expect(baseline).toEqual({
      departmentName: 'Engineering',
      jobTitle: 'Engineer',
      costCenter: 'CC-7',
      customAttributes: { clearance: 'L2' },
      contracts: [{ id: 'c-1', title: 'Engineer', department: 'Engineering' }],
    });
  });

  describe('changes since the baseline', () => {
    it('gives each changed attribute its baseline value, null when the baseline had none', () => {
      expect(
        accessBaselineChanges(
          { departmentName: 'Sales', location: 'Espoo', division: 'Ops' },
          { departmentName: 'Engineering', location: 'Espoo', costCenter: 'CC-7' },
        ),
      ).toEqual({ departmentName: 'Sales', division: 'Ops', costCenter: null });
    });

    it('a Date and its ISO string, null and a missing value, and key order count as unchanged', () => {
      expect(
        accessBaselineChanges(
          {
            startDate: '2026-01-01T00:00:00.000Z',
            endDate: null,
            customAttributes: { a: 1, b: 2 },
          },
          { startDate: new Date('2026-01-01T00:00:00Z'), customAttributes: { b: 2, a: 1 } },
        ),
      ).toEqual({});
    });

    it('sees a change inside contracts and custom attributes', () => {
      expect(
        accessBaselineChanges(
          { contracts: [{ id: 'c-1', department: 'Sales' }], customAttributes: { tier: 1 } },
          { contracts: [{ id: 'c-1', department: 'Engineering' }], customAttributes: { tier: 2 } },
        ),
      ).toEqual({
        contracts: [{ id: 'c-1', department: 'Sales' }],
        customAttributes: { tier: 1 },
      });
    });

    it('ignores excluded keys on either side', () => {
      expect(accessBaselineChanges({ email: 'a@x.test' }, { email: 'b@x.test' })).toEqual({});
    });
  });

  it('applied attributes are the evaluated values of the changed fields, null when empty', () => {
    expect(
      appliedAttributes({ departmentName: 'Engineering', email: 'ada@acme.test' }, [
        'departmentName',
        'location',
        'email',
      ]),
    ).toEqual({ departmentName: 'Engineering', location: null });
  });

  // identity.updated previousAttributes: the "before" of an edit for the mover
  it('changed access attributes of an edit: before-values of the edited fields that changed', () => {
    const before = {
      firstName: 'Ada',
      email: 'ada@acme.test',
      employeeId: 'E1',
      departmentName: 'Sales',
      jobTitle: 'Analyst',
      managerEmail: 'old.boss@acme.test',
    };
    const after = {
      ...before,
      firstName: 'Augusta',
      email: 'augusta@acme.test',
      employeeId: 'E2',
      departmentName: 'Finance',
      managerEmail: 'new.boss@acme.test',
      location: 'Helsinki',
    };
    const fields = [
      'firstName',
      'email',
      'employeeId',
      'departmentName',
      'jobTitle',
      'managerEmail',
      'location',
    ];

    // jobTitle was sent unchanged; names and identifiers stay out; location had no value
    expect(changedAccessAttributes(before, after, fields)).toEqual({
      departmentName: 'Sales',
      managerEmail: 'old.boss@acme.test',
      location: null,
    });
    // A field the edit did not name is not compared
    expect(changedAccessAttributes(before, after, ['jobTitle'])).toEqual({});
  });
});
