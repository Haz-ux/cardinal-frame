// Add node identity settings (NODE_NAME + HOST_IP) to Dev Settings so a new
// user can change system name and IP from the UI.
//
// Backend (settings.mjs):
//  - GET /settings/dev: expose nodeName + hostIp with env fallbacks
//  - PUT /settings/dev: accept nodeName + hostIp with validation; write to
//    dev_settings AND sync to process.env (like logLevel/embeddingModel)
//
// Server boot (server.mjs):
//  - dev_settings override env for NODE_NAME/HOST_IP (DB wins — it's the UI)
//  - self-row: re-register (name/base_url may have changed) — use
//    registerNode (upsert) instead of register-once, and update the
//    legacy manually-seeded row name/base_url if changed
//
// Frontend (Settings.jsx):
//  - Two editable rows: Node Name, Host IP — with restart hint (name/IP
//    apply on restart since the self-row is built at boot)
import { readFileSync, writeFileSync } from 'fs';

// ─── 1. Backend: settings.mjs ──────────────────────────────────────
const S = '/home/haz/cardinal-frame/cardinal-frame/src/server/routes/settings.mjs';
let s = readFileSync(S, 'utf8');

// GET /settings/dev — expose nodeName + hostIp
const oldGet = `      const result = {
        port: settings.port || String(process.env.PORT || '8080'),
        logLevel: settings.logLevel || process.env.LOG_LEVEL || 'info',
        debugMode: settings.debugMode === 'true',
        sandboxTimeout: settings.sandboxTimeout || '30',
        maxConcurrentAgents: settings.maxConcurrentAgents || '5',
        wsHeartbeatMs: settings.wsHeartbeatMs || '30000',
        embeddingModel: settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2',
        ...settings,
      };`;
const newGet = `      const result = {
        port: settings.port || String(process.env.PORT || '8080'),
        logLevel: settings.logLevel || process.env.LOG_LEVEL || 'info',
        debugMode: settings.debugMode === 'true',
        sandboxTimeout: settings.sandboxTimeout || '30',
        maxConcurrentAgents: settings.maxConcurrentAgents || '5',
        wsHeartbeatMs: settings.wsHeartbeatMs || '30000',
        embeddingModel: settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2',
        // Node identity — who this node is on the mesh. Env fallbacks keep
        // headless/first-boot deployments working without the UI.
        nodeName: settings.nodeName || process.env.NODE_NAME || 'MINERVA',
        hostIp: settings.hostIp || process.env.HOST_IP || 'localhost',
        ...settings,
      };`;

if (s.includes(oldGet)) {
  s = s.replace(oldGet, newGet);
  console.log('✅ GET /settings/dev exposes nodeName + hostIp');
} else {
  console.log('❌ GET block not found verbatim');
}

// PUT /settings/dev — accept nodeName + hostIp with validation
const oldPut = `      if (updates.maxConcurrentAgents !== undefined) {
        const n = parseInt(updates.maxConcurrentAgents, 10);
        if (isNaN(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Max concurrent agents must be 1-100' });
        updates.maxConcurrentAgents = String(n);
      }`;
const newPut = `      if (updates.maxConcurrentAgents !== undefined) {
        const n = parseInt(updates.maxConcurrentAgents, 10);
        if (isNaN(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Max concurrent agents must be 1-100' });
        updates.maxConcurrentAgents = String(n);
      }
      // Node identity validation. Name: 1-64 chars, no control chars — it is
      // a display label AND the delegation target name. IP: IPv4, hostname,
      // or 'localhost' — it forms the node's base_url for signed dispatch.
      if (updates.nodeName !== undefined) {
        const name = String(updates.nodeName).trim();
        if (!name || name.length > 64 || /[\\x00-\\x1f]/.test(name)) {
          return res.status(400).json({ error: 'Node name must be 1-64 characters, no control characters' });
        }
        updates.nodeName = name;
      }
      if (updates.hostIp !== undefined) {
        const ip = String(updates.hostIp).trim();
        const ipv4 = /^(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}$/;
        const hostname = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
        if (!ipv4.test(ip) && !hostname.test(ip)) {
          return res.status(400).json({ error: 'Host IP must be a valid IPv4 address or hostname' });
        }
        updates.hostIp = ip;
      }`;

if (s.includes(oldPut)) {
  s = s.replace(oldPut, newPut);
  console.log('✅ PUT /settings/dev validates nodeName + hostIp');
} else {
  console.log('❌ PUT block not found verbatim');
}

// PUT /settings/dev — sync to process.env (like logLevel)
const oldSync = `      if (updates.debugMode !== undefined) {
        process.env.LOG_LEVEL = updates.debugMode === 'true' ? 'debug' : (updates.logLevel || process.env.LOG_LEVEL || 'info');
      }
      if (updates.logLevel) process.env.LOG_LEVEL = updates.logLevel;
      if (updates.embeddingModel) process.env.CF_EMBEDDING_MODEL = updates.embeddingModel;`;
const newSync = `      if (updates.debugMode !== undefined) {
        process.env.LOG_LEVEL = updates.debugMode === 'true' ? 'debug' : (updates.logLevel || process.env.LOG_LEVEL || 'info');
      }
      if (updates.logLevel) process.env.LOG_LEVEL = updates.logLevel;
      if (updates.embeddingModel) process.env.CF_EMBEDDING_MODEL = updates.embeddingModel;
      // Node identity — sync to process.env so delegation self-detect and the
      // self-row pick up the new values on next boot (they read env).
      if (updates.nodeName) process.env.NODE_NAME = updates.nodeName;
      if (updates.hostIp) process.env.HOST_IP = updates.hostIp;`;

if (s.includes(oldSync)) {
  s = s.replace(oldSync, newSync);
  console.log('✅ PUT syncs nodeName/hostIp to process.env');
} else {
  console.log('❌ sync block not found verbatim');
}

writeFileSync(S, s);
