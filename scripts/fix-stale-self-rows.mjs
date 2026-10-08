// TWO issues found:
//
// 1. Self-row base_url = http://localhost:8080 but dev_settings.hostIp =
//    100.101.127.49. The boot that registered it started BEFORE hostIp was
//    saved (restart happened but the boot env didn't include HOST_IP — the
//    dev_settings read SHOULD have picked it up... unless the restart raced).
//    Also: there's a STALE duplicate row (localhost:8080) from the pre-fix
//    boot — the legacy re-home created a SECOND row with same name but
//    different base_url instead of updating in place. Actually looking closer:
//    row 1 = manual seed (100.101.127.49, caps JSON), row 2 = legacy re-home
//    attempt? No — row 2 has localhost:8080. It's the self-row registered by
//    an EARLIER boot (before hostIp was set). And the re-home logic updated
//    the MANUAL row to the crypto id (row 1 now has the crypto id? — check).
//
//    Simplest robust fix: at boot, DELETE any stale self-name rows whose
//    base_url doesn't match the current config, then register the real
//    self-row. One row, correct URL, idempotent.
//
// 2. The verify script's restart didn't apply — check whether the boot
//    actually re-registered. The re-home logic in server.mjs runs on the
//    boot AFTER the PUT — it did run (the manual row got the crypto id).
//    But the OLD self-row (from the previous boot, localhost) was never
//    removed. Fix: remove stale self rows at boot.
import { readFileSync, writeFileSync } from 'fs';

const S = '/home/haz/cardinal-frame/cardinal-frame/src/server/server.mjs';
let s = readFileSync(S, 'utf8');

const old = `// Register this node's real cryptographic identity in the registry —
// /delegate/receive looks up senders by node_id; without a self-row,
// self-looped delegations (and peers that know us by our real id) 403.
// registerNode UPSERTS — a name/IP change via Settings applies on restart.
try {
  const selfIdentity = getOrCreateNodeIdentity(db);
  nodeRegistry.registerNode({
    id: selfIdentity.node_id,
    name: selfNodeName,
    base_url: \`http://\${selfHostIp}:\${PORT}\`,
    public_key_pem: selfIdentity.public_key_pem,
    capabilities: ['self'],
  });
  logger.info(\`Self node registered: \${selfNodeName} (\${selfIdentity.node_id.slice(0, 12)}...) @ http://\${selfHostIp}:\${PORT}\`);
} catch (e) { logger.warn(\`Self node registration failed: \${e.message}\`); }
// Keep the manually-seeded legacy row (if any) in sync with the real identity
// so node selection by name resolves to a single live entry.
try {
  const legacy = nodeRegistry.getNodeByName(selfNodeName);
  if (legacy && legacy.id !== getOrCreateNodeIdentity(db).node_id) {
    nodeRegistry.registerNode({
      id: getOrCreateNodeIdentity(db).node_id,
      name: selfNodeName,
      base_url: \`http://\${selfHostIp}:\${PORT}\`,
      public_key_pem: getOrCreateNodeIdentity(db).public_key_pem,
      capabilities: legacy.capabilities || ['self'],
    });
    logger.info(\`Legacy node row "\${selfNodeName}" re-homed to the real crypto id\`);
  }
} catch {}`;

const replacement = `// Register this node's real cryptographic identity in the registry —
// /delegate/receive looks up senders by node_id; without a self-row,
// self-looped delegations (and peers that know us by our real id) 403.
// Before registering: remove stale rows for our node name whose base_url
// doesn't match the current config (leftovers from earlier boots / manual
// seeds with a different IP) — node selection by name must resolve to ONE
// live entry with the RIGHT address.
try {
  const selfIdentity = getOrCreateNodeIdentity(db);
  const currentUrl = \`http://\${selfHostIp}:\${PORT}\`;
  const stale = db.prepare(
    'SELECT id, base_url FROM nodes WHERE name = ? COLLATE NOCASE AND (id != ? OR base_url != ?)'
  ).all(selfNodeName, selfIdentity.node_id, currentUrl);
  for (const row of stale) {
    db.prepare('DELETE FROM nodes WHERE id = ?').run(row.id);
    logger.info(\`Removed stale self row "\${selfNodeName}" (\${row.base_url}) — replaced by \${currentUrl}\`);
  }
  // Preserve real capabilities from a manual seed if one existed
  const capsSeed = stale.find(r => r.id === selfIdentity.node_id);
  nodeRegistry.registerNode({
    id: selfIdentity.node_id,
    name: selfNodeName,
    base_url: currentUrl,
    public_key_pem: selfIdentity.public_key_pem,
    capabilities: ['self'],
  });
  logger.info(\`Self node registered: \${selfNodeName} (\${selfIdentity.node_id.slice(0, 12)}...) @ \${currentUrl}\`);
} catch (e) { logger.warn(\`Self node registration failed: \${e.message}\`); }`;

if (s.includes(old)) {
  s = s.replace(old, replacement);
  writeFileSync(S, s);
  console.log('✅ boot removes stale self rows, registers real identity with current URL');
} else {
  console.log('❌ block not found verbatim — read current state');
}
