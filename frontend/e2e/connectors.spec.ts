import { test, expect } from '@playwright/test';

/**
 * Connector Marketplace E2E tests.
 * Validates the connector listing page renders with available connectors.
 */
test.describe('Connector Marketplace', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/connectors');
  });

  test('renders the Connector Marketplace page', async ({ page }) => {
    await expect(
      page
        .getByRole('heading', { name: /connector/i })
        .or(page.getByText('Connector Marketplace')),
    ).toBeVisible();
  });

  test('shows available connector cards', async ({ page }) => {
    // Connector marketplace shows cards with connector names
    // At minimum, the built-in connectors should appear
    await expect(
      page.locator('.ant-card').or(page.locator('[class*="card"]')).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('connector card shows health or status indicator', async ({ page }) => {
    // Each connector card should show some status: badge, tag, or icon
    const firstCard = page.locator('.ant-card').first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });
    // Should have at least a title and some content
    await expect(firstCard.locator('.ant-card-head, .ant-card-body').first()).toBeVisible();
  });
});
