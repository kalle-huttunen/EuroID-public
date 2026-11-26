import { test, expect } from '@playwright/test';

/**
 * Authentication & App Shell E2E tests.
 * Validates dev auth bypass, navigation, and basic app rendering.
 */
test.describe('Authentication & App Shell', () => {
  test('redirects to Identity Hub on load (dev auth)', async ({ page }) => {
    await page.goto('/');
    // Dev auth auto-authenticates; should land on /users (Identity Hub)
    await expect(page).toHaveURL(/\/users/);
  });

  test('renders the sidebar with core navigation items', async ({ page }) => {
    await page.goto('/users');
    // Check key sidebar items render
    await expect(page.getByText('Identity Hub')).toBeVisible();
    await expect(page.getByText('Design Studio')).toBeVisible();
    await expect(page.getByText('Connector Marketplace')).toBeVisible();
    await expect(page.getByText('Reconciliation')).toBeVisible();
  });

  test('displays the dev user info', async ({ page }) => {
    await page.goto('/users');
    // DevAuthProvider creates dev@localhost with super-admin
    await expect(page.getByText(/dev@localhost/i).or(page.getByText(/Dev/))).toBeVisible();
  });
});
