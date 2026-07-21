import { test, expect } from '@playwright/test';

// ─── Shared test user (reuse across all tests, no DB pollution) ────
const TEST_USER = 'e2e_runner';
const TEST_PASS = 'test1234';
let testToken = null;

async function getTestToken(request) {
  // Always try login first (user persists across runs), fallback to register
  const login = await request.post('/api/auth/login', {
    data: { username: TEST_USER, password: TEST_PASS },
  });
  if (login.ok()) {
    testToken = (await login.json()).token;
    return testToken;
  }
  // First run — register
  const reg = await request.post('/api/auth/register', {
    data: { username: TEST_USER, password: TEST_PASS },
  });
  testToken = (await reg.json()).token;
  return testToken;
}

// ─── Health ────────────────────────────────────────────────────
test('health endpoint returns ok', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.status).toBe('ok');
});

// ─── Auth ──────────────────────────────────────────────────────
test('register + login flow', async ({ request }) => {
  const uniq = 'pw_' + Date.now();
  const reg = await request.post('/api/auth/register', {
    data: { username: uniq, password: 'test1234' },
  });
  expect(reg.status()).toBe(201);
  const regBody = await reg.json();
  expect(regBody.token).toBeDefined();
  expect(regBody.user.username).toBe(uniq);

  // Login with same user
  const login = await request.post('/api/auth/login', {
    data: { username: uniq, password: 'test1234' },
  });
  expect(login.ok()).toBeTruthy();
  const loginBody = await login.json();
  expect(loginBody.token).toBeDefined();
});

// ─── Tools & Skills ────────────────────────────────────────────
test('tools endpoint returns system tools', async ({ request }) => {
  const res = await request.get('/api/tools');
  expect(res.ok()).toBeTruthy();
  const tools = await res.json();
  expect(tools.length).toBeGreaterThanOrEqual(10);
  const names = tools.map(t => t.name);
  expect(names).toContain('list_agents');
  expect(names).toContain('create_task');
  expect(names).toContain('system_status');
});

test('skills endpoint responds', async ({ request }) => {
  const res = await request.get('/api/skills');
  expect(res.ok()).toBeTruthy();
  const skills = await res.json();
  expect(Array.isArray(skills)).toBeTruthy();
});

// ─── Chat Conversations ────────────────────────────────────────
test('conversation CRUD with auth', async ({ request }) => {
  const token = await getTestToken(request);
  const headers = { 'Authorization': `Bearer ${token}` };

  // Create
  const create = await request.post('/api/chat/conversations', {
    headers,
    data: { title: 'E2E Test Chat', model: 'gpt-4' },
  });
  expect(create.status()).toBe(201);
  const conv = await create.json();
  expect(conv.title).toBe('E2E Test Chat');

  // List
  const list = await request.get('/api/chat/conversations', { headers });
  expect(list.ok()).toBeTruthy();
  const convs = await list.json();
  expect(convs.length).toBeGreaterThanOrEqual(1);

  // Messages (empty)
  const msgs = await request.get(`/api/chat/conversations/${conv.id}/messages`, { headers });
  expect(msgs.ok()).toBeTruthy();
  expect(await msgs.json()).toEqual([]);

  // Delete
  const del = await request.delete(`/api/chat/conversations/${conv.id}`, { headers });
  expect(del.ok()).toBeTruthy();
});

// ─── File Upload ────────────────────────────────────────────────
test('chat file upload', async ({ request }) => {
  // Always get fresh token (module cache may be stale from other tests)
  testToken = null;
  const token = await getTestToken(request);
  const upload = await request.post('/api/chat/upload', {
    headers: { 'Authorization': `Bearer ${token}` },
    data: {
      filename: 'test.txt',
      mime_type: 'text/plain',
      content_b64: 'SGVsbG8gV29ybGQ=',
    },
  });
  expect(upload.status()).toBe(201);
  const att = await upload.json();
  expect(att.filename).toBe('test.txt');
  expect(att.size).toBe(11);
});

// ─── Frontend Pages ─────────────────────────────────────────────
test('homepage loads and shows login', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const title = await page.title();
  expect(title).toBeTruthy();
});

test('chat page renders', async ({ request, page }) => {
  const token = await getTestToken(request);
  await page.goto('/');
  await page.evaluate((t) => localStorage.setItem('cf_token', t), token);

  await page.goto('/chat');
  await page.waitForLoadState('networkidle');
  const pageContent = await page.textContent('body');
  expect(pageContent).toBeTruthy();
});

test('skills page renders', async ({ request, page }) => {
  const token = await getTestToken(request);
  await page.goto('/');
  await page.evaluate((t) => localStorage.setItem('cf_token', t), token);

  await page.goto('/skills');
  await page.waitForLoadState('networkidle');
  const pageContent = await page.textContent('body');
  expect(pageContent).toBeTruthy();
});
