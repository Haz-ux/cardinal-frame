/**
 * Cardinal Frame — Learning — Redaction Utilities
 *
 * Phase 1 (durable learning events): strip PII and secrets from payloads
 * BEFORE they are persisted to learning_events. Defense-in-depth alongside
 * defense/ingress.mjs — the event writer calls this on every payload, so a
 * missed ingress filter can never land raw secrets in the evidence stream.
 *
 * Covered: emails, phone numbers (string and numeric), SSNs (dashed and
 * dashless), IPv4 addresses (partially masked), credit-card-ish numbers
 * (Luhn checked), API keys/tokens (Telegram, Slack, AWS AKIA/ASIA, GitHub
 * ghp_/gho_/ghu_/ghs_/ghr_/github_pat_, JWT, whsec_, npm_, OpenAI, Google,
 * HuggingFace), DB connection-string passwords, passwords/secrets matched
 * by key name (compound/camelCase, e.g. db_password, aws_secret_access_key,
 * dbPassword) or `key = value` assignment, bearer tokens, and PEM/PGP
 * private keys.
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
  ip: '[redacted-ip]',
};

// Key-name stems whose VALUES are always secrets, regardless of content.
// Matched per underscore/dash/camelCase segment — NOT anchored equality —
// so compound names like db_password, aws_secret_access_key, smtp_password,
// secret_key, dbPassword all match, while benign lookalikes that merely
// contain a stem ("monkey", "keyboard", "secretary") do not.
const SECRET_STEMS = new Set([
  'secret', 'secrets', 'password', 'passwords', 'passwd', 'pass', 'pwd',
  'token', 'tokens', 'bearer', 'pat',
  'apikey', 'api_key', 'api_secret', 'api_token',
  'auth', 'authorization', 'credential', 'credentials',
  'private_key', 'privatekey', 'client_secret',
  'cookie', 'cookies', 'set_cookie', 'session', 'session_id', 'sessionid',
  'key',
]);

// Key-name stems that hint a numeric value is a phone number.
const PHONE_STEMS = new Set(['phone', 'mobile', 'tel', 'telephone', 'fax']);

/** Normalize a key name: split camelCase/ACRONYMCase, dashes → underscores, lowercase. */
function normalizeKeyName(k) {
  return String(k)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

/** True when any underscore-delimited segment of the key name is a secret stem. */
function isSecretKeyName(k) {
  const norm = normalizeKeyName(k);
  if (SECRET_STEMS.has(norm)) return true;
  return norm.split('_').some((seg) => SECRET_STEMS.has(seg));
}

/** True when a key name suggests its value is a phone number. */
function isPhoneKeyName(k) {
  return normalizeKeyName(k).split('_').some((seg) => PHONE_STEMS.has(seg));
}

/** True for integer numbers shaped like a NANP phone number (10 digits, or 11 starting with 1). */
function isPhoneLikeNumber(n) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return false;
  const d = String(n);
  return d.length === 10 || (d.length === 11 && d[0] === '1');
}

const TEXT_RULES = [
  // PEM/PGP private keys first (multiline). PGP armor ends "...KEY BLOCK-----",
  // so allow an optional trailing BLOCK.
  { kind: 'privateKey', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g, mask: MASK.privateKey },
  // Explicit key/token prefixes.
  {
    kind: 'apiKey',
    re: /\b(sk-[A-Za-z0-9_-]{8,}|sk_live_[A-Za-z0-9_-]{8,}|gh[phours]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abopehrs]-[A-Za-z0-9-]{8,}|A[KS]IA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{8,}|hf_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|npm_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\d{8,10}:[A-Za-z0-9_-]{35})\b/g,
    mask: MASK.apiKey,
  },
  // Bearer tokens.
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, mask: MASK.bearer },
  // DB connection strings: mask the password segment (postgres/mysql/mongodb).
  {
    kind: 'connString',
    re: /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:/?#\s]+:)[^@/?#\s]+@/gi,
    mask: `$1${MASK.password}@`,
  },
  // password/secret/api_key/token/session assignments: password=..., "api_key": "..."
  {
    kind: 'password',
    re: /((?:password|passwd|pwd|pass|secret|token|session|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*["']?\s*[:=]\s*)["']?[^,\s'";}]+["']?/gi,
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
  // IPv4 addresses: partial mask (keep /16); skip invalid octets and
  // dotted phone numbers (already handled by the phone rule above).
  {
    const before = text;
    text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m) => {
      const octets = m.split('.').map(Number);
      return octets.every((n) => n <= 255) ? `${octets[0]}.${octets[1]}.x.x` : m;
    });
    if (text !== before) found.add('ip');
  }
  // Bare 9-digit SSNs: mask only with SSN-plausible area numbers AND
  // "ssn"/"social security" context nearby (avoids masking order ids etc.).
  {
    const before = text;
    text = text.replace(/\b\d{9}\b/g, (m, offset, str) => {
      const area = Number(m.slice(0, 3));
      if (area === 0 || area === 666 || area > 899) return m;
      if (m.slice(3, 5) === '00' || m.slice(5) === '0000') return m;
      const ctx = str.slice(Math.max(0, offset - 48), offset + m.length + 48);
      if (/\bssn\b|\bsocial security\b/i.test(ctx)) return MASK.ssn;
      return m;
    });
    if (text !== before) found.add('ssn');
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
        if (isSecretKeyName(k)) {
          kinds.add('secretKey');
          out[k] = MASK.password;
        } else if (typeof val === 'number' && isPhoneKeyName(k) && isPhoneLikeNumber(val)) {
          // Phone numbers stored as JSON numbers (never pass through redactText).
          kinds.add('phone');
          out[k] = MASK.phone;
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
