import { metricsTokenMatches } from './metrics-token';

/** GET /metrics with METRICS_TOKEN: the bearer token is compared in constant time. */
describe('metricsTokenMatches', () => {
  it('accepts the configured token as a bearer token, in any case of the scheme', () => {
    expect(metricsTokenMatches('Bearer s3cret-token', 's3cret-token')).toBe(true);
    expect(metricsTokenMatches('bearer s3cret-token', 's3cret-token')).toBe(true);
  });

  it.each([undefined, '', 'Bearer ', 'Bearer s3cret-toke', 'Bearer s3cret-token-x', 's3cret'])(
    'refuses %p',
    (header) => {
      expect(metricsTokenMatches(header, 's3cret-token')).toBe(false);
    },
  );
});
