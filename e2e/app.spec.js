import { test, expect } from '@playwright/test';

// Use a stored auth state to avoid flaky re-login on every test
let authCookie = null;

test.describe('Cardinal Frame UI', () => {
  // Login once and reuse
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('http://localhost:3000/login');
    await page.fill('input[type="text"]', 'admin');
    await page.fill('input[type="password"]', 'cardinal');
    await page.getByRole('button', { name: /sign in/i }).first().click();
    await page.waitForURL('http://localhost:3000/', { timeout: 15000 });
    await page.waitForTimeout(2000);
    // Store the localStorage token
    authCookie = await page.evaluate(() => localStorage.getItem('cf_token'));
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    // Inject auth token before navigating
    await page.goto('http://localhost:3000/login');
    await page.evaluate((token) => localStorage.setItem('cf_token', token), authCookie);
    await page.goto('http://localhost:3000/');
    await page.waitForTimeout(1500);
  });

  test('dashboard loads with provider/model stats', async ({ page }) => {
    await expect(page.locator('main').locator('text=LLM PROVIDERS').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('main').locator('text=118 models')).toBeVisible();
  });

  test('LLM Models page shows all providers', async ({ page }) => {
    await page.goto('http://localhost:3000/llm');
    await expect(page.locator('main').locator('text=PROVIDERS').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('main').locator('text=OpenAI').first()).toBeVisible();
    await expect(page.locator('main').locator('text=NVIDIA').first()).toBeVisible();
    await expect(page.locator('main').locator('text=Anthropic').first()).toBeVisible();
    await expect(page.locator('main').locator('text=Cohere').first()).toBeVisible();
  });

  test('LLM Models page shows detected models', async ({ page }) => {
    await page.goto('http://localhost:3000/llm');
    await expect(page.locator('main').locator('text=ALL MODELS').first()).toBeVisible({ timeout: 10000 });
  });

  test('Tasks page', async ({ page }) => {
    await page.goto('http://localhost:3000/tasks');
    await expect(page.locator('main').locator('text=New Task').first()).toBeVisible({ timeout: 10000 });
  });

  test('Agents page', async ({ page }) => {
    await page.goto('http://localhost:3000/agents');
    await expect(page.locator('main').locator('text=Register Agent').first()).toBeVisible({ timeout: 10000 });
  });

  test('Schedules page', async ({ page }) => {
    await page.goto('http://localhost:3000/schedules');
    await expect(page.locator('main').locator('text=New Schedule').first()).toBeVisible({ timeout: 10000 });
  });

  test('MCP page', async ({ page }) => {
    await page.goto('http://localhost:3000/mcp');
    await expect(page.locator('main').locator('text=MCP Servers').first()).toBeVisible({ timeout: 10000 });
  });

  test('Agent Groups page', async ({ page }) => {
    await page.goto('http://localhost:3000/groups');
    await expect(page.locator('main').locator('text=New Group').first()).toBeVisible({ timeout: 10000 });
  });

  test('DAG Editor page loads', async ({ page }) => {
    await page.goto('http://localhost:3000/dags');
    // Just verify the page doesn't crash — content may vary
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });
  });

  test('Users page loads', async ({ page }) => {
    await page.goto('http://localhost:3000/users');
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });
  });

  test('Audit Log page loads', async ({ page }) => {
    await page.goto('http://localhost:3000/audit');
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });
  });

  test('Neural Map page loads with SVG graph', async ({ page }) => {
    await page.goto('http://localhost:3000/neural');
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });
    // Check SVG graph renders (the neural map canvas)
    await page.waitForTimeout(3000);
    const svgCount = await page.locator('main svg').count();
    expect(svgCount).toBeGreaterThanOrEqual(1);
  });
});
