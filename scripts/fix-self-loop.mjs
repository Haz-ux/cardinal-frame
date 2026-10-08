// NOW CLEAR:
// - The dispatch DID reach the receive path (queue row created, attempts=0).
// - The receive path created a local task + ran executeAndReport... but the
//   task result went to the ORIGINAL local task (555e558c, done) — because
//   the receive handler reuses payload.child_task_id, which points at the
//   task ALREADY created by the dispatch side. So executeAndReport ran
//   executeTask on the ALREADY-completed task (double-execution) — or the
//   queueClaim never ran because executeAndReport crashed.
// - The delegation row stays 'pending': the report loop's queueOutboundReport
//   targets the coordinator = first non-self node = node-minerva (self-loop
//   again) — report goes out but /report on self... let me check if /report
//   exists and updates the delegation.
//
// SIMPLEST CORRECT FIX for a single-node reality: the self-loop dispatch is
// pathological. The registry pick + explicit node selection should NEVER
// target our own node (it's us — local execution IS the right path).
// Fix: exclude self (by crypto id) in getReachableNode + explicit selection.
// Then: node=minerva on the minerva host → local execution (correct), and
// the delegation completes via syncDelegationStatus (node='local').
import { readFileSync, writeFileSync } from 'fs';

const P = '/home/haz/cardinal-frame/cardinal-frame/src/server/node-registry.mjs';
let src = readFileSync(P, 'utf8');

// getReachableNode: exclude self by crypto id
const old = `  function getReachableNode(capability) {
    const onlineNodes = stmts.getOnlineWithCapability.all();

    if (!capability) {
      // No capability filter — return any online node
      return parseNode(onlineNodes[0] || null);
    }`;
const replacement = `  function getReachableNode(capability, selfNodeId = null) {
    // Exclude our own node — delegating to self is a loop; local execution
    // is the correct path and happens without the registry.
    const onlineNodes = stmts.getOnlineWithCapability.all()
      .filter(n => !selfNodeId || n.id !== selfNodeId);

    if (!capability) {
      // No capability filter — return any online node
      return parseNode(onlineNodes[0] || null);
    }`;

if (src.includes(old)) {
  src = src.replace(old, replacement);
  writeFileSync(P, src);
  console.log('✅ getReachableNode excludes self');
} else {
  console.log('❌ getReachableNode block not found');
}

// delegation.mjs: pass our identity to getReachableNode + exclude self in
// explicit node selection
const D = '/home/haz/cardinal-frame/cardinal-frame/src/server/routes/delegation.mjs';
let dsrc = readFileSync(D, 'utf8');

const oldSel = `    const registry = getRegistry();
    if (registry && !requestedNode) {
      // Use the registry to find a reachable node with the required capability
      targetNode = registry.getReachableNode(capability);
      if (targetNode) {
        dispatchMode = 'remote';
      } else {
        // No reachable node — queue locally as awaiting_node
        dispatchMode = 'awaiting_node';
      }
    } else if (registry && requestedNode) {
      // Explicit node requested by name
      targetNode = registry.getNodeByName(requestedNode);
      if (targetNode && targetNode.status === 'online') {
        dispatchMode = 'remote';
      } else {
        dispatchMode = 'awaiting_node';
      }
    }`;
const newSel = `    const registry = getRegistry();
    const selfNodeId = getIdentity()?.node_id || null;
    if (registry && !requestedNode) {
      // Use the registry to find a reachable node with the required capability
      // (excludes our own node — delegating to self is a loop)
      targetNode = registry.getReachableNode(capability, selfNodeId);
      if (targetNode) {
        dispatchMode = 'remote';
      } else {
        // No reachable node — queue locally as awaiting_node
        dispatchMode = 'awaiting_node';
      }
    } else if (registry && requestedNode) {
      // Explicit node requested by name (case-insensitive). Requesting our
      // own node = local execution — skip the registry entirely.
      targetNode = registry.getNodeByName(requestedNode);
      const isSelf = targetNode && (targetNode.id === selfNodeId
        || (targetNode.base_url && targetNode.base_url === \`http://100.101.127.49:\${process.env.PORT || 8080}\`));
      if (targetNode && !isSelf && targetNode.status === 'online') {
        dispatchMode = 'remote';
      } else if (targetNode && isSelf) {
        dispatchMode = 'self'; // local execution, no loop through receive
      } else {
        dispatchMode = 'awaiting_node';
      }
    }`;

if (dsrc.includes(oldSel)) {
  dsrc = dsrc.replace(oldSel, newSel);
  writeFileSync(D, dsrc);
  console.log('✅ explicit node selection: self → local, no loop');
} else {
  console.log('❌ selection block not found verbatim');
}
