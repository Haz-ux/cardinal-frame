// List memory-relevant facts for the update (memory store text not accessible
// directly — dump what the current prod-hardening entry likely says by
// searching the conversation facts in the DB is not possible; instead print
// the summary I need to save and let the next turn handle it).
console.log('HA work complete. Memory entry to save:');
console.log(`CF prod-hardening: backups via backup-db.mjs (VACUUM INTO, keeps 7) + cron 50bd984e606d every 6h. HSTS preload dropped. Logs: rotating file transport + 4 heartbeat rules firing into activity_log. Multi-node HA fixed: self-row at boot (crypto id), COLLATE NOCASE name lookup, no self-loop dispatch, offline node → local exec, awaiting_node → pending+local. Fleet: IKARIS/ARIES offline (hosts down), MINERVA online. Server boots with HOST_IP=100.101.127.49 NODE_NAME=MINERVA.`);
