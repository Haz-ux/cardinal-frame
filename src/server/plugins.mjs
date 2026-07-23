/**
 * PluginLoader - dynamic plugin discovery, loading, unloading, reload, and hook dispatch.
 *
 * Lifecycle:
 *   1. discover()  - scan plugins/ for manifest.json + index.mjs
 *   2. load()      - dynamic import() the entry, register in DB + in-memory Map
 *   3. fireHook()  - dispatch events to all enabled plugins that export the hook
 *   4. reload()    - unload + reload a single plugin (hot-reload)
 *   5. unload()    - remove from memory (DB record stays for re-enable)
 *
 * Hook contract:
 *   Each hook is async function(data, config) - receives event data + the plugin config JSON.
 *   Errors are isolated: one plugin throwing does NOT block others.
 *
 * Available hooks:
 *   onTaskCompleted   - { taskId, command, result, exitCode }
 *   onTaskFailed      - { taskId, command, stderr, exitCode }
 *   onChatMessage     - { conversationId, role, content, model, provider }
 *   onAgentStep       - { sessionId, step, toolName, result, success }
 *   onSkillExecuted   - { skillId, skillName, input, output, success, durationMs }
 *   onServerStart     - { port, version }
 *   onServerStop      - { signal, port }
 *   onCommsMessage    - { channelId, platform, direction, message }
 */

