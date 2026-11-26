import { unprovisionedReason, withNotProvisioned } from './provision-result';

describe('unprovisionedReason', () => {
  it("gives the target's own reason for an answer of success: false", () => {
    expect(unprovisionedReason({ success: false, error: 'AD config missing host or baseDn' })).toBe(
      'AD config missing host or baseDn',
    );
  });

  it('gives a reason of its own when the target named none', () => {
    expect(unprovisionedReason({ success: false })).toBe(
      'the target answered that it did not provision the account',
    );
    expect(unprovisionedReason({ success: false, error: '  ' })).toBe(
      'the target answered that it did not provision the account',
    );
  });

  it('is undefined for a success and for a connector that answers nothing', () => {
    expect(unprovisionedReason({ success: true })).toBeUndefined();
    expect(unprovisionedReason({})).toBeUndefined();
    expect(unprovisionedReason(undefined)).toBeUndefined();
  });
});

describe('withNotProvisioned', () => {
  it('names each target with its reason once, after the result', () => {
    expect(
      withNotProvisioned('Done.', ['ad: no base DN', 'ad: no base DN', 'github: refused']),
    ).toBe('Done. Not provisioned to ad: no base DN. Not provisioned to github: refused.');
  });

  it('leaves the result as it is when every target provisioned', () => {
    expect(withNotProvisioned('Done.', [])).toBe('Done.');
  });
});
