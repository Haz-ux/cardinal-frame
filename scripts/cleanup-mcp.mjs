// MCP cleanup: the only registered server is "verify-mcp" (npx stdio, from a
// verify script) — disconnected, no URL. This is test debris, not a real
// integration. Delete it. Also confirm the mcp_servers table is empty after.
import Database from 'better-sqlite3';
const db = new Database('data/cardinal.db');
const before = db.prepare('SELECT id, name, status, command FROM mcp_servers').all();
console.log('before:', JSON.stringify(before));
const info = db.prepare('DELETE FROM mcp_servers').run();
console.log('deleted rows:', info.changes);
const after = db.prepare('SELECT COUNT(*) as n FROM mcp_servers').get();
console.log('after count:', after.n);
