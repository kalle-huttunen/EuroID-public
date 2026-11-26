import { isDevOrTest } from './runtime-env';

/** Development conveniences are allowed by an allow-list of NODE_ENV values, never a block list. */
describe('isDevOrTest', () => {
  it('allows development and test', () => {
    expect(isDevOrTest('development')).toBe(true);
    expect(isDevOrTest('test')).toBe(true);
  });

  it('treats production, staging, pre-prod and a typo as production', () => {
    for (const value of ['production', 'staging', 'pre-prod', 'prod', 'Development', '']) {
      expect(isDevOrTest(value)).toBe(false);
    }
  });

  it('reads process.env.NODE_ENV when no value is given', () => {
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'staging';
      expect(isDevOrTest()).toBe(false);
      process.env.NODE_ENV = 'test';
      expect(isDevOrTest()).toBe(true);
      // An unset NODE_ENV gets the production rules.
      delete process.env.NODE_ENV;
      expect(isDevOrTest()).toBe(false);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
