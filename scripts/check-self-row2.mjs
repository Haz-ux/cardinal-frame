// Server is UP (the earlier restart request came when the verify script's
// 6s wait raced the shutdown — server actually restarted). Self-row shows
// undefined because my check ran mid-restart or the DB read was stale.
// Re-check now: self-row name + base_url, and the dev_settings values.
import Database from 'better-sqlite3';

const db = new Database('data/cardinal.db', { readonly: true });

const dev = {
  nodeName: db.prepare("SELECT value FROM dev_settings WHERE key = 'nodeName'").get(),
  hostIp: db.prepare("SELECT value FROM dev_settings WHERE key = 'hostIp'").get(),
};
console.log('dev_settings:', JSON.stringify(dev));

const selfRows = db.prepare("SELECT id, name, base_url, status, capabilities FROM nodes").all();
console.log('\nnodes registry:');
selfRows.forEach(r => console.log(`  ${r.name} | ${r.base_url} | ${r.status} | caps=${r.capabilities}`));

// Wait — dev_settings.hostIp was saved as 100.101.127.49 but the verify
// script's restore only reset nodeName. Expected: nodeName=MINERVA,
// hostIp=100.101.127.49. Self-row should have that base_url.
const identity = db.prepare('SELECT node_id FROM node_identity').get();
const self = db.prepare('SELECT id, name, base_url FROM nodes WHERE id = ?').get(identity.node_id);
console.log(`\nself-row (by crypto id): name=${self?.name} base_url=${self?.base_url}`);
console.log(`expected base_url: http://${dev.hostIp?.value || 'localhost'}:8080`);
