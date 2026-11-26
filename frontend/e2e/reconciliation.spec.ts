import { test, expect } from '@playwright/test';

/**
 * Reconciliation Dashboard E2E tests.
 * Validates the drift overview and reconciliation pages render correctly.
 */
test.describe('Reconciliation Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/reconciliation');
  });

  test('renders the Reconciliation page', async ({ page }) => {
    await expect(
      page
        .getByRole('heading', { name: /reconciliation/i })
        .or(page.getByText('Reconciliation')),
    ).toBeVisible();
  });

  test('displays drift statistics or summary cards', async ({ page }) => {
    // The dashboard should show summary statistics (cards, stats, or charts)
    await expect(
      page
        .locator('.ant-statistic, .ant-card, [class*="statistic"]')
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('navigates to uncorrelated queue', async ({ page }) => {
    // Click the uncorrelated link if visible
    const link = page.getByText(/uncorrelated/i).first();
    if (await link.isVisible()) {
      await link.click();
      await expect(page).toHaveURL(/\/reconciliation\/uncorrelated/);
    }
  });
});
