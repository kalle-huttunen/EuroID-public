/**
 * Contract-critical fields always come from the primary HR contract (owner decision 2026-11-24):
 * a mastery setting naming a secondary HR source or a target for one of them used to be accepted
 * and then ignored by reconcile. The saves refuse it with these problems and this message.
 */
import {
  configuredPrimaryHrSource,
  contractCriticalMasteryMessage,
  contractCriticalMasteryProblems,
  sourceMasterySetting,
} from './contract-critical-mastery';

describe('configuredPrimaryHrSource', () => {
  it('takes the connector tagged PRIMARY over a higher-priority untagged one', () => {
    expect(
      configuredPrimaryHrSource(
        [
          { name: 'json-api-hr', ingestPriority: 1, contractTag: 'SECONDARY' },
          { name: 'csv-hr', ingestPriority: 2, contractTag: 'PRIMARY' },
        ],
        ['csv-hr', 'json-api-hr'],
        [],
      ),
    ).toBe('csv-hr');
  });

  it('orders two PRIMARY connectors by ingest priority, then the Recon Config source priority', () => {
    const both = (a: number, b: number) => [
      { name: 'csv-hr', ingestPriority: a, contractTag: 'PRIMARY' },
      { name: 'json-api-hr', ingestPriority: b, contractTag: 'PRIMARY' },
    ];
    expect(configuredPrimaryHrSource(both(2, 1), [], [])).toBe('json-api-hr');
    expect(configuredPrimaryHrSource(both(1, 1), [], ['json-api-hr', 'csv-hr'])).toBe(
      'json-api-hr',
    );
  });

  it('without connector settings takes the first HR source tag in the source priority', () => {
    expect(configuredPrimaryHrSource([], ['csv-hr', 'workday'], ['workday', 'csv-hr'])).toBe(
      'workday',
    );
  });
});

describe('contractCriticalMasteryProblems', () => {
  const critical = ['departmentName', 'jobTitle'];

  it('names each entry of a contract-critical field that names a secondary HR source or a target', () => {
    expect(
      contractCriticalMasteryProblems(
        [
          {
            label: 'Default mastery',
            entries: { departmentName: ['csv-hr', 'json-api-hr'], email: ['entra-id'] },
          },
          { label: 'Field Mastery', entries: { jobTitle: ['entra-id'] } },
        ],
        critical,
        'csv-hr',
      ),
    ).toEqual([
      'Default mastery: departmentName names json-api-hr',
      'Field Mastery: jobTitle names entra-id',
    ]);
  });

  it('accepts an entry naming the primary, and entries of other fields', () => {
    expect(
      contractCriticalMasteryProblems(
        [{ label: 'Default mastery', entries: { departmentName: ['CSV-HR'], email: ['okta'] } }],
        critical,
        'csv-hr',
      ),
    ).toEqual([]);
  });

  it("checks an HR source node's mastery fields as entries naming that source", () => {
    const setting = sourceMasterySetting({ name: 'json-api-hr', masteryFields: ['jobTitle'] });

    expect(contractCriticalMasteryProblems([setting], critical, 'csv-hr')).toEqual([
      'Field Mastery of source json-api-hr: jobTitle names json-api-hr',
    ]);
  });
});

describe('contractCriticalMasteryMessage', () => {
  it('says what is refused, which source is primary, and to choose it by Contract Tag and priority', () => {
    const message = contractCriticalMasteryMessage(
      ['Field Mastery: jobTitle names entra-id'],
      'csv-hr',
    );
    expect(message).toContain('Field Mastery: jobTitle names entra-id.');
    expect(message).toContain('the primary HR contract (now csv-hr)');
    expect(message).toContain('Contract Tag and ingest priority');
  });
});
