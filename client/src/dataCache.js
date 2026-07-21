/**
 * Global SWR-style data cache for Cardinal Frame.
 * Prevents re-fetching on tab switches — returns cached data instantly,
 * then revalidates in background if stale.
 */

const CACHE_TTL = 15_000; // 15s before revalidation
const cache = new Map();   // key → { data, ts, promise }

export function cachedFetch(url, ttl = CACHE_TTL) {
  const entry = cache.get(url);
  const now = Date.now();

  // Fresh cache — return immediately
  if (entry && now - entry.ts < ttl) {
    return Promise.resolve(entry.data);
  }

  // Already fetching — piggyback on existing promise
  if (entry?.promise) {
    return entry.promise;
  }

  // Stale cache — return stale data immediately, revalidate in background
  const doFetch = apiCall(url).then(data => {
    cache.set(url, { data, ts: Date.now(), promise: null });
    return data;
  }).catch(err => {
    // Keep stale data on failure, clear promise
    if (entry) entry.promise = null;
    throw err;
  });

  if (entry) {
    // Return stale data, update in background
    entry.promise = doFetch;
    return Promise.resolve(entry.data);
  }

  // No cache — wait for fetch
  const promiseEntry = { data: null, ts: 0, promise: doFetch };
  cache.set(url, promiseEntry);
  return doFetch;
}

async function apiCall(path) {
  const token = localStorage.getItem('cf_token');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { headers, cache: 'no-store' });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: `Request failed: ${res.status}` }));
    throw new Error(e.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// Clear specific cache entry or entire cache
export function invalidateCache(url) {
  if (url) cache.delete(url);
  else cache.clear();
}

// Pre-warm cache (call on app load for critical data)
export function prewarm(urls) {
  for (const u of urls) cachedFetch(u);
}
