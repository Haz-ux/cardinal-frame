// MCP bloat check: 1 server registered. List it, check its status, and count
// tools. Also check whether /api/mcp/servers response is bloated (it parses
// args JSON per row) and whether connections leak (mcp-client keeps Map).
import { readFileSync } from 'fs';

const BASE = 'http://localhost:8080/api';
const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token: TOKEN } = await login.json();
if (!TOKEN) { console.log('FATAL: no token'); process.exit(1); }

const list = await fetch(BASE + '/mcp/servers', { headers: { Authorization: `Bearer ${TOKEN}` } });
const servers = await list.json();
console.log(`MCP servers: ${servers.length}`);
for (const s of servers) {
  console.log(`  - ${s.name} | transport=${s.transport} | status=${s.status} | connected=${s.connected} | command=${s.command || 'n/a'} | url=${s.url || 'n/a'}`);
  if (s.connected) {
    const t = await fetch(`${BASE}/mcp/servers/${s.id}/tools`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const tj = await t.json();
    console.log(`    tools: ${tj.tools?.length || 0}`);
  }
}
