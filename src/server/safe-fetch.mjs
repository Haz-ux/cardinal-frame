/**
 * Cardinal Frame — SSRF-safe fetch utility
 *
 * Shared module: validates URLs before fetching and re-validates
 * at every redirect hop. Used by evolution routes (distill URL source,
 * hub scan, hub install) and skill-hub routes (hub scan, skill fetch).
 *
 * Moved here from evolution.mjs to avoid duplicating the validation
 * logic across route files. The DNS resolution check prevents
 * hostnames that resolve to private/internal IPs from bypassing the
 * hostname blocklist.
 */

import { isIP } from 'net';
import dns from 'dns/promises';

// ─── SSRF protection constants ──────────────────────────────
const BLOCKED_HOSTNAMES = ['localhost', '169.254.169.254', '0.0.0.0', '[::]'];
const MAX_REDIRECTS = 3;

// ─── Private helpers (not exported) ─────────────────────────

function isPrivateIP(ip) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(ip) || ip === '::1' || ip === '::';
}

/**
 * Validate that a URL is safe to fetch server-side.
 * Checks scheme, hostname blocklist, and resolves DNS to catch
 * hostnames that point to private/internal IPs.
 */
async function validateUrlIsSafe(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { throw new Error('Invalid URL'); }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked scheme: ${parsed.protocol}`);
  }
  if (BLOCKED_HOSTNAMES.includes(parsed.hostname.toLowerCase())) {
    throw new Error('Blocked hostname');
  }
  // Resolve hostname — don't trust the string alone, DNS can bypass a hostname check
  const ip = isIP(parsed.hostname) ? parsed.hostname : (await dns.lookup(parsed.hostname)).address;
  if (isPrivateIP(ip)) {
    throw new Error('Blocked: target resolves to a private/internal address');
  }
  return parsed;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * SSRF-safe fetch: validates URL before fetching and re-validates
 * at every redirect hop.
 *
 * @param {string} url — the URL to fetch
 * @param {object} opts — fetch options (signal, etc.) — redirect is forced to 'manual'
 * @returns {Promise<Response>} — the final non-redirect Response
 */
export async function safeFetch(url, opts = {}) {
  let currentUrl = url;
  let redirectCount = 0;

  // Default 15s timeout — callers that pass their own signal keep it as-is
  if (!opts.signal) opts.signal = AbortSignal.timeout(15000);

  // Initial validation
  await validateUrlIsSafe(currentUrl);

  while (redirectCount <= MAX_REDIRECTS) {
    const resp = await fetch(currentUrl, { ...opts, redirect: 'manual' });

    // Check for redirect — re-validate before following
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get('location');
      if (!location) throw new Error('Redirect response missing Location header');
      const nextUrl = new URL(location, currentUrl).href;
      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) throw new Error('Too many redirects');
      await validateUrlIsSafe(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    return resp; // non-redirect — caller decides what to do with it
  }

  throw new Error('Too many redirects');
}
