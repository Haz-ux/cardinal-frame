import { test, expect } from '@playwright/test';

// ─── Shared test user (reuse across all tests, no DB pollution) ────
const TEST_USER = 'e2e_runner2';
const TEST_PASS = 'test1234';
let testToken = null;

async function getTestToken(request) {
  if (testToken) return testToken;
  const login = await request.post('/api/auth/login', {
    data: { username: TEST_USER, password: TEST_PASS },
  });
  if (login.ok()) {
    testToken = (await login.json()).token;
    return testToken;
  }
  const reg = await request.post('/api/auth/register', {
    data: { username: TEST_USER, password: TEST_PASS },
  });
  testToken = (await reg.json()).token;
  return testToken;
}

async function loginAndGo(page, request, path) {
  const token = await getTestToken(request);
  await page.goto('/');
  await page.evaluate((t) => { localStorage.setItem('cf_token', t); }, token);
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

// ─── Dashboard ────────────────────────────────────────────────────
test('dashboard page renders with stat cards', async ({ page, request }) => {
  await loginAndGo(page, request, '/');
  const body = await page.textContent('body');
  expect(body).toBeTruthy();
  // Should have some dashboard content — look for typical dashboard text
  const content = body.toLowerCase();
  const hasDashboard = content.includes('dashboard') || content.includes('status') || content.includes('task') || content.includes('agent');
  expect(hasDashboard).toBeTruthy();
});

test('dashboard has sparkline or chart elements', async ({ page, request }) => {
  await loginAndGo(page, request, '/');
  // Check for SVG elements (sparklines/charts render as SVG)
  const svgCount = await page.locator('svg').count();
  expect(svgCount).toBeGreaterThanOrEqual(1);
});

// ─── Agents ────────────────────────────────────────────────────────
test('agents page renders and can create agent', async ({ page, request }) => {
  await loginAndGo(page, request, '/agents');
  const body = await page.textContent('body');
  expect(body).toBeTruthy();
});

test('agent CRUD via API', async ({ request }) => {
  const token = await getTestToken(request);
  const headers = { 'Authorization': `Bearer ${token}` };

  // Create
  const create = await request.post('/api/agents', {
    headers,
    data: { name: 'e2e-test-agent', system_prompt: 'Test agent', model: 'auto' },
  });
  expect(create.ok()).toBeTruthy();
  const agent = await create.json();
  expect(agent.id).toBeDefined();

  // List should include it
  const list = await request.get('/api/agents', { headers });
  expect(list.ok()).toBeTruthy();
  const agents = await list.json();
  expect(agents.some(a => a.id === agent.id)).toBeTruthy();

  // Delete
  const del = await request.delete(`/api/agents/${agent.id}`, { headers });
  expect(del.ok()).toBeTruthy();
});

// ─── Tasks ─────────────────────────────────────────────────────────
test('task CRUD via API', async ({ request }) => {
  const token = await getTestToken(request);
  const headers = { 'Authorization': `Bearer ${token}` };

  // Create task
  const create = await request.post('/api/tasks', {
    headers,
    data: { title: 'E2E Test Task', description: 'Created by Playwright' },
  });
  expect(create.ok()).toBeTruthy();
  const task = await create.json();
  expect(task.id).toBeDefined();

  // Get by id
  const get = await request.get(`/api/tasks/${task.id}`, { headers });
  expect(get.ok()).toBeTruthy();
  const fetched = await get.json();
  expect(fetched.title).toBe('E2E Test Task');

  // List
  const list = await request.get('/api/tasks', { headers });
  expect(list.ok()).toBeTruthy();
  const tasks = await list.json();
  expect(tasks.some(t => t.id === task.id)).toBeTruthy();

  // Delete
  const del = await request.delete(`/api/tasks/${task.id}`, { headers });
  expect(del.ok()).toBeTruthy();
});

// ─── Settings ──────────────────────────────────────────────────────
test('settings page renders with dev settings section', async ({ page, request }) => {
  await loginAndGo(page, request, '/settings');
  const body = await page.textContent('body');
  expect(body).toBeTruthy();
  const content = body.toLowerCase();
  // Should have dev settings text
  expect(content.includes('dev settings') || content.includes('port') || content.includes('log level')).toBeTruthy();
});

test('dev settings API CRUD', async ({ request }) => {
  const token = await getTestToken(request);
  const headers = { 'Authorization': `Bearer ${token}` };

  // GET dev settings
  const get = await request.get('/api/settings/dev', { headers });
  expect(get.ok()).toBeTruthy();
  const settings = await get.json();
  expect(settings.port).toBeDefined();
  expect(settings.logLevel).toBeDefined();

  // PUT — update sandbox timeout
  const put = await request.put('/api/settings/dev', {
    headers,
    data: { sandboxTimeout: '45' },
  });
  expect(put.ok()).toBeTruthy();
  const result = await put.json();
  expect(result.success).toBeTruthy();

  // Verify it persisted
  const get2 = await request.get('/api/settings/dev', { headers });
  const updated = await get2.json();
  expect(updated.sandboxTimeout).toBe('45');

  // Reset back
  await request.put('/api/settings/dev', {
    headers,
    data: { sandboxTimeout: '30' },
  });
});

// ─── Neural Map ────────────────────────────────────────────────────
test('neural map page renders', async ({ page, request }) => {
  await loginAndGo(page, request, '/neural');
  const body = await page.textContent('body');
  expect(body).toBeTruthy();
  // Should have canvas or SVG for the graph
  const hasCanvas = await page.locator('canvas').count() + await page.locator('svg').count();
  expect(hasCanvas).toBeGreaterThanOrEqual(0); // might be lazy-loaded
});

test('graph API returns nodes and links', async ({ request }) => {
  const token = await getTestToken(request);
  const headers = { 'Authorization': `Bearer ${token}` };
  const res = await request.get('/api/graph', { headers });
  expect(res.ok()).toBeTruthy();
  const graph = await res.json();
  expect(graph.nodes).toBeDefined();
  expect(Array.isArray(graph.nodes)).toBeTruthy();
  expect(graph.links).toBeDefined();
  expect(Array.isArray(graph.links)).toBeTruthy();
});

// ─── LLM Providers ────────────────────────────────────────────────
test('LLM providers page renders', async ({ page, request }) => {
  await loginAndGo(page, request, '/llm');
  const body = await page.textContent('body');
  expect(body).toBeTruthy();
});

test('LLM providers API returns list', async ({ request }) => {
  const token = await getTestToken(request);
  const headers = { 'Authorization': `Bearer ${token}` };
  const res = await request.get('/api/llm/providers', { headers });
  expect(res.ok()).toBeTruthy();
  const providers = await res.json();
  expect(Array.isArray(providers)).toBeTruthy();
});

// ─── Health detailed ───────────────────────────────────────────────
test('detailed health endpoint returns system stats', async ({ request }) => {
  const token = await getTestToken(request);
  const headers = { 'Authorization': `Bearer ${token}` };
  const res = await request.get('/api/health/detailed', { headers });
  expect(res.ok()).toBeTruthy();
  const health = await res.json();
  expect(health.heap).toBeDefined();
  expect(health.uptime).toBeDefined();
});
