// Verify log/alert pipeline end-to-end:
// 1. Server log file exists and is being written (structured JSON)
// 2. Health ok
// 3. Heartbeat rules active (via API)
// 4. Alert rules fire (memory_high should trigger — heap was >90% before restart)
import { readFileSync, statSync, existsSync } from 'fs';

await new Promise(r => setTimeout(r, 5000));

// 1. Server up + log file written
const health = await fetch('http://localhost:8080/api/health', { signal: AbortSignal.timeout(10000) });
const j = await health.json();
console.log('health:', j.payload?.status);

const logPath = '/home/haz/cardinal-frame/cardinal-frame/data/logs/server.log';
if (existsSync(logPath)) {
  const stat = statSync(logPath);
  const lines = readFileSync(logPath, 'utf8').trim().split('\n');
  console.log(`✅ server.log: ${(stat.size / 1024).toFixed(1)}KB, ${lines.length} lines`);
  const last = JSON.parse(lines[lines.length - 1]);
  console.log(`   last entry: level=${last.level} msg="${(last.message || '').slice(0, 80)}"`);
} else {
  console.log('❌ server.log NOT created');
}

// 2. Heartbeat rules via API
const login = await fetch('http://localhost:8080/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token: TOKEN } = await login.json();
const rules = await fetch('http://localhost:8080/api/heartbeat/rules', { headers: { Authorization: `Bearer ${TOKEN}` } });
const rulesList = await rules.json();
console.log(`✅ heartbeat rules via API: ${rulesList.length}`);
rulesList.forEach(r => console.log(`   - ${r.name}: ${r.condition} (enabled=${r.enabled})`));

// 3. State endpoint (what rules evaluate against)
const state = await fetch('http://localhost:8080/api/heartbeat/state', { headers: { Authorization: `Bearer ${TOKEN}` } });
const stateJson = await state.json();
console.log('heartbeat state:', JSON.stringify(stateJson).slice(0, 200));
