import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Configuration for EuroID Frontend
 *
 * Usage:
 *   npm run test:e2e          — headless (CI)
 *   npm run test:e2e:headed   — watch the browser
 *   npm run test:e2e:ui       — Playwright UI mode
 *
 * Requires both backend (port 3001) and frontend (port 5173) running.
 * Auth: uses VITE_AUTH_DISABLED=true (DevAuthProvider) — no real IdP needed.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'html',
  timeout: 30_000,

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Start frontend dev server if not already running */
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
