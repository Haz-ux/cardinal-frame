/**
 * Cardinal Frame — Plugin Marketplace Routes
 *
 * Plugin marketplace: browse, search, install plugins from external
 * market sources (GitHub repos or JSON endpoints) and direct URLs.
 * Mirrors the skill-hub flow:
 *   - Hub sources CRUD + async scan (plugins-index.json)
 *   - Search across sources
 *   - Install from a source catalog entry
 *   - Install from a direct URL base (manifest.json + index.mjs)
 *
 * Installed plugins are written to plugins/<name>/ and loaded through the
 * existing PluginLoader so they appear in the local Plugins UI immediately.
 *
 * Security:
 *   - SSRF-safe fetch (safeFetch — hostname blocklist + DNS re-check per hop)
 *   - Name sanitization (no path traversal)
 *   - Static risk scan of plugin code before activation (audit logged)
 *
 * Dependencies: db, stmts, authMiddleware, requireRole, apiLimiter,
 *               logger, broadcast, auditLog, pluginLoader, randomUUID
 */

import express from 'express';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { safeFetch } from '../safe-fetch.mjs';

const PLUGIN_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MAX_CODE_BYTES = 2 * 1024 * 1024; // 2 MB safety cap on plugin source

export default function pluginMarketRoutes(ctx) {
  const { db, stmts, authMiddleware, requireRole, apiLimiter, logger, broadcast, auditLog, pluginLoader } = ctx;
  const router = express.Router();

  // SSRF protection — reject internal/loopback/link-local addresses
  function isInternalUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      const host = u.hostname;
      if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
      if (host.startsWith('127.')) return true;
      if (host.startsWith('10.') || host.startsWith('192.168.')) return true;
      if (host.startsWith('169.254.')) return true;
      if (host.startsWith('172.')) {
        const octet = parseInt(host.split('.')[1], 10);
        if (octet >= 16 && octet <= 31) return true;
      }
      return false;
    } catch { return false; }
  }

  // ─── Hub Sources CRUD ──────────────────────────────────────────

  // List all market sources
  router.get('/plugins/market/sources', authMiddleware, (_req, res) => {
    try {
      const sources = stmts.pluginMarket.getAll.all();
      res.json(sources.map(s => ({
        ...s,
        installed_plugins: JSON.parse(s.installed_plugins || '[]'),
        scan_result: s.scan_result ? JSON.parse(s.scan_result) : null,
      })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Add a market source (GitHub repo URL or direct JSON endpoint)
  router.post('/plugins/market/sources', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { name, url, type = 'github' } = req.body;
      if (!name || !url) return res.status(400).json({ error: 'name and url required' });

      if (isInternalUrl(url)) return res.status(403).json({ error: 'Internal/private URLs not allowed' });

      const existing = db.prepare('SELECT id FROM plugin_market_sources WHERE url = ?').get(url);
      if (existing) return res.status(409).json({ error: 'Market source already registered' });

      const id = randomUUID();
      stmts.pluginMarket.insert.run(id, name, url, type, 0, 0, 'pending');
      logger.info(`Plugin market source added: ${name} (${url})`);
      broadcast('plugins:market:source-added', { id, name, url });

      scanSource(id, name, url, type).catch(e => {
        logger.error(`Plugin market scan failed for ${name}: ${e.message}`);
      });

      res.status(201).json({ id, name, url, type, scan_status: 'pending' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Delete a market source
  router.delete('/plugins/market/sources/:id', authMiddleware, requireRole('admin'), (req, res) => {
    try {
      const source = stmts.pluginMarket.getById.get(req.params.id);
      if (!source) return res.status(404).json({ error: 'Market source not found' });
      stmts.pluginMarket.delete.run(req.params.id);
      broadcast('plugins:market:source-removed', { id: req.params.id });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Manual rescan of a market source
  router.post('/plugins/market/sources/:id/scan', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
      const source = stmts.pluginMarket.getById.get(req.params.id);
      if (!source) return res.status(404).json({ error: 'Market source not found' });

      stmts.pluginMarket.updateScan.run('scanning', null, 0, req.params.id);
      broadcast('plugins:market:scanning', { id: req.params.id, name: source.name });

      scanSource(req.params.id, source.name, source.url, source.type).catch(e => {
        logger.error(`Plugin market rescan failed for ${source.name}: ${e.message}`);
      });

      res.json({ ok: true, scan_status: 'scanning' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Search / Browse ───────────────────────────────────────────

  // Search plugins across all registered market sources
  router.get('/plugins/market/search', authMiddleware, async (req, res) => {
    try {
      const query = (req.query.q || '').toLowerCase();
      const sources = stmts.pluginMarket.getAll.all();
      const results = [];

      for (const source of sources) {
        const catalog = JSON.parse(source.installed_plugins || '[]');
        for (const plugin of catalog) {
          const haystack = [plugin.name, plugin.description, (plugin.tags || []).join(' ')]
            .filter(Boolean).join(' ').toLowerCase();
          if (!query || haystack.includes(query)) {
            results.push({
              ...plugin,
              market_source: source.name,
              market_source_id: source.id,
              verified: !!source.verified,
              trust_score: source.trust_score,
            });
          }
        }
      }

      res.json({ results, count: results.length, sources_scanned: sources.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Install ───────────────────────────────────────────────────

  // Install a plugin from a market source catalog entry
  router.post('/plugins/market/install', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { source_id, plugin_name } = req.body;
      if (!source_id || !plugin_name) return res.status(400).json({ error: 'source_id and plugin_name required' });

      const source = stmts.pluginMarket.getById.get(source_id);
      if (!source) return res.status(404).json({ error: 'Market source not found' });

      const catalog = JSON.parse(source.installed_plugins || '[]');
      const entry = catalog.find(p => p.name === plugin_name);
      if (!entry) return res.status(404).json({ error: `Plugin "${plugin_name}" not found in market source` });

      if (!PLUGIN_NAME_RE.test(plugin_name)) {
        return res.status(400).json({ error: 'Plugin name must match [a-zA-Z0-9][a-zA-Z0-9_-]*' });
      }

      // Entry must provide a fetchable base URL (manifest.json + index.mjs)
      if (!entry.url) return res.status(400).json({ error: `Plugin "${plugin_name}" has no installable URL` });

      const result = await installFromUrl(plugin_name, entry.url, entry.version, req);
      if (result.error) return res.status(result.status || 500).json({ error: result.error });
      res.status(201).json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Install a plugin from a direct URL base
  router.post('/plugins/market/install-url', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { url, name, version } = req.body;
      if (!url) return res.status(400).json({ error: 'url required' });

      if (isInternalUrl(url)) return res.status(403).json({ error: 'Internal/private URLs not allowed' });

      const result = await installFromUrl(name || null, url, version, req);
      if (result.error) return res.status(result.status || 500).json({ error: result.error });
      res.status(201).json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Installer core ────────────────────────────────────────────

  /**
   * Fetch manifest.json + index.mjs from a plugin base URL, validate,
   * write to plugins/<name>/, then load via PluginLoader.
   */
  async function installFromUrl(nameHint, baseUrl, versionHint, req) {
    try {
      // Normalize: allow passing a full manifest.json URL or a base dir URL
      let base = baseUrl.trim();
      if (base.endsWith('manifest.json')) {
        base = base.slice(0, -'manifest.json'.length);
      }
      if (!base.endsWith('/')) base += '/';

      const manifestUrl = base + 'manifest.json';
      const entryUrl = base + 'index.mjs';

      const manResp = await safeFetch(manifestUrl, { signal: AbortSignal.timeout(20000) });
      if (!manResp.ok) return { status: 502, error: `Failed to fetch manifest (HTTP ${manResp.status})` };

      let manifest;
      try {
        manifest = await manResp.json();
      } catch {
        return { status: 502, error: 'Invalid manifest.json — not valid JSON' };
      }

      if (!manifest.name || typeof manifest.name !== 'string') {
        return { status: 400, error: 'manifest.name is required' };
      }
      if (!PLUGIN_NAME_RE.test(manifest.name)) {
        return { status: 400, error: 'Plugin name must match [a-zA-Z0-9][a-zA-Z0-9_-]*' };
      }
      if (!Array.isArray(manifest.hooks)) manifest.hooks = [];

      const name = nameHint && PLUGIN_NAME_RE.test(nameHint) ? nameHint : manifest.name;

      // Already installed?
      const pluginsDir = pluginLoader.pluginsDir;
      const targetDir = path.join(pluginsDir, name);
      if (existsSync(targetDir)) {
        return { status: 409, error: `Plugin "${name}" already exists on disk` };
      }
      const existing = db.prepare('SELECT id FROM plugins WHERE name = ?').get(name);
      if (existing) {
        return { status: 409, error: `Plugin "${name}" is already registered` };
      }

      // Fetch entry code (bounded)
      const codeResp = await safeFetch(entryUrl, { signal: AbortSignal.timeout(20000) });
      if (!codeResp.ok) return { status: 502, error: `Failed to fetch index.mjs (HTTP ${codeResp.status})` };
      const code = await codeResp.text();
      if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
        return { status: 413, error: 'Plugin source exceeds 2 MB limit' };
      }

      // Static risk scan before writing to disk
      const risk = scanPluginCode(code);

      mkdirSync(targetDir, { recursive: true });
      writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      writeFileSync(path.join(targetDir, 'index.mjs'), code);

      // Register + load through the standard loader
      const loaded = await pluginLoader.loadFromDir(targetDir);
      if (!loaded) {
        return { status: 500, error: 'Plugin failed to load after install — check server logs' };
      }

      auditLog(stmts, req?.user?.username || 'system', 'plugins:market:install', name, {
        url: base, version: manifest.version || versionHint || '1.0.0',
        risk, hooks: manifest.hooks,
      });
      logger.info(`Plugin installed from market: ${name} v${manifest.version || '1.0.0'} (risk ${risk.verdict})`);
      broadcast('plugins:market:installed', { id: loaded.id, name, risk: risk.verdict });

      return {
        id: loaded.id, name, version: manifest.version || versionHint || '1.0.0',
        hooks: manifest.hooks, risk,
      };
    } catch (e) {
      logger.error(`Plugin market install failed for ${nameHint || baseUrl}: ${e.message}`);
      return { status: 502, error: `Install failed: ${e.message}` };
    }
  }

  // ─── Async Market Source Scanner ───────────────────────────────

  async function scanSource(sourceId, name, url, type) {
    try {
      stmts.pluginMarket.updateScan.run('scanning', null, 0, sourceId);

      let plugins = [];

      if (type === 'github') {
        const rawUrl = url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
        const indexUrl = rawUrl.endsWith('/') ? `${rawUrl}plugins-index.json` : `${rawUrl}/main/plugins-index.json`;
        const resp = await safeFetch(indexUrl, { signal: AbortSignal.timeout(20000) });
        if (resp.ok) {
          const data = await resp.json();
          plugins = data.plugins || [];
        } else {
          const dirUrl = rawUrl.endsWith('/') ? `${rawUrl}plugins` : `${rawUrl}/main/plugins`;
          plugins = [{ name: 'unknown', description: 'Could not auto-detect plugins index. Manual install required.', url: dirUrl }];
        }
      } else if (type === 'url') {
        const resp = await safeFetch(url, { signal: AbortSignal.timeout(15000) });
        if (resp.ok) {
          const data = await resp.json();
          plugins = data.plugins || data || [];
        }
      }

      const trustScore = plugins.length > 0 ? Math.min(100, plugins.length * 10) : 0;
      const scanResult = { plugins_found: plugins.length, scanned_at: new Date().toISOString() };

      stmts.pluginMarket.updateScan.run('passed', JSON.stringify(scanResult), trustScore, sourceId);
      stmts.pluginMarket.updateInstalled.run(JSON.stringify(plugins), sourceId);

      logger.info(`Plugin market scan complete: ${name} — ${plugins.length} plugins found`);
      broadcast('plugins:market:scanned', { source_id: sourceId, name, plugins_found: plugins.length });
    } catch (e) {
      stmts.pluginMarket.updateScan.run('failed', JSON.stringify({ error: e.message }), 0, sourceId);
      logger.error(`Plugin market scan failed for ${name}: ${e.message}`);
    }
  }

  // ─── Static Risk Scan ──────────────────────────────────────────

  function scanPluginCode(code) {
    const checks = {
      hasShellCommands: /child_process|\bexec\(|\bspawn\(|\bos\.system\b|\bsubprocess/.test(code),
      hasDynamicEval: /\beval\(|\bnew Function\b/.test(code),
      hasNetworkAccess: /\bfetch\(|\bhttp\.|\bhttps\.|\baxios\b|\brequest\(|\bWebSocket/.test(code),
      hasFileAccess: /\bfs\b|readFile|writeFile|unlink|mkdir/.test(code),
      hasEnvAccess: /\bprocess\.env\b|\bos\.environ/.test(code),
    };

    const riskScore = Object.values(checks).filter(Boolean).length;
    return {
      risk_score: riskScore,
      checks,
      verdict: riskScore === 0 ? 'safe' : riskScore <= 2 ? 'caution' : 'elevated',
      scanned_at: new Date().toISOString(),
    };
  }

  return router;
}
