/**
 * Cardinal Frame — Learning Phase 4: skill compiler (versions + test gate).
 *
 * Compiles PROMOTED learning candidates into immutable skill versions:
 *
 *   candidate --(buildSpec)--> spec --(validateSpec)--> decideKind
 *     --(artifact)--> version row (state=compiled)
 *     --(generateTests + runTests)--> state=tested
 *     --(scanArtifact)--> state=scanned | rejected
 *     --(admin approve)--> approved --(admin activate)--> active
 *
 * SHADOW MODE: everything generated ships DISABLED. Even an 'active'
 * version never executes or routes live traffic — executeVersion() enforces
 * that in code for non-Docker kinds, and Docker kinds are gated on
 * Docker availability plus the docker-only rule.
 *
 * Public surface (all defensive — never throw outward except programmer
 * errors such as missing required arguments):
 *   decideKind(spec, riskTier, requestedCaps, candidateKind?)
 *   compile(db, candidateId, userId) -> { ok, version } | { ok: false, errors }
 *     (throws clean Errors only for missing/not-owned/not-promoted candidates)
 *   generateTests(spec, artifactInfo?) -> [{ name, kind, check, run }]
 *   runTests(version) -> { ok, report } | { ok: false, error }
 *   scanArtifact(version, ctx) -> { ok, verdict } | { ok: false, error|blocked }
 *   executeVersion(version, input, ctx) -> Promise (throws clean Errors)
 *   recordVersionEvent(db, versionId, action, actor, detail)
 */

import { randomUUID, createHash } from 'node:crypto';
import { Script, createContext } from 'node:vm';
import { isDockerAvailable, executeInDocker } from '../routes/docker-backend.mjs';
import { runScannerGate } from '../skill-scanner-gate.mjs';
import { buildSpec, validateSpec } from './spec.mjs';
import { getCandidate, getCandidateEvidence } from './candidates.mjs';

// Version rows are plain better-sqlite3 objects; runTests/scanArtifact
// need the db handle. compile() registers it here by version id so the
// public signatures stay (version)-only.
const DBS = new Map();

export const VERSION_STATES = [
  'compiled', 'tested', 'scanned', 'approved', 'active', 'rolled_back', 'rejected',
];

// Every line terminator V8 treats as ending a `//` comment. \n is not
// enough: \r, \u2028 and \u2029 also terminate line comments, which is
// exactly how learned step text broke out of its comment (H2). Strip all
// of them from any interpolation into evaluated code.
const LINE_TERMINATORS_RE = /[\r\n\u2028\u2029]/g;

function stripLineTerminators(value) {
  return String(value ?? '').replace(LINE_TERMINATORS_RE, ' ');
}

/**
 * LEARNING_REQUIRE_SCANNER — fail-closed switch for the learning scanner
 * gate (H3). Defaults to TRUE: when the skill-scanner skill is missing or
 * disabled, learning versions are BLOCKED instead of waved through with a
 * 'no_scanner' verdict. Set explicitly to 'false' to allow the old
 * degraded behavior; the approve route then requires an explicit admin
 * acknowledgement (acknowledge_no_scanner: true). Read at call time so
 * tests/operators can toggle it without a restart of this module.
 */
export function learningRequiresScanner() {
  return process.env.LEARNING_REQUIRE_SCANNER !== 'false';
}

// Capability fragments that put a version in the Docker-only bucket.
// Matching is case-insensitive substring on each requested cap.
const DOCKER_CAPS = [
  'exec', 'shell', 'command', 'network', 'net', 'http', 'fetch', 'url',
  'credential', 'secret', 'token', 'password', 'destructive', 'write',
  'delete', 'admin', 'filesystem', 'fs', 'process', 'spawn',
];

/**
 * Record a version lifecycle event. Never throws (best-effort audit
 * trail), but a failed write is logged via console.warn — silently
 * dropping lifecycle events would hide audit gaps (L12).
 */
