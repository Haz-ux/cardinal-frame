/**
 * Cardinal Frame — Pre-ingest Skill Scanner Gate
 *
 * Runs the `skill-scanner` skill (a seeded hybrid-in-script skill) against
 * skill/plugin source code before it is persisted to disk or the database.
 * If the scanner returns `verdict.blocked === true`, the caller MUST refuse
 * the install.
 *
 * This is framework wiring around a *skill* — the scan logic itself lives
 * in the `skill-scanner` skill (see seed-skills.mjs) so that Aimi, chains,
 * and the dashboard can all invoke it the same way as any other skill.
 *
 * Graceful degradation: if the `skill-scanner` skill is not installed or is
 * disabled, the gate returns `{ blocked: false, verdict: 'no_scanner' }` and
 * does NOT block installs — the framework falls back to the existing
 * shallow static scans in skill-hub / plugin-market.
 *
 * However, if the scanner skill is installed+enabled but ERRORS while running,
 * the gate FAILS CLOSED (`blocked: true`) — a crashing scanner must not
 * silently downgrade the install pipeline to allow-all.
 */

const SCANNER_SKILL_NAME = 'skill-scanner';

/**
 * Run the skill-scanner skill against a source blob.
 *
 * @param {object} ctx        - server ctx (db, stmts, executeSkill, logger, auditLog)
 * @param {string} source     - skill/plugin source code to scan
 * @param {string} [name]      - skill/plugin name (for logging/audit)
 * @param {object} [reqUser]  - { username, id } for audit attribution
 * @returns {Promise<{ blocked: boolean, verdict: string, details?: object, error?: string }>}
 */
export async function runScannerGate(ctx, source, name = 'unknown', reqUser = null) {
  const { db, stmts, executeSkill, logger, auditLog } = ctx;

  // No source to scan — nothing to do.
  if (!source || typeof source !== 'string') {
    return { blocked: false, verdict: 'no_source' };
  }

  // Look up the scanner skill. If it's not installed or is disabled, we do
  // NOT hard-block: the framework falls back to existing shallow scans.
  const scanner = db.prepare('SELECT id, name, enabled FROM skills WHERE name = ?').get(SCANNER_SKILL_NAME);
  if (!scanner) {
    return { blocked: false, verdict: 'no_scanner', note: 'skill-scanner not installed — run /skills/seed' };
  }
  if (!scanner.enabled) {
    return { blocked: false, verdict: 'scanner_disabled' };
  }

  try {
    const skill = stmts.skills.getByName.get(SCANNER_SKILL_NAME);
    const result = await executeSkill(skill, { source, name }, `scanner-gate:${Date.now()}`);

    // Script skills return { ok, output } where output is the handler return value.
    const out = result?.ok ? result.output : result?.output || result;

    const details = {
      verdict: out?.verdict,
      blocked: out?.blocked === true,
      risk_score: out?.risk_score,
      critical_hits: out?.critical_hits,
      suspicious_hits: out?.suspicious_hits,
      reasons: out?.reasons || [],
      checks: out?.checks || [],
      scanned_at: out?.scanned_at,
    };

    if (details.blocked) {
      logger.warn(`[scanner-gate] BLOCKED "${name}" — verdict=${details.verdict} risk=${details.risk_score} reasons=${(details.reasons || []).join('; ')}`);
      if (typeof auditLog === 'function') {
        auditLog(stmts, reqUser?.username || 'system', 'scanner:gate:blocked', name, {
          verdict: details.verdict, risk_score: details.risk_score, reasons: details.reasons,
        });
      }
      return { blocked: true, verdict: 'blocked', details };
    }

    return { blocked: false, verdict: details.verdict || 'allowed', details };
  } catch (err) {
    // Scanner skill errored — FAIL CLOSED. A crashing scanner must not
    // silently downgrade the install pipeline; refuse until an admin fixes it.
    logger.error(`[scanner-gate] scanner skill error for "${name}" — install refused: ${err.message}`);
    if (typeof auditLog === 'function') {
      auditLog(stmts, reqUser?.username || 'system', 'scanner:gate:error', name, { error: err.message });
    }
    return { blocked: true, verdict: 'scanner_error', details: { verdict: 'scanner_error', error: err.message } };
  }
}
