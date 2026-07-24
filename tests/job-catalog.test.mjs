import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth } from './helpers.mjs';

let app;

beforeAll(async () => {
  ({ app } = await getTestServer());
});

afterAll(async () => {
  await cleanupTestServer();
});

describe('Job Catalog', () => {
  let templateId;

  it('should create a job template', async () => {
    const res = await request(app)
      .post('/api/job-catalog')
      .set(adminAuth())
      .send({
        name: 'Build Project',
        description: 'Builds the project and runs tests',
        command: 'npm run build && npm test',
        parameters: [],
        category: 'build',
        tags: ['build', 'test'],
        priority: 'high',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Build Project');
    expect(res.body.command).toBe('npm run build && npm test');
    expect(res.body.parameters).toEqual([]);
    expect(res.body.tags).toEqual(['build', 'test']);
    expect(res.body.category).toBe('build');
    expect(res.body.use_count).toBe(0);
    templateId = res.body.id;
  });

  it('should validate required fields', async () => {
    const res = await request(app)
      .post('/api/job-catalog')
      .set(adminAuth())
      .send({ description: 'no name or command' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Name is required');
  });

  it('should list templates', async () => {
    const res = await request(app).get('/api/job-catalog');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.some(t => t.name === 'Build Project')).toBe(true);
  });

  it('should filter by category', async () => {
    const res = await request(app).get('/api/job-catalog?category=build');
    expect(res.status).toBe(200);
    expect(res.body.every(t => t.category === 'build')).toBe(true);
  });

  it('should search templates', async () => {
    const res = await request(app).get('/api/job-catalog?search=build');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('should get a single template', async () => {
    const res = await request(app).get(`/api/job-catalog/${templateId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(templateId);
    expect(res.body.name).toBe('Build Project');
  });

  it('should return 404 for missing template', async () => {
    const res = await request(app).get('/api/job-catalog/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('should update a template', async () => {
    const res = await request(app)
      .put(`/api/job-catalog/${templateId}`)
      .set(adminAuth())
      .send({ name: 'Build Project v2', command: 'npm run build:prod' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Build Project v2');
    expect(res.body.command).toBe('npm run build:prod');
  });

  it('should create a template with parameters', async () => {
    const res = await request(app)
      .post('/api/job-catalog')
      .set(adminAuth())
      .send({
        name: 'Deploy Service',
        command: 'kubectl rollout restart deployment/{{service}} -n {{namespace}}',
        parameters: [
          { name: 'service', description: 'Service name', required: true },
          { name: 'namespace', description: 'K8s namespace', defaultValue: 'default', required: false },
        ],
        category: 'deploy',
      });
    expect(res.status).toBe(201);
    expect(res.body.parameters).toHaveLength(2);
    expect(res.body.parameters[0].name).toBe('service');
  });

  it('should instantiate a template with parameters', async () => {
    // First create a parameterized template
    const createRes = await request(app)
      .post('/api/job-catalog')
      .set(adminAuth())
      .send({
        name: 'Run Script',
        command: 'node {{script}} --arg={{arg}}',
        parameters: [
          { name: 'script', description: 'Script path', required: true },
          { name: 'arg', description: 'Script arg', required: false },
        ],
      });
    expect(createRes.status).toBe(201);
    const tplId = createRes.body.id;

    // Instantiate it
    const instRes = await request(app)
      .post(`/api/job-catalog/${tplId}/instantiate`)
      .set(adminAuth())
      .send({
        params: { script: 'test.js', arg: 'debug' },
        autoExecute: false,
      });
    expect(instRes.status).toBe(201);
    expect(instRes.body.template).toBeTruthy();
    // Task should have the substituted command
    expect(instRes.body.command).toBe('node test.js --arg=debug');
    expect(instRes.body.name).toContain('Run Script');
  });

  it('should require parameter substitution for required params', async () => {
    const createRes = await request(app)
      .post('/api/job-catalog')
      .set(adminAuth())
      .send({
        name: 'Deploy',
        command: 'deploy --env={{env}}',
        parameters: [{ name: 'env', description: 'Environment', required: true }],
      });
    const tplId = createRes.body.id;

    const instRes = await request(app)
      .post(`/api/job-catalog/${tplId}/instantiate`)
      .set(adminAuth())
      .send({ params: {}, autoExecute: false });
    expect(instRes.status).toBe(400);
    expect(instRes.body.error).toContain('Missing required parameters');
  });

  it('should get categories with counts', async () => {
    const res = await request(app).get('/api/job-catalog/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(c => c.category === 'build')).toBe(true);
  });

  it('should increment use_count on instantiation', async () => {
    const createRes = await request(app)
      .post('/api/job-catalog')
      .set(adminAuth())
      .send({
        name: 'Counter Test',
        command: 'echo hello',
        category: 'test',
      });
    const tplId = createRes.body.id;
    expect(createRes.body.use_count).toBe(0);

    await request(app)
      .post(`/api/job-catalog/${tplId}/instantiate`)
      .set(adminAuth())
      .send({ autoExecute: false });

    const getRes = await request(app).get(`/api/job-catalog/${tplId}`);
    expect(getRes.body.use_count).toBe(1);
    expect(getRes.body.last_used_at).toBeTruthy();
  });

  it('should import an AI-suggested template', async () => {
    const res = await request(app)
      .post('/api/job-catalog/import')
      .set(adminAuth())
      .send({
        name: 'AI Suggested Build',
        command: 'make build',
        category: 'build',
      });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('ai-suggested');
  });

  it('should delete a template', async () => {
    const res = await request(app)
      .delete(`/api/job-catalog/${templateId}`)
      .set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const getRes = await request(app).get(`/api/job-catalog/${templateId}`);
    expect(getRes.status).toBe(404);
  });

  it('should return empty suggestions when no task history', async () => {
    const res = await request(app)
      .post('/api/job-catalog/suggest')
      .set(adminAuth());
    // Will either return 503 (no LLM) or 200 with empty suggestions (no history)
    expect([200, 503]).toContain(res.status);
  });
});