export function recordVersionEvent(db, versionId, action, actor, detail = {}) {
  try {
    db.prepare(`INSERT INTO learning_version_events
        (id, version_id, action, actor, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), versionId, action, actor || null,
        JSON.stringify(detail || {}), new Date().toISOString());
  } catch (err) {
    console.warn(`[learning] recordVersionEvent failed for ${versionId} (${action}): ${err?.message || err}`);
  }
}

/**
 * Deterministic kind decision. Rules, in order:
 *   1. HIGH risk tier, or any requested cap touching exec/network/
 *      credentials/destructive surface -> script + requires_docker.
 *   2. Informational-only (correction kind, no caps, low risk) -> memory.
 *   3. Safe caps present + medium risk -> hybrid (deterministic checks
 *      mixed with judgment) + requires_docker.
 *   4. Otherwise -> prompt_template (read-only checks / guidance).
 */
export function decideKind(spec, riskTier, requestedCaps, candidateKind = null) {
  // L12: trim before the HIGH comparison — a trailing space ('high ')
  // must not slip past the docker-only branch.
  const tier = String(riskTier || 'low').trim().toLowerCase();
  const caps = (Array.isArray(requestedCaps) ? requestedCaps : []).map(c => String(c).toLowerCase());
  const dangerous = caps.filter(c => DOCKER_CAPS.some(k => c.includes(k)));
  const uniqueCaps = [...new Set(caps)];

  if (tier === 'high' || dangerous.length > 0) {
    const why = tier === 'high'
      ? 'Candidate is high risk tier: only isolated Docker execution is acceptable.'
      : `Requested capabilities (${dangerous.join(', ')}) touch exec/network/credentials/destructive surface: Docker isolation required.`;
    return {
      kind: 'script',
      requires_docker: true,
      rationale: `${why} Compiled as a capability-manifested script skeleton (no raw exec strings); Docker-only per the Docker-only rule.`,
    };
  }

  if (candidateKind === 'correction' && caps.length === 0 && tier === 'low') {
    return {
      kind: 'memory',
      requires_docker: false,
      rationale: 'Informational correction with no requested capabilities and low risk: best served as a memory entry, not a procedure.',
    };
  }

  if (caps.length > 0 && tier === 'medium') {
    return {
      kind: 'hybrid',
      requires_docker: true,
      rationale: `Safe capabilities (${uniqueCaps.join(', ')}) at medium risk mix deterministic checks with judgment calls: hybrid skill with Docker-only execution.`,
    };
  }

  return {
    kind: 'prompt_template',
    requires_docker: false,
    rationale: caps.length === 0
      ? 'Read-only guidance with no requested capabilities: a prompt template is sufficient; no execution surface.'
      : `Low-risk capabilities (${uniqueCaps.join(', ')}) need no execution: rendered as a prompt template.`,
  };
}

function md(lines) {
  return lines.join('\n');
}

function renderPromptTemplate(candidate, spec) {
  const steps = spec.procedure
    .map(p => `${p.step}. ${p.action}\n   *Why:* ${p.why}`)
    .join('\n');
  return md([
    `# ${spec.problem_signature}`,
    '',
    `> Compiled by Cardinal Frame learning (Phase 4). Evidence events: ${spec.evidence_event_ids.length}. Confidence: ${Math.round(spec.confidence * 100)}%.`,
    '> **Shadow mode — disabled. Guidance only; nothing executes.**',
    '',
    '## Prerequisites',
    ...(spec.preconditions.length ? spec.preconditions.map(p => `- ${p}`) : ['- None recorded.']),
    '',
    '## Procedure',
    steps,
    '',
    '## Verification checklist',
    ...spec.verification.map(v => `- [ ] ${v}`),
    '',
    '## Failure modes',
    ...spec.failure_modes.map(f => `- **${f.symptom}** → ${f.recovery}`),
    ...(spec.do_not_use_when.length ? ['', '## Do not use when', ...spec.do_not_use_when.map(d => `- ${d}`)] : []),
    '',
    `*Source candidate: ${candidate.title} (${candidate.kind}, risk ${candidate.risk_tier}).*`,
  ]);
}

function renderMemory(candidate, spec) {
  const content = [
    `Learned: ${spec.problem_signature}`,
    `Procedure: ${spec.procedure.map(p => `${p.step}) ${p.action}`).join(' ')}`,
    `Verify: ${spec.verification.join(' ')}`,
    `Failure modes: ${spec.failure_modes.map(f => `${f.symptom} -> ${f.recovery}`).join(' ')}`,
  ].join(' ');
  return JSON.stringify({
    category: candidate.kind || 'procedure',
    content,
    confidence: spec.confidence,
    evidence_event_ids: spec.evidence_event_ids,
  });
}

