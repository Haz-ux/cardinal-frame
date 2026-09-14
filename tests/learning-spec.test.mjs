import { describe, it, expect } from 'vitest';
import { buildSpec, validateSpec } from '../src/server/learning/spec.mjs';

function candidate(overrides = {}) {
  return {
    id: 'cand-1',
    title: 'Restart the failing service after a config change',
    kind: 'procedure',
    draft: JSON.stringify(['Identify the failing service', 'Apply the config change', 'Restart the service']),
    risk_tier: 'low',
    requested_caps: '[]',
    quality_json: JSON.stringify({
      confidence: 0.8,
      verification: ['service reports healthy', 'no errors in logs'],
      failure_modes: [{ symptom: 'service fails to start', recovery: 'revert config and restart' }],
    }),
    promotion_score: 0.9,
    ...overrides,
  };
}

describe('buildSpec', () => {
  it('builds a procedural spec from draft steps', () => {
    const spec = buildSpec(candidate(), [{ event_id: 'e1', excerpt: 'observed success' }]);
    expect(spec.kind).toBe('procedural');
    expect(spec.problem_signature).toBe('Restart the failing service after a config change');
    expect(spec.procedure).toHaveLength(3);
    expect(spec.procedure[0]).toMatchObject({ step: 1, action: 'Identify the failing service' });
    expect(spec.procedure[0].why).toBeTruthy();
    expect(spec.evidence_event_ids).toEqual(['e1']);
    expect(spec.confidence).toBeCloseTo(0.8);
    expect(spec.verification).toHaveLength(2);
    expect(spec.failure_modes).toHaveLength(1);
  });

  it('derives confidence from promotion_score when quality_json lacks it', () => {
    const c = candidate({ quality_json: '{}', promotion_score: 0.42 });
    const spec = buildSpec(c, []);
    expect(spec.confidence).toBeCloseTo(0.42);
  });

  it('accepts an already-parsed quality_json object', () => {
    const c = candidate({ quality_json: { confidence: 0.7, verification: ['v1'], failure_modes: [] } });
    const spec = buildSpec(c, []);
    expect(spec.confidence).toBeCloseTo(0.7);
    expect(spec.verification).toEqual(['v1']);
  });

  it('produces an empty procedure for a prose-blob draft (quarantined by validateSpec)', () => {
    const c = candidate({ draft: JSON.stringify('just do the thing carefully and hope') });
    const spec = buildSpec(c, []);
    expect(spec.procedure).toEqual([]);
    expect(validateSpec(spec).ok).toBe(false);
  });

  it('handles missing/empty candidates without throwing', () => {
    expect(() => buildSpec(null, null)).not.toThrow();
    const v = validateSpec(buildSpec({}, []));
    expect(v.ok).toBe(false);
  });
});

describe('validateSpec', () => {
  it('accepts a well-formed spec', () => {
    const v = validateSpec(buildSpec(candidate(), []));
    expect(v).toEqual({ ok: true });
  });

  it('rejects a non-object spec (free-form prose blob)', () => {
    expect(validateSpec('do the thing carefully').ok).toBe(false);
    expect(validateSpec(null).ok).toBe(false);
    expect(validateSpec(['a', 'b']).ok).toBe(false);
  });

  it('rejects an empty procedure array', () => {
    const spec = buildSpec(candidate(), []);
    spec.procedure = [];
    const v = validateSpec(spec);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/procedure/);
  });

  it('rejects procedure steps missing action or why', () => {
    const spec = buildSpec(candidate(), []);
    spec.procedure[0] = { step: 1, action: '', why: 'because' };
    const v = validateSpec(spec);
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => e.includes('procedure[0].action'))).toBe(true);
  });

  it('rejects non-array list fields', () => {
    const spec = buildSpec(candidate(), []);
    spec.verification = 'looks good';
    expect(validateSpec(spec).ok).toBe(false);
  });

  it('rejects empty strings anywhere', () => {
    const spec = buildSpec(candidate(), []);
    spec.do_not_use_when = ['   '];
    const v = validateSpec(spec);
    expect(v.ok).toBe(false);
  });

  it('rejects malformed failure modes', () => {
    const spec = buildSpec(candidate(), []);
    spec.failure_modes = [{ symptom: 'x' }];
    const v = validateSpec(spec);
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => e.includes('failure_modes[0].recovery'))).toBe(true);
  });

  it('requires kind=procedural and non-empty problem_signature', () => {
    const spec = buildSpec(candidate(), []);
    spec.kind = 'whatever';
    spec.problem_signature = '';
    const v = validateSpec(spec);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThanOrEqual(2);
  });
});
