// Test 2 STILL fails: node=ikaris → status=awaiting_node, and it took 20.1s
// (the inline wait polled the full timeout). awaiting_node means the
// selection branch went to `else` — i.e. targetNode was null or isSelf was
// false AND status !== 'online'. IKARIS is offline → status !== 'online' →
// falls to `else` → awaiting_node. Correct per current code, but the DESIGN
// INTENT (docstring: "Falls back to local execution if the remote dispatch
// fails") says an offline node should still attempt dispatch (which fails
// fast) OR fall straight to local. Current behavior: awaiting_node →
// executeTask runs locally as fallback (line 457) BUT syncDelegationStatus
// requires status === 'pending' — awaiting_node rows never sync!
//
// TWO fixes:
// 1. Offline target node → dispatch locally (node='local'), not awaiting_node.
//    awaiting_node only makes sense when NO node was requested and none is
//    reachable (work parked until one comes online).
// 2. awaiting_node fallback executes locally → flip to pending after starting
//    local execution so sync works. Actually cleaner: awaiting_node rows that
//    execute locally should just be 'pending' with node='local'.
import { readFileSync, writeFileSync } from 'fs';

const P = '/home/haz/cardinal-frame/cardinal-frame/src/server/routes/delegation.mjs';
let src = readFileSync(P, 'utf8');

// Fix 1: explicit offline node → local execution (dispatch would fail anyway)
const old1 = `      if (targetNode && !isSelf && targetNode.status === 'online') {
        dispatchMode = 'remote';
      } else if (targetNode && isSelf) {
        // Requesting ourselves — nodeValue stays 'local' so completion sync works
        dispatchMode = 'local';
        targetNode = null;
      } else {
        dispatchMode = 'awaiting_node';
      }`;
const new1 = `      if (targetNode && !isSelf && targetNode.status === 'online') {
        dispatchMode = 'remote';
      } else if (targetNode && isSelf) {
        // Requesting ourselves — nodeValue stays 'local' so completion sync works
        dispatchMode = 'local';
        targetNode = null;
      } else if (targetNode && !isSelf && targetNode.status !== 'online') {
        // Explicit node requested but it's offline — execute locally now
        // (the dispatch would fail anyway; local completion syncs properly).
        // awaiting_node is only for "no node requested, none reachable".
        dispatchMode = 'local';
        targetNode = null;
      } else {
        dispatchMode = 'awaiting_node';
      }`;

if (src.includes(old1)) {
  src = src.replace(old1, new1);
  writeFileSync(P, src);
  console.log('✅ offline explicit node → local execution');
} else {
  console.log('❌ selection block changed — read current state');
}

// Fix 2: awaiting_node fallback — flip to pending+local so sync works
const old2 = `    } else if (dispatchMode === 'awaiting_node') {
      // No reachable node — queue locally but mark as awaiting_node
      delStmts.updateStatus.run('awaiting_node', delegationId);
      // Still execute locally as fallback
      executeTask(childTaskId, command);
      broadcast('delegation:queued', { id: delegationId, childTaskId, capability, reason: 'No reachable remote node' });
      logger.info(\`Delegation queued (no reachable node): \${delegationId} → executing locally as fallback\`);
    } else {`;
const new2 = `    } else if (dispatchMode === 'awaiting_node') {
      // No reachable node — park the delegation as awaiting_node, but the
      // local fallback DOES execute now. Flip to pending+local so
      // syncDelegationStatus tracks the local task and wait-mode returns.
      db.prepare("UPDATE delegations SET node = 'local', status = 'pending' WHERE id = ?").run(delegationId);
      executeTask(childTaskId, command);
      broadcast('delegation:queued', { id: delegationId, childTaskId, capability, reason: 'No reachable remote node — executing locally' });
      logger.info(\`Delegation queued (no reachable node): \${delegationId} → executing locally as fallback\`);
    } else {`;

if (src.includes(old2)) {
  src = src.replace(old2, new2);
  writeFileSync(P, src);
  console.log('✅ awaiting_node fallback flips to pending+local');
} else {
  console.log('❌ awaiting_node block changed — read current state');
}
