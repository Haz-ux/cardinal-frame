/**
 * Cardinal Frame — Learning — Redaction Utilities
 *
 * Phase 1 (durable learning events): strip PII and secrets from payloads
 * BEFORE they are persisted to learning_events. Defense-in-depth alongside
 * defense/ingress.mjs — the event writer calls this on every payload, so a
 * missed ingress filter can never land raw secrets in the evidence stream.
 *
 * Covered: emails, phone numbers, SSNs, credit-card-ish numbers (Luhn
 * checked), API keys/tokens (common prefixes + generic key assignments),
 * passwords/secrets by key name or `key = value` assignment, bearer tokens,
 * and PEM private keys.
 *
 * Pure functions, no dependencies. Deterministic output.
 */

/** Luhn checksum — true when the digit string is plausibly a card number. */
export function luhnCheck(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

const MASK = {
  email: '[redacted-email]',
  phone: '[redacted-phone]',
  ssn: '[redacted-ssn]',
  card: '[redacted-card]',
  apiKey: '[redacted-api-key]',
  password: '[redacted-secret]',
  bearer: 'Bearer [redacted-token]',
  privateKey: '[redacted-private-key]',
};

// Key names whose VALUES are always secrets, regardless of content.
const SECRET_KEY_RE = /^(api[_-]?key|apikey|api[_-]?secret|secret|password|passwd|pwd|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization|cookie|set[_-]?cookie|session[_-]?id)$/i;

const TEXT_RULES = [
  // PEM private keys first (multiline).
  { kind: 'privateKey', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, mask: MASK.privateKey },
  // Explicit key/token prefixes.
  {
    kind: 'apiKey',
    re: /\b(sk-[A-Za-z0-9_-]{8,}|sk_live_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{8,}|hf_[A-Za-z0-9]{8,})\b/g,
    mask: MASK.apiKey,
  },
  // Bearer tokens.
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, mask: MASK.bearer },
  // password/secret/api_key assignments: password=..., "api_key": "..."
  {
    kind: 'password',
    re: /((?:password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*["']?\s*[:=]\s*)["']?[^,\s'";}]+["']?/gi,
    mask: `$1${MASK.password}`,
  },
  // SSN: 123-45-6789
  { kind: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, mask: MASK.ssn },
  // Email addresses.
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, mask: MASK.email },
  // Phone numbers: +1 (555) 123-4567, 555-123-4567, etc.
  {
    kind: 'phone',
    re: /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    mask: MASK.phone,
  },
];

/**
 * Redact PII/secrets in a string.
 * @returns {{ text: string, redactions: string[] }} kinds that were masked.
 */
export function redactText(input) {
  let text = String(input ?? '');
  const found = new Set();
  for (const rule of TEXT_RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) {
      found.add(rule.kind);
      rule.re.lastIndex = 0;
      text = text.replace(rule.re, rule.mask);
    }
  }
  // Credit-card-ish digit runs: mask only when Luhn-valid (cuts false positives).
  const cardRe = /\b(?:\d[ -]?){13,19}\b/g;
  text = text.replace(cardRe, (m) => {
    const digits = m.replace(/[ -]/g, '');
    if (/^\d{13,19}$/.test(digits) && luhnCheck(digits)) {
      found.add('card');
      return MASK.card;
    }
    return m;
  });
  return { text, redactions: [...found] };
}

/**
 * Deep-redact a JSON-able payload: secret key names are masked by name,
 * all strings are run through redactText.
 * @returns {{ payload: any, redacted: boolean, kinds: string[] }}
 */
export function redactPayload(value, _seen = new Set()) {
  const kinds = new Set();
  function walk(v) {
    if (typeof v === 'string') {
      const { text, redactions } = redactText(v);
      redactions.forEach((k) => kinds.add(k));
      return text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if (_seen.has(v)) return '[circular]';
      _seen.add(v);
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEY_RE.test(k)) {
          kinds.add('secretKey');
          out[k] = MASK.password;
        } else {
          out[k] = walk(val);
        }
      }
      return out;
    }
    return v;
  }
  const payload = walk(value);
  return { payload, redacted: kinds.size > 0, kinds: [...kinds] };
}

/**
 * Redact a payload and serialize it for the learning_events table.
 * @returns {{ json: string, redaction_status: 'clean' | 'redacted' }}
 */
export function redactEventPayload(payload) {
  const { payload: clean, redacted } = redactPayload(payload ?? {});
  let json;
  try {
    json = JSON.stringify(clean);
  } catch {
    json = JSON.stringify({ note: '[unserializable payload]' });
  }
  return { json, redaction_status: redacted ? 'redacted' : 'clean' };
}
