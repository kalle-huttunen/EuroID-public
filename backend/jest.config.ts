import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  setupFiles: ['reflect-metadata'],
  // One in-memory MongoDB per run; each suite takes its own database (src/testing/test-db.ts)
  globalSetup: '<rootDir>/test/mongo-global-setup.ts',
  globalTeardown: '<rootDir>/test/mongo-global-teardown.ts',
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/src/testing/pact/'],
  testTimeout: 30000, // 30s: room for slow integration suites
  maxWorkers: 2, // Limit parallelism to avoid OOM
  workerIdleMemoryLimit: '512MB', // Kill workers exceeding this to prevent system crash
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts', '!src/worker.ts'],
  coverageDirectory: './coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  // Coverage floors: the measured value rounded down to a whole percent, minus 2 points
  // (backend/docs/TESTING.md, Coverage Thresholds). Measured 2026-11-25 on 919db006:
  // statements 80.67%, branches 65.76%, functions 77.85%, lines 81.16%.
  coverageThreshold: {
    global: {
      branches: 63,
      functions: 75,
      lines: 79,
      statements: 78,
    },
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
    '^@infrastructure/(.*)$': '<rootDir>/src/infrastructure/$1',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@testing/(.*)$': '<rootDir>/src/testing/$1',
    '^@testing$': '<rootDir>/src/testing/index.ts',
    // jose is ESM-only; use CJS mock to avoid Jest parse errors
    '^jose$': '<rootDir>/__mocks__/jose.ts',
    // google-spreadsheet is ESM-only (via ky); stub to prevent parse errors
    '^google-spreadsheet$': '<rootDir>/__mocks__/google-spreadsheet.ts',
  },
  modulePathIgnorePatterns: ['<rootDir>/dist'],
};

export default config;
