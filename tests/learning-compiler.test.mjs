import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
  decideKind, compile, generateTests, runTests, scanArtifact, executeVersion,
  recordVersionEvent, VERSION_STATES,
} from '../src/server/learning/compiler.mjs';
import { buildSpec } from '../src/server/learning/spec.mjs';
import { record } from '../src/server/learning/events.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

let db;

function freshDb() {
  const d = new Database(':memory:');
  for (const f of ['014_learning_events.sql', '022_learning_events.sql', '026_learning_candidates.sql', '028_learning_skill_versions.sql']) {
    d.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  d.exec('CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT, enabled INTEGER DEFAULT 1)');
  return d;
}

function seedCandidate(userId, overrides = {}) {
  const id = randomUUID();
  db.prepare(`INSERT INTO learning_candidates
    (id, user_id, kind, title, draft, eligibility_note, risk_tier, requested_caps,
     state, support_verified, quality_json, promotion_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, 0.9)`)
    .run(id, userId,
      overrides.kind || 'procedure',
      overrides.title || 'Fix the stuck queue',
      overrides.draft !== undefined ? overrides.draft : JSON.stringify(['Drain the queue', 'Restart the worker']),
      'reviewed', overrides.risk_tier || 'low', overrides.caps || '[]',
      overrides.state || 'promoted',
      JSON.stringify(overrides.quality || {
        confidence: 0.8,
        verification: ['queue depth returns to zero'],
        failure_modes: [{ symptom: 'worker crashes', recovery: 'restore from snapshot' }],
      }));
  const r = record(db, {
    userId, conversationId: 'c1', traceId: `t-${id.slice(0, 8)}`, type: 'tool_outcome',
    payload: JSON.stringify({ note: 'drained and restarted' }), outcome: 'success',
    terminalVersion: `av-${id.slice(0, 8)}`,
  });
  if (!r.error) {
    db.prepare(`INSERT INTO candidate_evidence (id, candidate_id, event_id, role, weight, excerpt_hash, created_at)
      VALUES (?, ?, ?, 'success', 1.0, 'h', ?)`).run(randomUUID(), id, r.id, new Date().toISOString());
  }
  return id;
}

function scannerCtx(overrides = {}) {
  return {
    db,
    stmts: {},
    executeSkill: overrides.executeSkill || (async () => { throw new Error('no skills'); }),
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    auditLog: () => {},
  };
}

beforeEach(() => { db = freshDb(); });

describe('decideKind', () => {
  const spec = { kind: 'procedural' };
  it('high risk tier -> script + docker', () => {
    const d = decideKind(spec, 'high', []);
    expect(d.kind).toBe('script');
    expect(d.requires_docker).toBe(true);
    expect(d.rationale).toBeTruthy();
  });
  it('dangerous caps -> script + docker even at low risk', () => {
    const d = decideKind(spec, 'low', ['exec', 'file_read']);
    expect(d.kind).toBe('script');
    expect(d.requires_docker).toBe(true);
  });
  it('informational correction, no caps, low risk -> memory', () => {
    const d = decideKind(spec, 'low', [], 'correction');
    expect(d.kind).toBe('memory');
    expect(d.requires_docker).toBe(false);
  });
  it('safe caps at medium risk -> hybrid + docker', () => {
    const d = decideKind(spec, 'medium', ['file_read']);
    expect(d.kind).toBe('hybrid');
    expect(d.requires_docker).toBe(true);
  });
  it('read-only guidance -> prompt_template', () => {
    const d = decideKind(spec, 'low', []);
    expect(d.kind).toBe('prompt_template');
    expect(d.requires_docker).toBe(false);
    expect(d.rationale).toBeTruthy();
  });
});

describe('compile', () => {
  it('throws a clean error for a missing candidate', () => {
    expect(() => compile(db, 'nope', 'u1')).toThrow(/not found/);
  });
  it('throws for a cross-user candidate (owner-scoped)', () => {
    const id = seedCandidate('u1');
    expect(() => compile(db, id, 'u2')).toThrow(/not found/);
  });
  it('throws when the candidate is not promoted', () => {
    const id = seedCandidate('u1', { state: 'candidate' });
    expect(() => compile(db, id, 'u1')).toThrow(/promoted/);
  });
  it('quarantines an invalid spec without writing anything', () => {
    const id = seedCandidate('u1', { draft: JSON.stringify('prose blob, not steps') });
    const before = db.prepare('SELECT COUNT(*) c FROM learning_skill_versions').get().c;
    const r = compile(db, id, 'u1');
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM learning_skill_versions').get().c).toBe(before);
  });
  it('compiles a happy-path version with a compiled event', () => {
    const id = seedCandidate('u1');
    const r = compile(db, id, 'u1');
    expect(r.ok).toBe(true);
    const v = r.version;
    expect(v.version_number).toBe(1);
    expect(v.kind).toBe('prompt_template');
    expect(v.state).toBe('compiled');
    expect(v.rationale).toBeTruthy();
    expect(v.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.requires_docker).toBe(0);
    const events = db.prepare('SELECT action FROM learning_version_events WHERE version_id = ?').all(v.id);
    expect(events.map(e => e.action)).toEqual(['compiled']);
  });
  it('increments version_number per candidate', () => {
    const id = seedCandidate('u1');
    compile(db, id, 'u1');
    const r2 = compile(db, id, 'u1');
    expect(r2.version.version_number).toBe(2);
  });
  it('compiles a memory artifact as JSON payload', () => {
    const id = seedCandidate('u1', { kind: 'correction' });
    const r = compile(db, id, 'u1');
    expect(r.version.kind).toBe('memory');
    const payload = JSON.parse(r.version.artifact);
    expect(payload.category).toBe('correction');
    expect(payload.content).toBeTruthy();
  });
  it('never emits raw exec strings in script skeletons', () => {
    const id = seedCandidate('u1', { risk_tier: 'high', caps: JSON.stringify(['exec']) });
    const r = compile(db, id, 'u1');
    expect(r.version.kind).toBe('script');
    expect(r.version.requires_docker).toBe(1);
    const artifact = JSON.parse(r.version.artifact);
    expect(artifact.capability_manifest).toEqual(['exec']);
    expect(artifact.handler).not.toMatch(/child_process|execSync|spawn\(/);
  });
});

describe('generateTests / runTests', () => {
  it('derives static checks from verification and failure_modes', async () => {
    const id = seedCandidate('u1');
    const { version } = compile(db, id, 'u1');
    const spec = JSON.parse(version.spec);
    const tests = generateTests(spec, { kind: version.kind, artifact: version.artifact });
    expect(tests).toHaveLength(2); // 1 verification + 1 failure mode
    expect(tests.every(t => t.kind === 'static')).toBe(true);
    for (const t of tests) {
      expect((await t.run()).status).toBe('pass');
    }
  });
  it('adds a dynamic vm-sandboxed check for script kinds', async () => {
    const id = seedCandidate('u1', { risk_tier: 'high', caps: JSON.stringify(['exec']) });
    const { version } = compile(db, id, 'u1');
    const spec = JSON.parse(version.spec);
    const tests = generateTests(spec, { kind: version.kind, artifact: version.artifact });
    const dyn = tests.filter(t => t.kind === 'dynamic');
    expect(dyn).toHaveLength(1);
    expect((await dyn[0].run()).status).toBe('pass');
  });
  it('runTests stores the report and moves to tested', async () => {
    const id = seedCandidate('u1');
    const { version } = compile(db, id, 'u1');
    const r = await runTests(version);
    expect(r.ok).toBe(true);
    expect(r.report.failed).toBe(0);
    const row = db.prepare('SELECT state, test_report FROM learning_skill_versions WHERE id = ?').get(version.id);
    expect(row.state).toBe('tested');
    expect(JSON.parse(row.test_report).passed).toBe(r.report.passed);
    const events = db.prepare('SELECT action FROM learning_version_events WHERE version_id = ? ORDER BY rowid').all(version.id);
    expect(events.map(e => e.action)).toEqual(['compiled', 'tested']);
  });
  it('runTests never throws outward on a broken version object', async () => {
    const r = await runTests(null);
    expect(r.ok).toBe(false);
  });
  it('never executes learned step text: U+2028 comment-breakout is inert (H2)', async () => {
    // The audit's live repro: a learned step action breaking out of its
    // `//` comment via U+2028 and executing in the server process.
    const payload = 'do thing\u2028; throw new Error(\'PWNED-41\'); //'; // contains \u2028
    const id = seedCandidate('u1', {
      risk_tier: 'high',
      caps: JSON.stringify(['exec']),
      draft: JSON.stringify([payload, 'second step']),
    });
    const { version } = compile(db, id, 'u1');
    expect(version.kind).toBe('script');
    const r = await runTests(version);
    expect(r.ok).toBe(true);
    const dyn = r.report.tests.find(t => t.name.includes('validate()'));
    expect(dyn).toBeTruthy();
    expect(dyn.status).toBe('pass');
    // The injected statement must NOT have executed: no test detail may
    // carry the sentinel.
    expect(r.report.tests.some(t => (t.detail || '').includes('PWNED-41'))).toBe(false);
    // Steps survive only as JSON string data plus terminator-stripped
    // comments — no raw line terminators in the evaluated handler.
    const handler = JSON.parse(version.artifact).handler;
    expect(handler).not.toMatch(new RegExp('[\\r\u2028\u2029]'));
    const m = handler.match(/steps:\s*(\[[\s\S]*?\]),\s*\n\s*\/\/ Pure/);
    expect(m).toBeTruthy();
    expect(JSON.parse(m[1])[0].action).toContain('PWNED-41');
  });
});

describe('scanArtifact', () => {
  it('blocks when no scanner skill is installed (fail-closed, H3)', async () => {
    const id = seedCandidate('u1');
    const { version } = compile(db, id, 'u1');
    await runTests(version);
    const v = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(version.id);
    const r = await scanArtifact(v, scannerCtx());
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.verdict.verdict).toBe('no_scanner');
    const row = db.prepare('SELECT state, scanner_verdict FROM learning_skill_versions WHERE id = ?').get(version.id);
    expect(row.state).toBe('rejected');
    expect(JSON.parse(row.scanner_verdict).verdict).toBe('no_scanner');
  });
  it('blocks when the scanner skill is disabled (fail-closed, H3)', async () => {
    db.prepare('INSERT INTO skills (id, name, enabled) VALUES (?, ?, 0)').run('sk1', 'skill-scanner');
    const id = seedCandidate('u1');
    const { version } = compile(db, id, 'u1');
    await runTests(version);
    const v = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(version.id);
    const r = await scanArtifact(v, scannerCtx());
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.verdict.verdict).toBe('scanner_disabled');
    const row = db.prepare('SELECT state FROM learning_skill_versions WHERE id = ?').get(version.id);
    expect(row.state).toBe('rejected');
  });
  it('permits the degraded scan only when LEARNING_REQUIRE_SCANNER=false', async () => {
    process.env.LEARNING_REQUIRE_SCANNER = 'false';
    try {
      const id = seedCandidate('u1');
      const { version } = compile(db, id, 'u1');
      await runTests(version);
      const v = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(version.id);
      const r = await scanArtifact(v, scannerCtx());
      expect(r.ok).toBe(true);
      expect(r.verdict.verdict).toBe('no_scanner');
      const row = db.prepare('SELECT state FROM learning_skill_versions WHERE id = ?').get(version.id);
      expect(row.state).toBe('scanned');
    } finally {
      delete process.env.LEARNING_REQUIRE_SCANNER;
    }
  });
  it('rejects when the scanner gate blocks', async () => {
    db.prepare('INSERT INTO skills (id, name, enabled) VALUES (?, ?, 1)').run('sk1', 'skill-scanner');
    const id = seedCandidate('u1');
    const { version } = compile(db, id, 'u1');
    await runTests(version);
    const v = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(version.id);
    const ctx = scannerCtx({
      executeSkill: async () => ({
        ok: true,
        output: { verdict: 'malicious', blocked: true, risk_score: 99, reasons: ['test'] },
      }),
    });
    ctx.stmts = {
      skills: { getByName: db.prepare('SELECT * FROM skills WHERE name = ?') },
    };
    const r = await scanArtifact(v, ctx);
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    const row = db.prepare('SELECT state FROM learning_skill_versions WHERE id = ?').get(version.id);
    expect(row.state).toBe('rejected');
  });
  it('refuses to scan versions with failing tests', async () => {
    const id = seedCandidate('u1');
    const { version } = compile(db, id, 'u1');
    // Corrupt the artifact so static checks fail, then run tests.
    db.prepare('UPDATE learning_skill_versions SET artifact = ? WHERE id = ?').run('gutted', version.id);
    const v = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(version.id);
    const tr = await runTests(v);
    expect(tr.report.failed).toBeGreaterThan(0);
    const v2 = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(version.id);
    const sr = await scanArtifact(v2, scannerCtx());
    expect(sr.ok).toBe(false);
    expect(sr.error).toMatch(/tests must pass/);
  });
});

