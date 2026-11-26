import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@features': path.resolve(__dirname, 'src/features'),
      '@api': path.resolve(__dirname, 'src/api'),
      '@shared': path.resolve(__dirname, 'src/components/common'),
      '@stores': path.resolve(__dirname, 'src/stores'),
      '@config': path.resolve(__dirname, 'src/config'),
      '@theme': path.resolve(__dirname, 'src/theme'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
    // Tests must not depend on a developer's git-ignored .env: VITE_AUTH_DISABLED=true there
    // would turn on dev mode (every permission granted) and open every role gate under test.
    // A test that needs dev mode stubs it with vi.stubEnv.
    env: { VITE_AUTH_DISABLED: 'false' },
    // Each worker is a forked node process of several hundred MB; without a cap Vitest starts
    // one per CPU core minus one, which can run a development machine out of memory.
    // A --maxWorkers flag on the command line still overrides this.
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      // Floors: the measured value rounded down to a whole percent, minus 2 points
      // (backend/docs/TESTING.md, Coverage Thresholds). Measured 2026-11-25 on 919db006:
      // statements 79.21%, branches 66.26%, functions 75.87%, lines 81.31%.
      thresholds: {
        branches: 64,
        functions: 73,
        lines: 79,
        statements: 77,
      },
    },
  },
});
