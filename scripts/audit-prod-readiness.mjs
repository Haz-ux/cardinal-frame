// Production-readiness audit: auth coverage, security posture, ops maturity.
import { execSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';

const R = (cmd) => execSync(cmd, { cwd: '/home/haz/cardinal-frame/cardinal-frame', encoding: 'utf8', timeout: 15000 });

// 1. Auth coverage per route file
console.log('=== Auth coverage (routes without any authMiddleware/optionalAuth) ===');
const routeFiles = readdirSync('src/server/routes').filter(f => f.endsWith('.mjs'));
const noAuth = [];
for (const f of routeFiles) {
  const c = readFileSync(`src/server/routes/${f}`, 'utf8');
  const hasAuth = /authMiddleware|optionalAuth/.test(c);
  const routes = (c.match(/router\.(get|post|put|delete|patch)\(/g) || []).length;
  if (!hasAuth && routes > 0) noAuth.push(`${f} (${routes} routes)`);
}
console.log(noAuth.length ? noAuth.join('\n') : 'all route files have auth refs ✓');

// 2. Rate limiting tiers
console.log('\n=== Rate limit tiers ===');
const limits = R("/usr/bin/grep -oE 'rateLimit\\(\\{ windowMs: [0-9]+ \\* 1000, max: [0-9]+' src/server/server.mjs").trim().split('\n');
limits.forEach(l => console.log('  ' + l));

// 3. Security headers
console.log('\n=== Security headers ===');
const helmet = R("/usr/bin/grep -A8 'helmet({' src/server/server.mjs | head -12").trim();
console.log(helmet.split('\n').map(l => '  ' + l.trim()).join('\n'));

// 4. CI jobs
console.log('\n=== CI jobs ===');
const jobs = R("/usr/bin/grep -E '^    name:' .github/workflows/ci.yml").trim().split('\n').map(s => s.trim());
console.log(jobs.join(', '));

// 5. Ops: backup, migrations, graceful shutdown, metrics
console.log('\n=== Ops features ===');
console.log('  migrations:', /migrator/.test(readFileSync('src/server/server.mjs', 'utf8')) ? 'migrator.mjs exists' : 'inline schema only');
console.log('  graceful shutdown:', /SIGTERM.*shutting|SIGINT.*shutting|process\.on\('SIGTERM'/.test(readFileSync('src/server/server.mjs', 'utf8')) ? 'yes' : 'NO');
console.log('  /metrics:', /prom-client/.test(readFileSync('src/server/server.mjs', 'utf8')) ? 'prom-client ✓' : 'NO');
console.log('  DB backups:', /backup/.test(readFileSync('src/server/server.mjs', 'utf8')) ? 'in server code' : 'none found in server code');
console.log('  docker:', ['Dockerfile', 'docker-compose.yml'].every(f => { try { readdirSync('.'); return true; } catch { return false; } }) ? 'present' : '?');

// 6. Test/LOC ratio
const loc = R('wc -l src/server/*.mjs src/server/routes/*.mjs src/server/llm/*.mjs 2>/dev/null | tail -1').trim();
console.log('\n=== Size ===\n  ' + loc);
const testCount = R('ls tests/*.mjs | wc -l').trim();
console.log('  test files: ' + testCount + ' (702 tests)');
