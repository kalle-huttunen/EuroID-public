import { test, expect } from '@playwright/test';

/**
 * Audit & Compliance E2E tests.
 * Validates the audit log page renders with filters and data table.
 */
test.describe('Audit & Compliance', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/audit');
  });

  test('renders the Audit page', async ({ page }) => {
    await expect(
      page
        .getByRole('heading', { name: /audit/i })
        .or(page.getByText(/Audit/)),
    ).toBeVisible();
  });

  test('displays the audit event table', async ({ page }) => {
    await expect(
      page.locator('.ant-table').or(page.locator('table')).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('has date filter controls', async ({ page }) => {
    // Audit page should have date pickers or filter inputs
    await expect(
      page
        .locator('.ant-picker, .ant-select, [class*="filter"]')
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
