import { test, expect } from '@playwright/test';

test.describe('Boot Screen', () => {
  const bootUrl = 'http://localhost:3000';
  // Desktop sidebar selector (unique)
  // Use the main layout div as app-visible check (more reliable than nav with responsive classes)
  const appVisibleSel = '.min-h-screen.flex';

  test('boot screen appears after fresh login then dismisses', async ({ page }) => {
    const username = `boot_${Date.now()}`;
    const res = await page.request.post(`${bootUrl}/api/auth/register`, {
      data: { username, password: 'testpass123' },
    });
    expect(res.ok()).toBeTruthy();

    // Clear session state
    await page.goto(bootUrl);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    // Login
    await page.goto(`${bootUrl}/login`);
    await page.waitForSelector('input[type="text"]');
    await page.fill('input[type="text"]', username);
    await page.fill('input[type="password"]', 'testpass123');
    await page.click('button[type="submit"]');

    // Boot screen overlay (z-9999) should appear
    const bootOverlay = page.locator('.fixed.inset-0.z-\\[9999\\]');
    await expect(bootOverlay).toBeVisible({ timeout: 5000 });

    // Should show boot terminal text
    await expect(bootOverlay.locator('text=System ready')).toBeVisible({ timeout: 5000 });

    // Boot screen auto-dismisses after ~3.4s
    await expect(bootOverlay).toBeHidden({ timeout: 6000 });

    // App content now visible (desktop sidebar)
    await expect(page.locator(appVisibleSel)).toBeVisible({ timeout: 3000 });
  });

  test('no boot screen on page refresh', async ({ page }) => {
    const username = `noboot_${Date.now()}`;
    await page.request.post(`${bootUrl}/api/auth/register`, {
      data: { username, password: 'testpass123' },
    });

    // Login first
    await page.goto(bootUrl);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    await page.goto(`${bootUrl}/login`);
    await page.fill('input[type="text"]', username);
    await page.fill('input[type="password"]', 'testpass123');
    await page.click('button[type="submit"]');

    // Wait for boot to finish and fully disappear
    const bootOverlay = page.locator('.fixed.inset-0.z-\\[9999\\]');
    await expect(bootOverlay).toBeHidden({ timeout: 8000 });
    // Extra wait to ensure fade-out completed and component unmounted
    await page.waitForTimeout(500);

    // Refresh — should NOT show boot screen
    await page.reload();
    await page.waitForLoadState('networkidle');

    const bootCount = await bootOverlay.count();
    expect(bootCount).toBe(0);

    // App is visible
    await expect(page.locator(appVisibleSel)).toBeVisible({ timeout: 5000 });
  });

  test('no boot screen when token already exists (page revisit)', async ({ page }) => {
    const username = `token_${Date.now()}`;
    const res = await page.request.post(`${bootUrl}/api/auth/register`, {
      data: { username, password: 'testpass123' },
    });
    const { token } = await res.json();

    // Set token directly — no cf_just_logged_in flag
    await page.goto(bootUrl);
    await page.evaluate((t) => {
      localStorage.setItem('cf_token', t);
    }, token);

    // Visit app
    await page.goto(bootUrl);
    await page.waitForLoadState('networkidle');

    // No boot screen
    const bootOverlay = page.locator('.fixed.inset-0.z-\\[9999\\]');
    const bootCount = await bootOverlay.count();
    expect(bootCount).toBe(0);

    // App is visible
    await expect(page.locator(appVisibleSel)).toBeVisible({ timeout: 5000 });
  });
});
