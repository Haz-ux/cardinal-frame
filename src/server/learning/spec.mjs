/**
 * Cardinal Frame — Learning Phase 4: procedure spec builder + validator.
 *
 * A "spec" is the canonical plain-language representation of a promoted
 * learning candidate: what the problem is, the procedure, how to verify
 * it, and how to recover. Specs contain NO executable code — they are
 * the input the compiler turns into version artifacts.
 *
 * buildSpec(candidate, evidence) -> spec object
 * validateSpec(spec) -> { ok: true } | { ok: false, errors: [] }
 *
 * Invalid specs are quarantined by the caller (returned as invalid,
 * never written to the DB).
 */

const ARRAY_FIELDS = ['preconditions', 'verification', 'do_not_use_when', 'evidence_event_ids'];

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
  }
  return null;
}

function str(v, max = 2000) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * Build a plain-language procedure spec from a promoted candidate and its
 * evidence excerpts. Returns a spec-shaped object; call validateSpec()
 * before persisting anything.
 */
export function buildSpec(candidate, evidence = []) {
  const c = candidate || {};
  const title = str(c.title, 200) || 'Untitled procedure';
  // getCandidate() may already have parsed quality_json into an object.
  const quality = (() => {
    if (c.quality_json && typeof c.quality_json === 'object') return c.quality_json;
    try { return JSON.parse(c.quality_json || '{}'); } catch { return {}; }
  })();

  // Draft is stored as a JSON array of step strings. A prose blob here
  // (non-array) means the candidate cannot be compiled — the validator
  // will quarantine the result.
  const draftSteps = asArray(c.draft);
  const draftValid = draftSteps !== null;

  const evidenceRows = Array.isArray(evidence) ? evidence : [];
  const evidenceEventIds = evidenceRows
    .map(e => (e && (e.event_id || e.id) ? String(e.event_id || e.id) : ''))
    .filter(Boolean);

  const excerptNotes = evidenceRows
    .map(e => str(e.excerpt, 400))
    .filter(Boolean)
    .slice(0, 6);

  const procedure = draftValid
    ? draftSteps
        .map(s => str(s, 500))
        .filter(Boolean)
        .slice(0, 50)
        .map((action, i) => ({
          step: i + 1,
          action,
          why: excerptNotes[i] || `Learned from repeated successful outcomes (${evidenceEventIds.length} evidence event(s)).`,
        }))
    : [];

  const confidence = typeof quality.confidence === 'number'
    ? Math.min(1, Math.max(0, quality.confidence))
    : (typeof c.promotion_score === 'number' ? Math.min(1, Math.max(0, c.promotion_score)) : 0);

  return {
    kind: 'procedural',
    problem_signature: title,
    preconditions: Array.isArray(quality.preconditions)
      ? quality.preconditions.map(s => str(s, 300)).filter(Boolean)
      : [],
    procedure,
    verification: Array.isArray(quality.verification)
      ? quality.verification.map(s => str(s, 300)).filter(Boolean)
      : [`The procedure completes without errors on ${evidenceEventIds.length} observed case(s).`],
    failure_modes: Array.isArray(quality.failure_modes)
      ? quality.failure_modes
          .map(fm => ({
            symptom: str(fm && fm.symptom, 300),
            recovery: str(fm && fm.recovery, 500),
          }))
          .filter(fm => fm.symptom && fm.recovery)
      : [{ symptom: 'A procedure step fails', recovery: 'Stop, record the failing step and its output, and return to the last known-good state.' }],
    do_not_use_when: Array.isArray(quality.do_not_use_when)
      ? quality.do_not_use_when.map(s => str(s, 300)).filter(Boolean)
      : [],
    evidence_event_ids: evidenceEventIds,
    confidence,
  };
}

function checkNoEmptyStrings(value, path, errors) {
  if (typeof value === 'string') {
    if (!value.trim()) errors.push(`${path}: empty string not allowed`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkNoEmptyStrings(v, `${path}[${i}]`, errors));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      checkNoEmptyStrings(v, `${path}.${k}`, errors);
    }
  }
}

/**
 * Strict structural validation. Rejects free-form prose blobs, missing
 * procedure steps, and empty strings anywhere. Returns { ok } — never
 * throws on a malformed spec.
 */
export function validateSpec(spec) {
  const errors = [];
  try {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return { ok: false, errors: ['spec must be an object'] };
    }
    if (spec.kind !== 'procedural') {
      errors.push('kind must be "procedural"');
    }
    if (!str(spec.problem_signature)) {
      errors.push('problem_signature must be a non-empty string');
    }
    if (!Array.isArray(spec.procedure) || spec.procedure.length === 0) {
      errors.push('procedure must be a non-empty array');
    } else {
      spec.procedure.forEach((p, i) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
          errors.push(`procedure[${i}]: must be an object`);
          return;
        }
        if (!str(p.action)) errors.push(`procedure[${i}].action: must be a non-empty string`);
        if (!str(p.why)) errors.push(`procedure[${i}].why: must be a non-empty string`);
      });
    }
    for (const field of ARRAY_FIELDS) {
      if (!Array.isArray(spec[field])) {
        errors.push(`${field}: must be an array`);
      }
    }
    if (!Array.isArray(spec.failure_modes)) {
      errors.push('failure_modes: must be an array');
    } else {
      spec.failure_modes.forEach((fm, i) => {
        if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
          errors.push(`failure_modes[${i}]: must be an object`);
          return;
        }
        if (!str(fm.symptom)) errors.push(`failure_modes[${i}].symptom: must be a non-empty string`);
        if (!str(fm.recovery)) errors.push(`failure_modes[${i}].recovery: must be a non-empty string`);
      });
    }
    if (typeof spec.confidence !== 'number' || Number.isNaN(spec.confidence)) {
      errors.push('confidence: must be a number');
    }
    // No empty strings anywhere in the spec (whitespace-only counts).
    checkNoEmptyStrings(spec, 'spec', errors);
  } catch (err) {
    errors.push(`validation crashed: ${err.message}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