// Safe handler skeleton for script/hybrid kinds. Learned step text is
// embedded as JSON string DATA (it can never become code), and the
// human-readable `//` comments are stripped of every V8 line terminator
// (H2). The only executable part is the pure validate() function (no I/O),
// which the test gate runs in a vm sandbox. run() always refuses:
// execution is not wired (shadow mode).
function renderHandlerSkeleton(kind, candidate, spec, caps) {
  // Defense in depth: step text exists here twice — once as JSON-encoded
  // string data (string literals cannot break out of themselves), and once
  // as terminator-stripped `//` comments for human readability. validate()
  // never touches learned text at all.
  const stepData = (spec.procedure || []).map(p => ({
    step: Number(p && p.step) || 0,
    action: String(p && p.action != null ? p.action : ''),
    why: String(p && p.why != null ? p.why : ''),
  }));
  const stepComments = stepData
    .map(p => `    // ${p.step}. ${stripLineTerminators(p.action)}`)
    .join('\n');
  const manifest = JSON.stringify({
    kind,
    requires_docker: true,
    capabilities: caps,
    candidate_id: candidate.id,
    evidence_event_ids: spec.evidence_event_ids,
  }, null, 2);
  return `// Cardinal Frame compiled ${kind} handler — SHADOW MODE.
// Not installed, not executed. Docker-only execution is enforced by
// executeVersion() in src/server/learning/compiler.mjs.
module.exports = {
  manifest: ${manifest},
  // Procedure steps from the validated spec, as JSON string data only —
  // learned text is data here, never interpolated into executable code.
  steps: ${JSON.stringify(stepData, null, 2)},
  // Pure input validation (no I/O). The test gate executes this in a
  // sandboxed vm context.
  validate(input) {
    const errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      errors.push('input must be an object');
      return { ok: false, errors };
    }
    return { ok: errors.length === 0, errors };
  },
  // Skill body. Procedure steps (from the validated spec) are comments,
  // never raw exec strings.
  async run(input) {
    const v = this.validate(input);
    if (!v.ok) throw new Error('invalid input: ' + v.errors.join('; '));
${stepComments}
    throw new Error('shadow mode — execution not wired');
  },
};
`;
}

function renderArtifact(kind, candidate, spec, caps) {
  if (kind === 'prompt_template') return renderPromptTemplate(candidate, spec);
  if (kind === 'memory') return renderMemory(candidate, spec);
  // script | hybrid
  return JSON.stringify({
    kind,
    requires_docker: true,
    capability_manifest: caps,
    handler: renderHandlerSkeleton(kind, candidate, spec, caps),
  });
}

/**
 * Full compile pipeline for one promoted candidate.
 * Returns { ok: true, version } (version = raw DB row), or
 * { ok: false, errors } when the spec is invalid (quarantined — nothing
 * is written). Throws clean Errors for missing / not-owned /
 * not-promoted candidates.
 */
export function compile(db, candidateId, userId) {
  if (!db) throw new Error('db is required');
  if (!candidateId || !userId) throw new Error('candidateId and userId are required');

  const candidate = getCandidate(db, candidateId, userId); // owner-scoped
  if (!candidate) throw new Error('candidate not found');
  if (candidate.state !== 'promoted') {
    throw new Error(`candidate must be in promoted state to compile (state=${candidate.state})`);
  }

  const evidence = getCandidateEvidence(db, candidateId, userId);
  const spec = buildSpec(candidate, evidence);
  const validation = validateSpec(spec);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors }; // quarantine: no DB writes
  }

  let caps = [];
  try {
    const parsed = JSON.parse(candidate.requested_caps || '[]');
    if (Array.isArray(parsed)) caps = parsed.map(c => String(c));
  } catch { caps = []; }

  const decision = decideKind(spec, candidate.risk_tier, caps, candidate.kind);
  const artifact = renderArtifact(decision.kind, candidate, spec, caps);
  const contentHash = createHash('sha256')
    .update(`${decision.kind}\n${artifact}`)
    .digest('hex');

  const maxRow = db.prepare(
    'SELECT MAX(version_number) AS m FROM learning_skill_versions WHERE candidate_id = ?')
    .get(candidateId);
  const next = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
  const now = new Date().toISOString();
  const id = randomUUID();

  db.prepare(`INSERT INTO learning_skill_versions
      (id, user_id, candidate_id, version_number, kind, spec, rationale,
       artifact, content_hash, requires_docker, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'compiled', ?, ?)`)
    .run(id, userId, candidateId, next, decision.kind, JSON.stringify(spec),
      decision.rationale, artifact, contentHash,
      decision.requires_docker ? 1 : 0, now, now);

  recordVersionEvent(db, id, 'compiled', userId, {
    version_number: next,
    kind: decision.kind,
    requires_docker: decision.requires_docker,
    evidence_events: spec.evidence_event_ids.length,
  });

  const version = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(id);
  DBS.set(id, db);
  return { ok: true, version };
}

