import { Types } from 'mongoose';
import {
  findMaskedPiiFields,
  maskEmail,
  maskLogin,
  maskPiiAndPhonesDeep,
  maskPiiDeep,
  maskPiiValue,
  PII_MASK_CHAR,
} from './identity-pii';

describe('maskPiiValue', () => {
  it.each([
    ['personalEmail', 'matti.meikalainen@example.com', 'm•••@example.com'],
    ['personalEmail', 'no-at-sign', '•••'],
    ['mobilePhone', '+358 40 123 4567', '+358 •• ••• 4567'],
    ['mobilePhone', '040-123 4567', '•••-••• 4567'],
    ['workPhone', '+358401234567', '+••••••••4567'],
    ['workPhone', '+1 555 1234', '+1 ••• ••••'],
    ['workPhone', 'call me 0401234567', '•••• •• ••••••4567'],
    ['officeExtension', '4567', '••••'],
  ] as const)('%s %s -> %s', (field, value, expected) => {
    expect(maskPiiValue(field, value)).toBe(expected);
  });

  it('never returns a phone number in clear, whatever its format', () => {
    for (const phone of ['+358 40 123 4567', '0401234567', '12345', '(09) 123-4567']) {
      const masked = String(maskPiiValue('mobilePhone', phone));
      expect(masked).not.toBe(phone);
      expect(masked).toContain(PII_MASK_CHAR);
    }
  });

  it('leaves empty values empty and masks non-string values', () => {
    expect(maskPiiValue('mobilePhone', undefined)).toBeUndefined();
    expect(maskPiiValue('mobilePhone', null)).toBeNull();
    expect(maskPiiValue('mobilePhone', '')).toBe('');
    expect(maskPiiValue('officeExtension', 4567)).toBe('••••');
    expect(maskPiiValue('personalEmail', { nested: 'x@example.com' })).toBe('•••');
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('anna.approver@example.com')).toBe('a•••@example.com');
  });

  it('masks a missing value instead of throwing, so a log line cannot fail its caller', () => {
    // Untyped documents (lean reads, `as` casts) can reach a log line without the field
    expect(maskEmail(undefined as unknown as string)).toBe('•••');
    expect(maskEmail(null as unknown as string)).toBe('•••');
    expect(maskEmail('')).toBe('•••');
  });
});

describe('maskPiiDeep', () => {
  const id = new Types.ObjectId();
  const createdAt = new Date('2026-01-02T03:04:05Z');

  it('masks PII keys at any depth and leaves other values untouched', () => {
    const body = {
      user: {
        _id: id,
        email: 'ada@corp.example',
        personalEmail: 'ada@home.example',
        mobilePhone: '+358 40 123 4567',
        createdAt,
      },
      identity: {
        profile: { workPhone: '+358 9 8765 4321', officeExtension: '321' },
        sources: [{ sourceName: 'csv-hr', rawData: { personalEmail: 'ada@home.example' } }],
      },
      workflow: null,
    };

    const masked = maskPiiDeep(body);

    expect(masked).toEqual({
      user: {
        _id: id,
        email: 'ada@corp.example',
        personalEmail: 'a•••@home.example',
        mobilePhone: '+358 •• ••• 4567',
        createdAt,
      },
      identity: {
        profile: { workPhone: '+358 • •••• 4321', officeExtension: '•••' },
        sources: [{ sourceName: 'csv-hr', rawData: { personalEmail: 'a•••@home.example' } }],
      },
      workflow: null,
    });
    expect(masked.user._id).toBe(id);
    expect(masked.user.createdAt).toBe(createdAt);
    // The input is not modified.
    expect(body.user.personalEmail).toBe('ada@home.example');
  });

  it('masks a list response', () => {
    const masked = maskPiiDeep([
      { personalEmail: 'a@b.example' },
      { personalEmail: 'c@d.example' },
    ]);
    expect(masked).toEqual([
      { personalEmail: 'a•••@b.example' },
      { personalEmail: 'c•••@d.example' },
    ]);
  });

  it('walks a hydrated document through its toObject()', () => {
    const doc = Object.assign(Object.create({ toObject: () => ({ mobilePhone: '0401234567' }) }), {
      $isDocument: true,
    }) as object;
    expect(maskPiiDeep({ identity: doc })).toEqual({ identity: { mobilePhone: '••••••4567' } });
  });

  it('passes primitives through', () => {
    expect(maskPiiDeep('x')).toBe('x');
    expect(maskPiiDeep(null)).toBeNull();
    expect(maskPiiDeep(3)).toBe(3);
  });
});

describe('maskPiiAndPhonesDeep', () => {
  it('masks phone-like keys of any name like mobilePhone, and PII_FIELDS once', () => {
    const masked = maskPiiAndPhonesDeep({
      event: {
        phone: '+358501234567',
        homePhone: '09 123 4567',
        telephoneNumber: '+358 9 8765 4321',
        businessPhones: ['+358 9 1111 2222'],
        phoneNumbers: [{ value: '+358 40 333 4444', type: 'work', primary: true }],
        mobile: 358405556666,
        faxNumber: '+358 9 777 8888',
        mobilePhone: '+358 40 123 4567',
        department: 'IT',
        phoneVerified: false,
      },
    });

    expect(masked.event).toEqual({
      phone: '+••••••••4567',
      homePhone: '•• ••• 4567',
      telephoneNumber: '+358 • •••• 4321',
      businessPhones: ['+358 • •••• 2222'],
      phoneNumbers: [{ value: '+358 •• ••• 4444', type: '••••', primary: true }],
      mobile: '••••••••6666',
      faxNumber: '+358 • ••• 8888',
      mobilePhone: '+358 •• ••• 4567',
      department: 'IT',
      phoneVerified: false,
    });
  });

  it('leaves keys that only resemble phone keys alone', () => {
    const body = { mobileDeviceId: 'dev-1234-5678', telemetry: '12345678', fax: '' };
    expect(maskPiiAndPhonesDeep(body)).toEqual(body);
  });

  it('is not what identity responses use: maskPiiDeep keeps other phone keys', () => {
    expect(maskPiiDeep({ phone: '+358501234567' })).toEqual({ phone: '+358501234567' });
  });
});

describe('findMaskedPiiFields', () => {
  it('names the PII fields that carry a masked value', () => {
    expect(
      findMaskedPiiFields({
        personalEmail: 'm•••@example.com',
        mobilePhone: '+358 40 123 4567',
        workPhone: '+358 •• ••• 4567',
        jobTitle: '•••',
      }),
    ).toEqual(['personalEmail', 'workPhone']);
  });

  it('accepts bodies without masked values', () => {
    expect(findMaskedPiiFields({ personalEmail: 'new@example.com' })).toEqual([]);
    expect(findMaskedPiiFields(undefined)).toEqual([]);
  });
});

describe('maskLogin', () => {
  it('keeps the first character of a login, like the local part of maskEmail', () => {
    expect(maskLogin('octocat')).toBe(`o${PII_MASK_CHAR.repeat(3)}`);
    expect(maskLogin('a')).toBe(`a${PII_MASK_CHAR.repeat(3)}`);
    expect(maskLogin('')).toBe(PII_MASK_CHAR.repeat(3));
  });
});