import { randomUUID } from 'crypto';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export class PluginLoader {
  /** @param {{ db: import('better-sqlite3').Database, stmts: object, logger: object, broadcast: Function }} deps */
  constructor({ db, stmts, logger, broadcast }) {
    this.db = db;
    this.stmts = stmts;
    this.logger = logger;
    this.broadcast = broadcast;
    /** id → { module, hooks[], dir } */
    this.loaded = new Map();
    /** path → module cache for ESM import dedup */
    this.importCache = new Map();
    this.pluginsDir = path.join(import.meta.dirname, '..', '..', 'plugins');
  }

  /** Read + validate a manifest.json */
  readManifest(dirPath) {
    const manifestPath = path.join(dirPath, 'manifest.json');
    if (!existsSync(manifestPath)) return null;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!raw.name || typeof raw.name !== 'string') throw new Error('manifest.name is required');
      if (!Array.isArray(raw.hooks)) raw.hooks = [];
      return raw;
    } catch (err) {
      this.logger.error(`Plugin manifest invalid at ${dirPath}: ${err.message}`);
      return null;
    }
  }

  /** Dynamically import a plugin entry */
  async importPlugin(dirPath) {
    const entryPath = path.join(dirPath, 'index.mjs');
    if (!existsSync(entryPath)) return null;
    const url = pathToFileURL(entryPath).href;
    // Bust ESM cache by appending a query string so reload() picks up source changes
    const bustUrl = url + '?t=' + Date.now();
    const mod = await import(bustUrl);
    return mod;
  }

  /** Load a single plugin from a directory into memory + DB */
  async loadFromDir(dirPath) {
    const manifest = this.readManifest(dirPath);
    if (!manifest) return null;

    try {
      const mod = await this.importPlugin(dirPath);
      if (!mod) return null;

      // Check if already registered in DB
      const existing = this.db.prepare('SELECT id FROM plugins WHERE name = ?').get(manifest.name);
      const id = existing?.id || randomUUID();

      if (existing) {
        // Update entry point + hooks (keep config + enabled from DB)
        this.db.prepare('UPDATE plugins SET entry_point = ?, hooks = ?, version = ? WHERE id = ?')
          .run(path.join(dirPath, 'index.mjs'), JSON.stringify(manifest.hooks), manifest.version || '1.0.0', id);
      } else {
        this.stmts.plugins.insert.run(id, manifest.name, manifest.version || '1.0.0',
          path.join(dirPath, 'index.mjs'), 1, '{}', JSON.stringify(manifest.hooks));
      }

      this.loaded.set(id, { module: mod, hooks: manifest.hooks, dir: dirPath });
      this.logger.info(`Plugin loaded: ${manifest.name} v${manifest.version || '1.0.0'} (${manifest.hooks.length} hooks)`);
      this.broadcast('plugin:loaded', { id, name: manifest.name, hooks: manifest.hooks });
      return { id, manifest, module: mod };
    } catch (err) {
      // Mark as error in DB if exists
      if (manifest?.name) {
        const row = this.db.prepare('SELECT id FROM plugins WHERE name = ?').get(manifest.name);
        if (row) {
          this.db.prepare('UPDATE plugins SET enabled = 0 WHERE id = ?').run(row.id);
        }
      }
      this.logger.error(`Failed to load plugin ${manifest?.name || dirPath}: ${err.message}`);
      this.broadcast('plugin:error', { name: manifest?.name, error: err.message });
      return null;
    }
  }

  /** Discover + load all plugins from plugins/ directory */
  async discover() {
    if (!existsSync(this.pluginsDir)) {
      this.logger.info('No plugins/ directory found — skipping plugin discovery');
      return;
    }
    const entries = readdirSync(this.pluginsDir);
    for (const entry of entries) {
      const fullDir = path.join(this.pluginsDir, entry);
      if (statSync(fullDir).isDirectory()) {
        await this.loadFromDir(fullDir);
      }
    }
    this.logger.info(`Plugin discovery complete: ${this.loaded.size} plugins loaded`);
  }

  /** Unload a plugin from memory (DB record stays for re-enable) */
  unload(id) {
    const plugin = this.loaded.get(id);
    if (!plugin) return false;
    this.loaded.delete(id);
    const row = this.stmts.plugins.getById.get(id);
    this.logger.info(`Plugin unloaded: ${row?.name || id}`);
    this.broadcast('plugin:unloaded', { id, name: row?.name });
    return true;
  }

  /** Hot-reload a single plugin by ID */
  async reload(id) {
    const row = this.stmts.plugins.getById.get(id);
    if (!row) return { error: 'Plugin not found' };

    // Get directory from entry_point
    const dir = path.dirname(row.entry_point);
    this.unload(id);
    const result = await this.loadFromDir(dir);
    if (!result) return { error: 'Failed to reload plugin' };
    this.broadcast('plugin:reloaded', { id, name: row.name });
    return { id, name: row.name, reloaded: true };
  }

  /** Reload all plugins */
  async reloadAll() {
    const ids = [...this.loaded.keys()];
    const results = [];
    for (const id of ids) {
      results.push(await this.reload(id));
    }
    return results;
  }

  /** Load a plugin from DB record (used when toggling from inactive → active) */
  async loadById(id) {
    const row = this.stmts.plugins.getById.get(id);
    if (!row) return { error: 'Plugin not found' };
    const dir = path.dirname(row.entry_point);
    const result = await this.loadFromDir(dir);
    if (!result) return { error: 'Failed to load plugin' };
    return { id, name: row.name, loaded: true };
  }

  /**
   * Fire a hook to all enabled plugins.
   * @param {string} hookName — e.g. 'onTaskCompleted'
   * @param {object} data — event payload
   */
  async fireHook(hookName, data) {
    const promises = [];
    for (const [id, plugin] of this.loaded) {
      const fn = plugin.module[hookName];
      if (typeof fn !== 'function') continue;

      // Check enabled in DB (cheap query, prepared statement)
      const row = this.stmts.plugins.getById.get(id);
      if (!row || !row.enabled) continue;

      // Fire — errors are isolated
      promises.push(
        Promise.resolve()
          .then(() => fn(data, JSON.parse(row.config || '{}')))
          .catch(err => {
            this.logger.error(`Plugin ${row.name} hook ${hookName} error: ${err.message}`);
          })
      );
    }
    await Promise.all(promises);
  }
}