describe('executeVersion', () => {
  it('refuses non-docker kinds (shadow mode)', async () => {
    const id = seedCandidate('u1');
    const { version } = compile(db, id, 'u1');
    await expect(executeVersion(version, {}, {})).rejects.toThrow(/shadow mode/);
  });
  it('requires docker for script kinds (unavailable here)', async () => {
    const id = seedCandidate('u1', { risk_tier: 'high', caps: JSON.stringify(['exec']) });
    const { version } = compile(db, id, 'u1');
    await expect(executeVersion(version, {}, {})).rejects.toThrow(/Docker required but unavailable/);
  });
});

describe('recordVersionEvent', () => {
  it('writes events and lists known states', () => {
    const id = seedCandidate('u1');
    const { version } = compile(db, id, 'u1');
    recordVersionEvent(db, version.id, 'approved', 'admin', { note: 'x' });
    const actions = db.prepare('SELECT action FROM learning_version_events WHERE version_id = ? ORDER BY rowid')
      .all(version.id).map(e => e.action);
    expect(actions).toEqual(['compiled', 'approved']);
    expect(VERSION_STATES).toContain('rolled_back');
  });
});

describe('spec round-trip through compile', () => {
  it('the stored spec validates', async () => {
    const { validateSpec } = await import('../src/server/learning/spec.mjs');
    const id = seedCandidate('u1');
    const { version } = compile(db, id, 'u1');
    expect(validateSpec(JSON.parse(version.spec)).ok).toBe(true);
  });
});
