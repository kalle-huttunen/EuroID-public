import { redactBulkResults } from './bulk-result-redaction';

describe('redactBulkResults', () => {
  it('drops pre-change attribute values recorded in older results and masks PII fields', () => {
    const result = {
      batchId: 'b-1',
      results: [
        {
          email: 'ada@example.com',
          systemResults: [
            {
              system: 'entra-id',
              previousState: {
                existed: true,
                objectId: 'obj-1',
                attributes: { mobilePhone: '+358 40 765 4321', surname: 'Lovelace' },
              },
            },
          ],
          user: { mobilePhone: '+358 40 765 4321' },
        },
      ],
    };

    const redacted = redactBulkResults(result);

    expect(JSON.stringify(redacted)).not.toContain('765 4321');
    expect(JSON.stringify(redacted)).not.toContain('Lovelace');
    expect(redacted.results[0].systemResults[0].previousState).toEqual({
      existed: true,
      objectId: 'obj-1',
    });
    expect(redacted.results[0].user.mobilePhone).toBe('+358 •• ••• 4321');
    expect(redacted.results[0].email).toBe('ada@example.com');
  });

  it('keeps the snapshot reference of new results', () => {
    const previousState = { existed: true, objectId: 'obj-1', snapshotRef: 'snap-1' };

    expect(redactBulkResults([{ systemResults: [{ previousState }] }])).toEqual([
      { systemResults: [{ previousState }] },
    ]);
  });
});
