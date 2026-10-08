// TWO root causes confirmed:
//
// 1. /delegate/receive looks up source node by CRYPTOGRAPHIC id
//    (registry.getNode(source_node_id)) — but the registry rows use
//    'node-minerva' style IDs. The real node_id (030a243e...) is NOT in the
//    registry → 403 'Unknown source node'. Even between two real CF nodes,
//    each registers the other via POST /api/nodes with the peer's real
//    crypto id — but MINERVA's own row was seeded manually with a cosmetic
//    id, so self-loop and any peer that knows us by our real id both fail.
//    Fix: register our own real identity in the registry at boot (self-row),
//    AND accept lookup by either real id or name (already does getNode ||
//    getNodeByName? — no, receive uses getNode only). Fix receive to fall
//    back to getNodeByName(payload hints) — better: register self at boot.
//
// 2. The delegation flow: child task executed LOCALLY as fallback (status=done
//    result=ha-final-ok) but the delegation row stays 'pending' because the
//    remote receipt never arrives (receive rejected it). ALSO the local
//    fallback path (dispatchToRemoteNode failed → executeTask locally) does
//    NOT mark the delegation completed — waitForTask/syncDelegationStatus
//    only runs for local delegations with node='local', but the row says
//    'MINERVA'. Fix: when remote dispatch fails and we fall back to local,
//    set node='local' on the delegation row so completion sync works.
import { readFileSync, writeFileSync } from 'fs';

const P = '/home/haz/cardinal-frame/cardinal-frame/src/server/routes/delegation.mjs';
let src = readFileSync(P, 'utf8');

// Fix 2: fallback path should flip node to 'local'
const old = `        if (!result.ok) {
          logger.warn(\`Remote dispatch to \${targetNode.name} failed: \${result.error} — falling back to local\`);
          delStmts.updateStatus.run('pending', delegationId);
          executeTask(childTaskId, command);
        } else {`;
const replacement = `        if (!result.ok) {
          logger.warn(\`Remote dispatch to \${targetNode.name} failed: \${result.error} — falling back to local\`);
          // Flip node to 'local' so completion sync (syncDelegationStatus)
          // tracks the local child task — otherwise the row stays 'pending'
          // forever waiting for a remote receipt that will never come.
          db.prepare("UPDATE delegations SET node = 'local', status = 'pending' WHERE id = ?").run(delegationId);
          executeTask(childTaskId, command);
        } else {`;

if (src.includes(old)) {
  src = src.replace(old, replacement);
  writeFileSync(P, src);
  console.log('✅ fallback path flips node to local (completion sync works)');
} else {
  console.log('❌ fallback block not found verbatim');
}

// Fix 1: register SELF in the registry at boot so self-loop + peer lookups
// by real id resolve. In server.mjs, after initNodeRegistry.
const S = '/home/haz/cardinal-frame/cardinal-frame/src/server/server.mjs';
let srv = readFileSync(S, 'utf8');

const oldBoot = `// ─── Node Registry (cross-node delegation liveness) ────────────────────
const nodeRegistry = initNodeRegistry(db);
nodeRegistry.setBroadcast(broadcast);
nodeRegistry.startHeartbeat(parseInt(process.env.NODE_HEARTBEAT_INTERVAL || '30') * 1000);
globalThis._nodeRegistry = nodeRegistry;
logger.info('Node registry initialized — heartbeat loop started');`;
const newBoot = `// ─── Node Registry (cross-node delegation liveness) ────────────────────
const nodeRegistry = initNodeRegistry(db);
nodeRegistry.setBroadcast(broadcast);
nodeRegistry.startHeartbeat(parseInt(process.env.NODE_HEARTBEAT_INTERVAL || '30') * 1000);
globalThis._nodeRegistry = nodeRegistry;
// Register this node's real cryptographic identity in the registry —
// /delegate/receive looks up senders by node_id; without a self-row,
// self-looped delegations (and peers that know us by our real id) 403.
try {
  const selfIdentity = getOrCreateNodeIdentity(db);
  const existingSelf = nodeRegistry.getNode(selfIdentity.node_id);
  if (!existingSelf) {
    nodeRegistry.registerNode({
      id: selfIdentity.node_id,
      name: process.env.NODE_NAME || 'MINERVA',
      base_url: \`http://\${process.env.HOST_IP || 'localhost'}:\${PORT}\`,
      public_key_pem: selfIdentity.public_key_pem,
      capabilities: ['self'],
    });
    logger.info(\`Self node registered: \${selfIdentity.node_id.slice(0, 12)}...\`);
  }
} catch (e) { logger.warn(\`Self node registration failed: \${e.message}\`); }
logger.info('Node registry initialized — heartbeat loop started');`;

if (srv.includes(oldBoot)) {
  srv = srv.replace(oldBoot, newBoot);
  writeFileSync(S, srv);
  console.log('✅ self node registered at boot (real crypto id)');
} else {
  console.log('❌ boot block not found verbatim');
}
