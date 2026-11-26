import { describe, it, expect } from 'vitest';
import { omitUnchangedPiiFields, withoutPiiFields } from '../pii-fields';

// As returned by GET /identity: PII fields masked.
const fromApi = {
  firstName: 'Ada',
  jobTitle: 'Analyst',
  personalEmail: 'a•••@home.example',
  mobilePhone: '+358 •• ••• 4567',
  workPhone: '+358 • •••• 4321',
};

describe('omitUnchangedPiiFields', () => {
  it('never sends a masked value back, but keeps a PII field edited after a reveal', () => {
    const values = { ...fromApi, jobTitle: 'Lead', mobilePhone: '+358 50 999 0000' };

    expect(omitUnchangedPiiFields(values, fromApi)).toEqual({
      firstName: 'Ada',
      jobTitle: 'Lead',
      mobilePhone: '+358 50 999 0000',
    });
  });
});

describe('withoutPiiFields', () => {
  it('drops every PII field and keeps the rest', () => {
    expect(withoutPiiFields(fromApi)).toEqual({ firstName: 'Ada', jobTitle: 'Analyst' });
  });
});
