import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { record } from '../src/server/learning/events.mjs';
import {
  runReviewJob, classifyEvent, groupEvidence, scoreCandidate, assessRisk,
  REVIEW_CONFIG,
} from '../src/server/learning/reviewer.mjs';
import {
  getCandidate, listCandidates, approveCandidate, rejectCandidate,
  getCandidateEvidence,
} from '../src/server/learning/candidates.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

let db;
let tv = 0;

function freshDb() {
  const d = new Database(':memory:');
  for (const f of ['014_learning_events.sql', '022_learning_events.sql', '026_learning_candidates.sql',
                   '028_learning_skill_versions.sql', '032_learning_skill_versions_one_active.sql']) {
    d.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return d;
}

function seedEvent({ userId = 'user-a', conversationId = 'c', traceId = 't', type, payload, outcome }) {
  const r = record(db, {
    userId, conversationId, traceId, type, payload, outcome,
    terminalVersion: `rv${++tv}`,
  });
  if (r.error) throw new Error(`seed failed: ${r.error}`);
  return r.id;
}

function seedMalformed(userId, traceId) {
  db.prepare(`INSERT INTO learning_events
    (id, kind, user_id, conversation_id, trace_id, type, payload, outcome,
     redaction_status, idempotency_key, evidence, source_tier, status)
    VALUES (?, 'tool_outcome', ?, 'c-bad', ?, 'tool_outcome', 'not-json{{{',
            'completed', 'clean', ?, '{}', 'agent', 'pending')`)
    .run(randomUUID(), userId, traceId, randomUUID());
}

function candidateForTrace(userId, traceId) {
  const row = db.prepare(`SELECT c.id FROM learning_candidates c
    JOIN candidate_evidence e ON e.candidate_id = c.id
    JOIN learning_events le ON le.id = e.event_id
    WHERE c.user_id = ? AND le.trace_id = ? LIMIT 1`).get(userId, traceId);
  return row ? getCandidate(db, row.id, userId) : null;
}

beforeEach(() => {
  db = freshDb();
  delete process.env.LEARNING_REVIEW_BUDGET;
});

afterEach(() => {
  db.close();
  delete process.env.LEARNING_REVIEW_BUDGET;
});

describe('eligibility', () => {
  it('assembles a candidate from verified successes', async () => {
    const u = 'u-eligible';
    seedEvent({ userId: u, traceId: 't1', type: 'tool_outcome', payload: { tool: 'file_read' }, outcome: 'completed' });
    seedEvent({ userId: u, traceId: 't1', type: 'tool_outcome', payload: { tool: 'file_read' }, outcome: 'completed' });
    const job = await runReviewJob({ db, userId: u });
    expect(job.status).toBe('completed');
    expect(job.candidates_assembled).toBe(1);
    const c = candidateForTrace(u, 't1');
    expect(c.kind).toBe('procedure');
    expect(c.state).toBe('candidate');
    expect(c.support_verified).toBe(2);
  });

  it("accepts the plan's terminal_turn type naming too", async () => {
    const u = 'u-typename';
    seedEvent({ userId: u, traceId: 't1', type: 'terminal_turn', payload: { text: 'done' }, outcome: 'success' });
    const job = await runReviewJob({ db, userId: u });
    expect(job.candidates_assembled).toBe(1);
  });

  it('never assembles praise-only messages', async () => {
    const u = 'u-praise';
    seedEvent({ userId: u, traceId: 't1', type: 'user_message', payload: { text: 'great job, thanks!' }, outcome: 'unknown' });
    const job = await runReviewJob({ db, userId: u });
    expect(job.candidates_assembled).toBe(0);
    expect(listCandidates(db, u, null)).toHaveLength(0);
    // …but the event is still marked reviewed
    const row = db.prepare(`SELECT review_status FROM learning_events WHERE trace_id = 't1'`).get();
    expect(row.review_status).toBe('reviewed');
  });

  it('ignores awaiting_approval and unknown outcomes', async () => {
    const u = 'u-outcomes';
    seedEvent({ userId: u, traceId: 't1', type: 'turn_terminal', payload: { text: 'waiting' }, outcome: 'awaiting_approval' });
    seedEvent({ userId: u, traceId: 't2', type: 'tool_outcome', payload: { tool: 'x' }, outcome: 'unknown' });
    const job = await runReviewJob({ db, userId: u });
    expect(job.candidates_assembled).toBe(0);
  });

  it('does not learn from unrecovered failures', async () => {
    const u = 'u-unrecovered';
    seedEvent({ userId: u, traceId: 't1', type: 'tool_outcome', payload: { tool: 'shell_exec' }, outcome: 'failed' });
    const job = await runReviewJob({ db, userId: u });
    expect(job.candidates_assembled).toBe(0);
  });

  it('pairs a failure with a later success into a recovery candidate', async () => {
    const u = 'u-recovery';
    seedEvent({ userId: u, traceId: 't1', type: 'tool_outcome', payload: { tool: 'shell_exec', command: 'deploy' }, outcome: 'failed' });
    seedEvent({ userId: u, traceId: 't1', type: 'tool_outcome', payload: { tool: 'shell_exec', command: 'deploy --fix' }, outcome: 'completed' });
    const job = await runReviewJob({ db, userId: u });
    expect(job.candidates_assembled).toBe(1);
    const c = candidateForTrace(u, 't1');
    expect(c.kind).toBe('recovery');
    expect(c.support_recovered).toBe(2);
    const ev = getCandidateEvidence(db, c.id, u);
    expect(ev.map((e) => e.role).sort()).toEqual(['recovery_action', 'recovery_trigger']);
  });

  it('treats user_correction as a correction candidate', async () => {
    const u = 'u-correction';
    seedEvent({ userId: u, conversationId: 'conv1', traceId: 't1', type: 'user_correction', payload: { text: 'use staging' }, outcome: 'unknown' });
    const job = await runReviewJob({ db, userId: u });
    expect(job.candidates_assembled).toBe(1);
    const c = candidateForTrace(u, 't1');
    expect(c.kind).toBe('correction');
    expect(c.support_corrections).toBe(1);
  });

  it('treats user_message with payload.correction=true as a correction', async () => {
    const u = 'u-correction2';
    seedEvent({ userId: u, conversationId: 'conv1', traceId: 't1', type: 'user_message', payload: { correction: true, text: 'no, the other one' }, outcome: 'unknown' });
    const job = await runReviewJob({ db, userId: u });
    expect(job.candidates_assembled).toBe(1);
    expect(candidateForTrace(u, 't1').kind).toBe('correction');
  });

  it('classifyEvent returns null for ineligible events and throws on malformed payload', () => {
    expect(classifyEvent({ type: 'user_message', outcome: 'unknown', payload: '{}' })).toBeNull();
    expect(() => classifyEvent({ type: 'tool_outcome', outcome: 'completed', payload: 'nope{{{' })).toThrow();
  });
});

describe('grouping', () => {
  it('keeps interleaved traces separate', () => {
    const mk = (traceId, outcome, n) => ({
      row: { id: `e${n}`, trace_id: traceId, conversation_id: 'c', created_at: new Date().toISOString(), payload: '{}', type: 'tool_outcome', outcome },
      payload: {}, outcome, correction: false,
    });
    const items = [
      mk('t1', 'success', 1), mk('t2', 'failed', 2), mk('t1', 'success', 3), mk('t2', 'success', 4),
    ];
    const groups = groupEvidence(items);
    expect(groups).toHaveLength(2);
    const kinds = Object.fromEntries(groups.map((g) => [g.key, g.kind]));
    expect(kinds).toEqual({ t1: 'procedure', t2: 'recovery' });
  });
});

describe('scoring math', () => {
  const mkItem = (outcome, trace, role) => ({
    row: { trace_id: trace, conversation_id: 'c', id: randomUUID(), created_at: new Date().toISOString() },
    payload: {}, outcome, role, weight: 1,
  });

  it('is deterministic', () => {
    const items = [mkItem('success', 't', 'success'), mkItem('success', 't', 'success')];
    expect(scoreCandidate(items, 'low').promotionScore).toBe(scoreCandidate(items, 'low').promotionScore);
  });

  it('matches the documented formula: 3 successes, low risk → 2.625', () => {
    const items = [mkItem('success', 't', 'success'), mkItem('success', 't', 'success'), mkItem('success', 't', 'success')];
    const s = scoreCandidate(items, 'low');
    // support=3; quality=0.35*1 + 0.25*0.6 + 0.2*1 + 0.1*~1 + 0.1*0.75 = 0.875
    expect(s.support).toBe(3);
    expect(s.quality.quality).toBeCloseTo(0.875, 6);
    expect(s.promotionScore).toBeCloseTo(2.625, 6);
  });

  it('applies support weights: verified + 1.5*recovered + 2*corrections', () => {
    const items = [
      mkItem('success', 't', 'success'),
      mkItem('failed', 't', 'recovery_trigger'),
      mkItem('success', 't', 'recovery_action'),
      mkItem('unknown', 't', 'correction'),
    ];
    const s = scoreCandidate(items, 'low');
    expect(s.supportVerified).toBe(1);
    expect(s.supportRecovered).toBe(2);
    expect(s.supportCorrections).toBe(1);
    expect(s.support).toBe(1 + 1.5 * 2 + 2 * 1); // 6
  });

  it('applies risk penalties: 0 low, 0.3 medium, 0.6 high', () => {
    const items = [mkItem('success', 't', 'success'), mkItem('success', 't', 'success')];
    const low = scoreCandidate(items, 'low').promotionScore;
    expect(scoreCandidate(items, 'medium').promotionScore).toBeCloseTo(low * 0.7, 9);
    expect(scoreCandidate(items, 'high').promotionScore).toBeCloseTo(low * 0.4, 9);
  });

  it('rewards multi-trace generality (1.0 vs 0.6)', () => {
    const single = [mkItem('success', 't', 'success'), mkItem('success', 't', 'success')];
    const multi = [mkItem('success', 't1', 'success'), mkItem('success', 't2', 'success')];
    expect(scoreCandidate(single, 'low').quality.generality).toBe(0.6);
    expect(scoreCandidate(multi, 'low').quality.generality).toBe(1);
  });
});

describe('risk guard pass', () => {
  const mk = (payload) => [{ payload, row: {} }];

  it('flags wildcard exec as high', () => {
    const { riskTier, requestedCaps } = assessRisk(mk({ tool: 'shell_exec', command: 'rm *' }));
    expect(riskTier).toBe('high');
    expect(requestedCaps).toContain('exec: *');
  });

  it('flags destructive payload patterns as high', () => {
    expect(assessRisk(mk({ tool: 'shell_exec', command: 'DROP TABLE users' })).riskTier).toBe('high');
    expect(assessRisk(mk({ tool: 'shell_exec', command: 'rm -rf /' })).riskTier).toBe('high');
  });

  it('rates plain exec tools medium and read tools low', () => {
    expect(assessRisk(mk({ tool: 'shell_exec', command: 'ls /tmp' })).riskTier).toBe('medium');
    expect(assessRisk(mk({ tool: 'file_read', path: '/x' })).riskTier).toBe('low');
  });

  it('creates high-risk candidates in state=candidate (never auto-anything)', async () => {
    const u = 'u-highrisk';
    seedEvent({ userId: u, traceId: 't1', type: 'tool_outcome', payload: { tool: 'shell_exec', command: 'rm -rf /tmp/*' }, outcome: 'completed' });
    await runReviewJob({ db, userId: u });
    const c = candidateForTrace(u, 't1');
    expect(c.risk_tier).toBe('high');
    expect(c.state).toBe('candidate');
    // …but Haz's explicit approve still works
    expect(approveCandidate(db, c.id, u).state).toBe('promoted');
  });
});

describe('budget', () => {
  it('stops assembling at LEARNING_REVIEW_BUDGET but still marks events reviewed', async () => {
    process.env.LEARNING_REVIEW_BUDGET = '1';
    const u = 'u-budget';
    for (let i = 0; i < 3; i++) {
      seedEvent({ userId: u, conversationId: `c${i}`, traceId: `t${i}`, type: 'tool_outcome', payload: { tool: 'file_read' }, outcome: 'completed' });
    }
    const job = await runReviewJob({ db, userId: u });
    expect(job.candidates_assembled).toBe(1);
    expect(job.budget_used).toBe(1);
    const pending = db.prepare(`SELECT COUNT(*) c FROM learning_events WHERE user_id = ? AND review_status = 'pending'`).get(u).c;
    expect(pending).toBe(0);
    expect(listCandidates(db, u, null)).toHaveLength(1);
  });

  it('uses the default budget of 20 when unset', () => {
    expect(REVIEW_CONFIG.defaultBudget).toBe(20);
  });
});

describe('dead-letter', () => {
  it('dead-letters malformed events and still completes the job', async () => {
    const u = 'u-dead';
    seedMalformed(u, 't-bad');
    seedEvent({ userId: u, traceId: 't-good', type: 'tool_outcome', payload: { tool: 'file_read' }, outcome: 'completed' });
    const job = await runReviewJob({ db, userId: u });
    expect(job.status).toBe('completed');
    expect(job.dead_lettered).toBe(1);
    expect(job.candidates_assembled).toBe(1);
    const row = db.prepare(`SELECT review_status, review_note FROM learning_events WHERE trace_id = 't-bad'`).get();
    expect(row.review_status).toBe('dead_lettered');
    expect(row.review_note).toMatch(/classify/);
  });
});

describe('dedupe + reopen', () => {
  it('does not create a second open candidate for the same trace', async () => {
    const u = 'u-dedupe';
    seedEvent({ userId: u, traceId: 't1', type: 'tool_outcome', payload: { tool: 'file_read' }, outcome: 'completed' });
    await runReviewJob({ db, userId: u });
    const job2 = await runReviewJob({ db, userId: u });
    expect(job2.candidates_assembled).toBe(0);
    expect(listCandidates(db, u, null)).toHaveLength(1);
  });

  it('reopens a rejected candidate when fresh evidence arrives after cooldown', async () => {
    const u = 'u-reopen';
    seedEvent({ userId: u, traceId: 't1', type: 'tool_outcome', payload: { tool: 'file_read' }, outcome: 'completed' });
    await runReviewJob({ db, userId: u });
    const c = candidateForTrace(u, 't1');
    rejectCandidate(db, c.id, u, 'stale');
    db.prepare(`UPDATE learning_candidates SET cooldown_until = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), c.id);

    seedEvent({ userId: u, traceId: 't1', type: 'tool_outcome', payload: { tool: 'file_read' }, outcome: 'completed' });
    const job = await runReviewJob({ db, userId: u });
    expect(job.candidates_assembled).toBe(1);
    expect(getCandidate(db, c.id, u).state).toBe('candidate');
    expect(listCandidates(db, u, null)).toHaveLength(1);
    expect(getCandidateEvidence(db, c.id, u)).toHaveLength(2);
    // refreshed stats reflect ALL linked evidence, not just the newest batch
    expect(getCandidate(db, c.id, u).support_verified).toBe(2);
  });

  it('skips traces whose rejected candidate is still in cooldown', async () => {
    const u = 'u-cooldown';
    seedEvent({ userId: u, traceId: 't1', type: 'tool_outcome', payload: { tool: 'file_read' }, outcome: 'completed' });
    await runReviewJob({ db, userId: u });
    const c = candidateForTrace(u, 't1');
    rejectCandidate(db, c.id, u, 'nope'); // fresh 30d cooldown
    seedEvent({ userId: u, traceId: 't1', type: 'tool_outcome', payload: { tool: 'file_read' }, outcome: 'completed' });
    const job = await runReviewJob({ db, userId: u });
    expect(job.candidates_assembled).toBe(0);
    expect(getCandidate(db, c.id, u).state).toBe('rejected');
  });
});

describe('never throws', () => {
  it('returns a failed job row instead of throwing on DB errors', async () => {
    const brokenDb = { prepare: () => { throw new Error('no such table'); } };
    const job = await runReviewJob({ db: brokenDb, userId: 'u' });
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/no such table/);
  });

  it('requires a userId', async () => {
    const job = await runReviewJob({ db });
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/userId/);
  });
});

describe('reject rolls back versions in the same transaction (M6)', () => {
  function seedVersionRow(vid, userId, candId, state, n) {
    db.prepare(`INSERT INTO learning_skill_versions
      (id, user_id, candidate_id, version_number, kind, spec, artifact, content_hash, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'prompt_template', '{}', 'a', 'h', ?, datetime('now'), datetime('now'))`)
      .run(vid, userId, candId, n, state);
  }
  const vstate = (id) => db.prepare('SELECT state FROM learning_skill_versions WHERE id = ?').get(id).state;

  it("rolls back active/approved versions with a version event, leaves others alone", () => {
    const u = 'u-rejv';
    const cid = 'c-rejv';
    db.prepare(`INSERT INTO learning_candidates
      (id, user_id, kind, title, draft, risk_tier, state, created_at, updated_at)
      VALUES (?, ?, 'procedure', 't', '[]', 'low', 'promoted', datetime('now'), datetime('now'))`)
      .run(cid, u);
    seedVersionRow('v-a', u, cid, 'active', 1);
    seedVersionRow('v-p', u, cid, 'approved', 2);
    seedVersionRow('v-s', u, cid, 'scanned', 3);
    const c = rejectCandidate(db, cid, u, 'bad idea');
    expect(c.state).toBe('rejected');
    expect(vstate('v-a')).toBe('rolled_back');
    expect(vstate('v-p')).toBe('rolled_back');
    expect(vstate('v-s')).toBe('scanned');
    const ev = db.prepare("SELECT action, detail FROM learning_version_events WHERE version_id = 'v-a'").get();
    expect(ev.action).toBe('rolled_back');
    expect(JSON.parse(ev.detail).reason).toBe('candidate rejected');
  });

  it('is atomic: a version-write failure leaves the candidate un-rejected', () => {
    const u = 'u-rejatom';
    const cid = 'c-rejatom';
    db.prepare(`INSERT INTO learning_candidates
      (id, user_id, kind, title, draft, risk_tier, state, created_at, updated_at)
      VALUES (?, ?, 'procedure', 't', '[]', 'low', 'candidate', datetime('now'), datetime('now'))`)
      .run(cid, u);
    db.exec('DROP TABLE learning_skill_versions'); // force the version rollback to throw
    expect(() => rejectCandidate(db, cid, u, 'x')).toThrow();
    expect(getCandidate(db, cid, u).state).toBe('candidate');
  });
});
