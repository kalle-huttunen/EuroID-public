import { describe, it, expect } from 'vitest';
import { erasureConfirmText, identityLabel, isPastExpiry, pickerLabel } from '../gdpr-labels';
import { analytics, newsletter, marketing } from './GdprPage.fixtures';

const ID = '64b7f0c2a1b2c3d4e5f60a09';

describe('gdpr-labels', () => {
  it('confirms an erasure with the work email, or with the id when there is none', () => {
    expect(erasureConfirmText({ id: ID, email: 'ada@corp.example', displayName: 'Ada' })).toBe(
      'ada@corp.example',
    );
    // An identity without an email (a contractor from a source without one) is confirmed by id.
    expect(erasureConfirmText({ id: ID, email: '', displayName: '' })).toBe(ID);
  });

  it('names a person by name and email, by whichever exists, or by id', () => {
    expect(identityLabel({ id: ID, email: 'ada@corp.example', displayName: 'Ada V' })).toBe(
      'Ada V (ada@corp.example)',
    );
    // Without a name the list falls back to the email as the display name: shown once.
    expect(
      identityLabel({ id: ID, email: 'ada@corp.example', displayName: 'ada@corp.example' }),
    ).toBe('ada@corp.example');
    expect(identityLabel({ id: ID, email: '', displayName: '' })).toBe(ID);
  });

  it('marks an offboarded person in the picker, and only them', () => {
    const ada = { id: ID, email: 'ada@corp.example', displayName: 'Ada V' };
    expect(pickerLabel({ ...ada, offboarded: true })).toBe('Ada V (ada@corp.example), offboarded');
    expect(pickerLabel(ada)).toBe('Ada V (ada@corp.example)');
  });

  it('marks a granted consent past its expiry date, never a revoked one or one without a date', () => {
    const now = new Date('2026-11-24T10:00:00.000Z');
    expect(isPastExpiry(newsletter, now)).toBe(true);
    expect(isPastExpiry(analytics, now)).toBe(false);
    expect(isPastExpiry({ ...marketing, expiresAt: '2025-01-01T00:00:00.000Z' }, now)).toBe(false);
    expect(isPastExpiry({ ...analytics, expiresAt: undefined }, now)).toBe(false);
  });
});
