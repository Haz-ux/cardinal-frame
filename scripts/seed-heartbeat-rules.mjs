// Seed production-grade heartbeat rules (idempotent — skips existing names).
// The heartbeat_rules table is EMPTY: alerts broadcast but nothing escalates.
// These rules give the alert pipeline real teeth:
//  - memory_high: heap > 90% (builtin broadcast fires at 85; rule escalates via action)
//  - tasks_stuck: pending > 10 (queue backing up)
//  - tasks_failing: failed tasks spike
//  - agents_stale: > 5 agents stale (heartbeat lapse)
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

const db = new Database('data/cardinal.db');
const stmts = {
  getByName: db.prepare('SELECT id FROM heartbeat_rules WHERE name = ?'),
  insert: db.prepare(`INSERT INTO heartbeat_rules (id, name, description, condition, action_type, action_target, action_input, cooldown_seconds, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`),
};

const RULES = [
  {
    name: 'memory_high',
    description: 'Server heap usage above 90% — check for leaks or restart if sustained',
    condition: 'memory.heap_usage_pct > 90',
    action_type: 'alert',
    action_target: 'heartbeat:alert',
    action_input: '{}',
    cooldown_seconds: 900, // 15 min — don't spam
  },
  {
    name: 'tasks_pending_backlog',
    description: 'More than 10 pending tasks — job queue backing up, check worker health',
    condition: 'tasks.pending > 10',
    action_type: 'alert',
    action_target: 'heartbeat:alert',
    action_input: '{}',
    cooldown_seconds: 1800, // 30 min
  },
  {
    name: 'agents_stale',
    description: 'More than 5 agents stale (no heartbeat in 5 min) — agent fleet unhealthy',
    condition: 'agents.stale > 5',
    action_type: 'alert',
    action_target: 'heartbeat:alert',
    action_input: '{}',
    cooldown_seconds: 1800,
  },
  {
    name: 'providers_down',
    description: 'All LLM providers disabled or unreachable — chat will fail',
    condition: 'providers.enabled == 0',
    action_type: 'alert',
    action_target: 'heartbeat:alert',
    action_input: '{}',
    cooldown_seconds: 3600, // 1 hour
  },
];

let created = 0;
for (const r of RULES) {
  if (stmts.getByName.get(r.name)) { console.log(`  skip (exists): ${r.name}`); continue; }
  stmts.insert.run(randomUUID(), r.name, r.description, r.condition, r.action_type, r.action_target, r.action_input, r.cooldown_seconds);
  console.log(`  ✅ ${r.name}: ${r.condition} (cooldown ${r.cooldown_seconds}s)`);
  created++;
}
console.log(`\n${created} rules created`);
