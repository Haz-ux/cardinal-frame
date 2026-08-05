import express from 'express';
import path from 'path';

/**
 * State files routes: MEMORY.md, PERSONA.md, etc. + FTS context explorer.
 * Dependencies: db, stmts, authMiddleware, requireRole
 */
export default function stateRoutes(ctx) {
  const { db, authMiddleware, requireRole } = ctx;
  const router = express.Router();

  const STATE_FILES_DIR = path.resolve(process.cwd(), 'state');
  // CLAUDE.md and AGENTS.md serve the same purpose, so only AGENTS.md is kept.
  const STATE_FILES = ['MEMORY.md', 'PERSONA.md', 'AGENTS.md'];

  // ─── State Files ──────────────────────────────────────────────
  router.get('/state', authMiddleware, async (_req, res) => {
    try {
      const fs = await import('fs');
      await fs.promises.mkdir(STATE_FILES_DIR, { recursive: true });
      const files = [];
      for (const name of STATE_FILES) {
        const fp = path.join(STATE_FILES_DIR, name);
        try {
          const content = await fs.promises.readFile(fp, 'utf8');
          const stat = await fs.promises.stat(fp);
          files.push({ name, content, size: stat.size, modified: stat.mtime.toISOString() });
        } catch { files.push({ name, content: '', size: 0, modified: null }); }
      }
      res.json(files);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/state/:name', authMiddleware, async (req, res) => {
    try {
      const fs = await import('fs');
      const name = req.params.name;
      if (!STATE_FILES.includes(name)) return res.status(400).json({ error: 'Invalid state file' });
      const fp = path.join(STATE_FILES_DIR, name);
      try { const content = await fs.promises.readFile(fp, 'utf8'); res.json({ name, content }); }
      catch { res.json({ name, content: '' }); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/state/:name', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
      const fs = await import('fs');
      const name = req.params.name;
      if (!STATE_FILES.includes(name)) return res.status(400).json({ error: 'Invalid state file' });
      const { content } = req.body;
      if (typeof content !== 'string') return res.status(400).json({ error: 'Content must be a string' });
      await fs.promises.mkdir(STATE_FILES_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(STATE_FILES_DIR, name), content, 'utf8');
      res.json({ name, content, size: content.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── FTS Context Explorer ─────────────────────────────────────
  router.get('/context/injections', authMiddleware, (req, res) => {
    try {
      const convId = req.query.conversation_id;
      if (!convId) return res.json([]);
      const messages = db.prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 20').all(convId);
      const injections = messages.map(m => ({
        id: m.id,
        type: m.role === 'user' ? 'user_input' : 'model_output',
        summary: (m.content || '').slice(0, 120) + ((m.content || '').length > 120 ? '…' : ''),
        timestamp: m.created_at,
        tokens: Math.ceil((m.content || '').length / 4),
      }));
      res.json(injections);
    } catch (e) { res.json([]); }
  });

  return router;
}
