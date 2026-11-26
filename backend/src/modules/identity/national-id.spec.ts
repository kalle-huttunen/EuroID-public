/**
 * Which keys of an incoming record hold the national ID, and how they are removed (national-id.ts).
 */
import {
  mayCarryNationalId,
  nationalIdKeys,
  nationalIdRule,
  nationalIdValue,
  removeNationalIds,
  takeNationalId,
} from './national-id';

describe('national ID keys of a record', () => {
  it('removes the rule field and hetu, also without a rule (hetu always)', () => {
    const rule = nationalIdRule({
      rules: [
        { strategy: 'email' },
        { strategy: 'hashedNationalId', nationalIdSourceField: 'ssn' },
      ],
    });

    expect(nationalIdKeys(rule)).toEqual(['ssn', 'hetu']);
    expect(nationalIdKeys(nationalIdRule({ rules: [{ strategy: 'hashedNationalId' }] }))).toEqual([
      'hetu',
    ]);
    expect(nationalIdKeys(nationalIdRule({ rules: [{ strategy: 'email' }] }))).toEqual(['hetu']);
  });

  it('reads the field itself before customAttributes', () => {
    expect(nationalIdValue({ hetu: 'A', customAttributes: { hetu: 'B' } }, 'hetu')).toBe('A');
    expect(nationalIdValue({ customAttributes: { ssn: 123 } }, 'ssn')).toBe('123');
    expect(nationalIdValue({}, 'hetu')).toBe('');
  });

  it('removes the keys from the record and its customAttributes without changing the shared object', () => {
    const customAttributes = { hetu: '131085-999X', site: 'HQ' };
    const record: Record<string, unknown> = {
      email: 'a@corp.example',
      hetu: 'x',
      customAttributes,
    };

    expect(removeNationalIds(record, ['hetu'])).toBe(true);

    expect(record).toEqual({ email: 'a@corp.example', customAttributes: { site: 'HQ' } });
    expect(customAttributes).toEqual({ hetu: '131085-999X', site: 'HQ' });
  });

  it('leaves customAttributes out when the national ID was all it held', () => {
    const record: Record<string, unknown> = { customAttributes: { hetu: 'x' } };

    removeNationalIds(record, ['hetu']);

    expect(record).toEqual({});
  });

  it('never removes a StandardUserDto field from the top level, only from customAttributes', () => {
    const record: Record<string, unknown> = {
      email: 'a@corp.example',
      employeeNumber: 'E-1',
      customAttributes: { email: 'x', employeeNumber: 'y' },
    };

    removeNationalIds(record, ['email', 'employeeNumber']);

    expect(record).toEqual({ email: 'a@corp.example', employeeNumber: 'E-1' });
  });

  it('reports a record without the keys as unchanged', () => {
    const record: Record<string, unknown> = { email: 'a@corp.example', customAttributes: { a: 1 } };

    expect(removeNationalIds(record, ['hetu'])).toBe(false);
    expect(record).toEqual({ email: 'a@corp.example', customAttributes: { a: 1 } });
  });

  it('takes the value out and hashes it under the rule, dropping a correlationId the record brings', () => {
    const rule = nationalIdRule({
      rules: [{ strategy: 'hashedNationalId', nationalIdSourceField: 'ssn' }],
    });
    const record: Record<string, unknown> = {
      correlationId: 'forged',
      customAttributes: { ssn: '131085-999X', hetu: 'x', site: 'HQ' },
    };

    expect(takeNationalId(record, rule, (v) => `hash(${v})`)).toBe('hash(131085-999X)');
    expect(record).toEqual({ customAttributes: { site: 'HQ' } });
  });

  it('without the rule removes hetu, hashes nothing and keeps the correlationId', () => {
    const record: Record<string, unknown> = {
      correlationId: 'id-1',
      customAttributes: { hetu: 'x' },
    };
    const hash = jest.fn();

    expect(takeNationalId(record, undefined, hash)).toBeNull();
    expect(record).toEqual({ correlationId: 'id-1' });
    expect(hash).not.toHaveBeenCalled();
  });

  it('tells which records can hold a national ID or a correlationId', () => {
    expect(mayCarryNationalId({ jobTitle: 'Lead', email: 'a@corp.example' })).toBe(false);
    expect(mayCarryNationalId({ customAttributes: {} })).toBe(true);
    expect(mayCarryNationalId({ correlationId: 'h' })).toBe(true);
    expect(mayCarryNationalId({ henkilotunnus: 'x' })).toBe(true);
  });
});