/**
 * Derive gate tests from a spec. Each verification condition becomes a
 * static check (the artifact must contain the condition); each failure
 * mode becomes a static check (the recovery path must be documented).
 * For script/hybrid artifacts, one dynamic check runs the skeleton's
 * pure validate() in a vm sandbox (no I/O available there).
 *
 * artifactInfo is optional: { kind, artifact }. Without it, only static
 * checks are produced.
 */
export function generateTests(spec, artifactInfo = {}) {
  const tests = [];
  const artifact = typeof artifactInfo.artifact === 'string' ? artifactInfo.artifact : '';
  const kind = artifactInfo.kind || null;

  const contains = (needle) => artifact.includes(needle);

  (spec.verification || []).forEach((cond, i) => {
    const condStr = String(cond);
    tests.push({
      name: `verification[${i + 1}] documented`,
      kind: 'static',
      check: `artifact documents the verification condition: "${condStr}"`,
      run: async () => contains(condStr)
        ? { status: 'pass', detail: 'condition present in artifact' }
        : { status: 'fail', detail: 'verification condition missing from artifact' },
    });
  });

  (spec.failure_modes || []).forEach((fm, i) => {
    const symptom = String(fm.symptom || '');
    const recovery = String(fm.recovery || '');
    tests.push({
      name: `failure_mode[${i + 1}] recovery documented`,
      kind: 'static',
      check: `recovery path for "${symptom}" is documented`,
      run: async () => (contains(recovery) && contains(symptom))
        ? { status: 'pass', detail: 'symptom and recovery present in artifact' }
        : { status: 'fail', detail: 'failure mode or recovery missing from artifact' },
    });
  });

  if (kind === 'script' || kind === 'hybrid') {
    tests.push({
      name: 'skeleton validate() pure function',
      kind: 'dynamic',
      check: 'handler skeleton exposes a pure validate() that returns a well-formed verdict (run in a vm sandbox, no I/O)',
      run: async () => {
        try {
          const parsed = JSON.parse(artifact);
          const handler = parsed.handler;
          if (!handler || typeof handler !== 'string') {
            return { status: 'fail', detail: 'artifact has no handler skeleton' };
          }
          const sandbox = { module: { exports: {} }, exports: {} };
          createContext(sandbox);
          new Script(handler, { timeout: 2000 }).runInContext(sandbox, { timeout: 2000 });
          const mod = sandbox.module.exports;
          if (!mod || typeof mod.validate !== 'function') {
            return { status: 'fail', detail: 'handler exposes no validate() function' };
          }
          const res = await mod.validate({ dry_run: true });
          if (res && typeof res.ok === 'boolean' && Array.isArray(res.errors)) {
            return { status: 'pass', detail: `validate() returned { ok: ${res.ok} } with no I/O` };
          }
          return { status: 'fail', detail: 'validate() returned a malformed verdict' };
        } catch (err) {
          return { status: 'fail', detail: `validate() threw: ${err.message}` };
        }
      },
    });
  }

  return tests;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`test timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Execute the gate tests for a compiled version, in isolation:
 *  - static checks run directly,
 *  - dynamic checks run with a 5s timeout inside a vm sandbox with no
 *    I/O (see generateTests); no network access; no FS writes.
 *
 * Stores test_report JSON on the row, sets state='tested', writes a
 * 'tested' event. Any failure leaves failed>0 and the pipeline refuses
 * to proceed (scan/activate reject it). Never throws outward.
 */
export async function runTests(version) {
  const db = version && version.id ? DBS.get(version.id) : null;
  if (!db || !version) return { ok: false, error: 'version is required (compile it first)' };
  try {
    let spec;
    try {
      spec = JSON.parse(version.spec);
    } catch {
      return { ok: false, error: 'version has no parseable spec' };
    }
    const tests = generateTests(spec, { kind: version.kind, artifact: version.artifact || '' });
    const results = [];
    let passed = 0;
    let failed = 0;
    for (const t of tests) {
      try {
        const r = t.kind === 'dynamic'
          ? await withTimeout(Promise.resolve().then(() => t.run()), 5000)
          : await t.run();
        const status = r && r.status === 'pass' ? 'pass' : 'fail';
        if (status === 'pass') passed++; else failed++;
        results.push({ name: t.name, status, detail: (r && r.detail) || '' });
      } catch (err) {
        failed++;
        results.push({ name: t.name, status: 'fail', detail: `threw: ${err.message}` });
      }
    }
    const now = new Date().toISOString();
    const report = { passed, failed, tests: results, ran_at: now };
    db.prepare(`UPDATE learning_skill_versions
      SET test_report = ?, state = 'tested', updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(report), now, version.id);
    recordVersionEvent(db, version.id, 'tested', version.user_id, { passed, failed });
    return { ok: true, report };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Run the pre-ingest scanner gate over the version artifact.
 * Refuses versions with failing tests. On verdict.blocked the version
 * goes to 'rejected' (with a 'rejected' event).
 *
 * H3 FAIL-CLOSED: the learning path has no shallow-scan fallback (unlike
 * skill-hub/plugin-market), so a missing or disabled scanner skill
 * ('no_scanner'/'scanner_disabled') BLOCKS the version by default
 * (state='rejected') instead of waving it through as 'scanned'. Set
 * LEARNING_REQUIRE_SCANNER=false to permit the old degraded behavior;
 * the approve route then requires explicit admin acknowledgement.
 * Never throws outward.
 *
 * ctx: { db, stmts, executeSkill, logger, auditLog } — the scanner
 * gate's server ctx; routes pass their own.
 */
