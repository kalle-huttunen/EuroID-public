/**
 * PATCH /identity/v2/:id/controls body: an override of the department or job title needs a
 * reason and may carry a future expiry (owner decision 2026-11-24); removing one needs neither.
 */
import { UpdateIdentityControlsSchema } from './update-identity-controls.dto';

const issues = (body: unknown) => {
  const result = UpdateIdentityControlsSchema.safeParse(body);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

describe('UpdateIdentityControlsSchema', () => {
  it('accepts an override with a reason and a future expiry', () => {
    expect(
      issues({
        manualDepartment: 'R&D',
        manualJobTitle: 'Lead',
        reason: 'Reorg',
        expiresAt: FUTURE,
      }),
    ).toEqual([]);
  });

  it('refuses an override without a reason', () => {
    expect(issues({ manualJobTitle: 'Lead' })).toEqual([
      'reason: A reason is required to set manualDepartment or manualJobTitle',
    ]);
  });

  it('accepts a removal and the kill switch without a reason', () => {
    expect(issues({ manualDepartment: '' })).toEqual([]);
    expect(issues({ manualJobTitle: null })).toEqual([]);
    expect(issues({ isLoginDisabled: true })).toEqual([]);
  });

  // Hunt 2026-11-25 02 F5: any string was stored and became the profile email at reconcile
  it('takes an email override as an email, trimmed and lower-cased, and "" or null to remove it', () => {
    expect(issues({ overrides: { email: 'not-an-email' } })).toEqual([
      'overrides.email: Must be an email, or "" or null to remove the override',
    ]);
    expect(
      UpdateIdentityControlsSchema.parse({ overrides: { email: ' Ada.L@Corp.Example ' } }),
    ).toEqual({ overrides: { email: 'ada.l@corp.example' } });
    expect(issues({ overrides: { email: '' } })).toEqual([]);
    expect(issues({ overrides: { email: null } })).toEqual([]);
  });

  it('refuses an expiry in the past, or one with no override being set', () => {
    expect(issues({ manualDepartment: 'R&D', reason: 'x', expiresAt: PAST })).toEqual([
      'expiresAt: expiresAt must be in the future',
    ]);
    expect(issues({ manualDepartment: '', expiresAt: FUTURE })).toEqual([
      'expiresAt: expiresAt applies to a manualDepartment or manualJobTitle this request sets',
    ]);
  });

  it('refuses an unknown field, so a misspelt control is not dropped silently', () => {
    expect(issues({ jobTitle: 'Lead', reason: 'x' })).toEqual([
      expect.stringContaining('Unrecognized key'),
    ]);
  });
});
