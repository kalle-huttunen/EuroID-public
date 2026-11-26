/**
 * Jest configuration for Pact contract tests.
 *
 * Pact tests boot the full AppModule against a real MongoDB instance,
 * so they are excluded from the default test suite (jest.config.ts) and
 * run separately in CI with: npx jest --config=jest.pact.config.ts --runInBand
 */
import type { Config } from 'jest';
import baseConfig from './jest.config';

const config: Config = {
  ...baseConfig,
  // Only run Pact specs
  testRegex: '.*pact.*\\.spec\\.ts$',
  // Override: do NOT ignore the pact directory
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  // Pact tests are integration tests — no coverage collection
  collectCoverage: false,
  coverageThreshold: undefined,
  // Longer timeout for full app bootstrap + provider verification
  testTimeout: 120_000,
};

export default config;
