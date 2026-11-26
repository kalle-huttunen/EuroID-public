import { test, expect } from '@playwright/test';

/**
 * Cross-app navigation E2E tests.
 * Validates that all major routes render without errors.
 */
test.describe('Navigation', () => {
  const routes = [
    { path: '/users', label: 'Identity Hub' },
    { path: '/blueprints', label: 'Design Studio' },
    { path: '/role-rules', label: 'Role-based Rules' },
    { path: '/connectors', label: 'Connector Marketplace' },
    { path: '/reconciliation', label: 'Reconciliation' },
    { path: '/audit', label: 'Audit & Compliance' },
    { path: '/access-requests', label: 'Access Requests' },
    { path: '/intelligence/risk', label: 'Risk Dashboard' },
    { path: '/intelligence/reviews', label: 'Access Reviews' },
    { path: '/intelligence/analytics', label: 'Analytics' },
  ];

  for (const { path, label } of routes) {
    test(`${label} (${path}) loads without error`, async ({ page }) => {
      await page.goto(path);
      // Should not show a blank page or error boundary
      await expect(page.locator('body')).not.toHaveText(/something went wrong/i);
      // Should have rendered some content (not just a spinner)
      await expect(
        page.locator('.ant-layout-content, [class*="content"], main').first(),
      ).toBeVisible({ timeout: 15_000 });
    });
  }
});
