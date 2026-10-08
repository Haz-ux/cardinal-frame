// Post-restart verification: CSP headers, health, UI loads (index.html + JS bundle)
import { execSync } from 'child_process';

await new Promise(r => setTimeout(r, 4000));

const health = await fetch('http://localhost:8080/api/health', { signal: AbortSignal.timeout(10000) });
const j = await health.json();
console.log('health:', j.payload?.status);

// CSP headers on the root document
const page = await fetch('http://localhost:8080/', { signal: AbortSignal.timeout(10000) });
const csp = page.headers.get('content-security-policy');
console.log('CSP:', csp ? csp.slice(0, 300) : 'none');
console.log('HSTS:', page.headers.get('strict-transport-security'));
console.log('CORP:', page.headers.get('cross-origin-resource-policy'));

// JS bundle loads (module script — the Tailscale blank-screen test)
const bundleMatch = page.body ? null : null;
const html = await page.text();
const m = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
if (m) {
  const bundle = await fetch('http://localhost:8080' + m[1], { signal: AbortSignal.timeout(10000) });
  console.log('JS bundle:', bundle.status, `(${(await bundle.arrayBuffer()).byteLength} bytes)`);
} else {
  console.log('JS bundle: NOT FOUND in index.html');
}
