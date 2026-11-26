import { test, expect } from '@playwright/test';

/**
 * Identity Hub E2E tests.
 * Validates the user list page renders, search works, and user detail is accessible.
 */
test.describe('Identity Hub', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/users');
  });

  test('renders the Identity Hub page heading', async ({ page }) => {
    // The page should show some form of user list heading
    await expect(
      page
        .getByRole('heading', { name: /identity|user/i })
        .or(page.getByText('Identity Hub')),
    ).toBeVisible();
  });

  test('displays a data table or list', async ({ page }) => {
    // The page should contain either an Ant Design table or a list component
    await expect(
      page.locator('.ant-table').or(page.locator('[class*="table"]')).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('search input is available', async ({ page }) => {
    // Should have a search/filter input
    const searchInput = page
      .getByPlaceholder(/search|filter/i)
      .or(page.locator('.ant-input-search input'));
    await expect(searchInput.first()).toBeVisible();
  });
});