export async function scanArtifact(version, ctx) {
  const db = version && version.id ? DBS.get(version.id) : null;
  if (!db || !version) return { ok: false, error: 'version is required (compile it first)' };
  try {
    let report = null;
    try { report = JSON.parse(version.test_report || 'null'); } catch { report = null; }
    if (report && report.failed > 0) {
      return { ok: false, error: 'tests must pass before scanning (failed>0)' };
    }
    let verdict;
    try {
      verdict = await runScannerGate(
        ctx || {},
        version.artifact || '',
        `learning-version:${version.id}`,
        { id: version.user_id, username: version.user_id },
      );
    } catch (err) {
      verdict = { blocked: true, verdict: 'scanner_error', details: { error: err.message } };
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE learning_skill_versions
      SET scanner_verdict = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(verdict), now, version.id);

    if (verdict && verdict.blocked === true) {
      db.prepare(`UPDATE learning_skill_versions
        SET state = 'rejected', updated_at = ? WHERE id = ?`).run(now, version.id);
      recordVersionEvent(db, version.id, 'rejected', version.user_id, {
        reason: 'scanner gate blocked the artifact',
        verdict: verdict.verdict,
      });
      return { ok: false, blocked: true, verdict };
    }

    // H3: fail closed on a degraded scanner verdict. A missing/disabled
    // scanner must not produce 'scanned' learning versions — the verdict
    // is recorded on the row (visible in the version detail payload) and
    // the version is rejected with a clear reason.
    const degradedVerdict = verdict
      && (verdict.verdict === 'no_scanner' || verdict.verdict === 'scanner_disabled');
    if (degradedVerdict && learningRequiresScanner()) {
      db.prepare(`UPDATE learning_skill_versions
        SET state = 'rejected', updated_at = ? WHERE id = ?`).run(now, version.id);
      recordVersionEvent(db, version.id, 'rejected', version.user_id, {
        reason: 'scanner unavailable — the learning pipeline requires the scanner gate (set LEARNING_REQUIRE_SCANNER=false to permit degraded scans)',
        verdict: verdict.verdict,
      });
      return {
        ok: false,
        blocked: true,
        degraded: true,
        verdict,
        error: `scanner unavailable (verdict=${verdict.verdict}) — learning versions require the scanner gate`,
      };
    }

    db.prepare(`UPDATE learning_skill_versions
      SET state = 'scanned', updated_at = ? WHERE id = ?`).run(now, version.id);
    recordVersionEvent(db, version.id, 'scanned', version.user_id, {
      verdict: verdict.verdict,
      blocked: false,
    });
    return { ok: true, verdict };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Execution entry point (NOT wired to any live route — reserved for
 * future use). Enforces the Docker-only rule in code:
 *   - requires_docker versions: Docker must be available; the artifact's
 *     handler is routed through executeInDocker (real signature).
 *   - anything else: hard refusal (shadow mode — execution not wired).
 * Throws clean Errors; callers must treat any error as "do not run".
 */
export async function executeVersion(version, input, ctx) {
  if (!version) throw new Error('version is required');
  if (!version.requires_docker) {
    throw new Error('execution not wired — shadow mode: this version kind cannot execute');
  }
  if (!isDockerAvailable()) {
    throw new Error('Docker required but unavailable');
  }
  let artifact;
  try {
    artifact = JSON.parse(version.artifact || '{}');
  } catch {
    throw new Error('version artifact is not parseable');
  }
  if (!artifact.handler || typeof artifact.handler !== 'string') {
    throw new Error('version has no executable handler');
  }
  return executeInDocker({ code: artifact.handler, input: input ?? {} });
}
