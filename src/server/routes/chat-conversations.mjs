import express from 'express';
import path from 'path';
import { mkdirSync, writeFileSync, existsSync } from 'fs';

/**
 * Chat conversations, messages, file upload, and attachments.
 * Dependencies: db, stmts, authMiddleware, apiLimiter, audit, randomUUID, DATA_DIR
 */
export default function chatConvRoutes(ctx) {
  const { db, stmts, authMiddleware, apiLimiter, audit, randomUUID, DATA_DIR } = ctx;
  const router = express.Router();

  const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
  mkdirSync(UPLOAD_DIR, { recursive: true });

  // ─── Chat Conversations ───────────────────────────────────────
  router.get('/chat/conversations', authMiddleware, (req, res) => {
    const convs = stmts.conversations.getAll.all(req.user.id);
    res.json(convs.map(c => ({ ...c, model: c.model || '' })));
  });

  router.post('/chat/conversations', authMiddleware, apiLimiter, (req, res) => {
    const id = randomUUID();
    const { title, model, system_prompt } = req.body;
    stmts.conversations.insert.run(id, title || 'New Chat', req.user.id, model || '', system_prompt || '');
    audit('create', 'conversation', id, req.user.id, { title });
    res.status(201).json({ id, title: title || 'New Chat', model: model || '', system_prompt: system_prompt || '' });
  });

  router.put('/chat/conversations/:id', authMiddleware, (req, res) => {
    const conv = stmts.conversations.getById.get(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { title, model, system_prompt } = req.body;
    stmts.conversations.update.run(title ?? conv.title, model ?? conv.model, system_prompt ?? conv.system_prompt, req.params.id);
    res.json({ ok: true });
  });

  router.delete('/chat/conversations/:id', authMiddleware, (req, res) => {
    const conv = stmts.conversations.getById.get(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    stmts.conversations.delete.run(req.params.id);
    audit('delete', 'conversation', req.params.id, req.user.id, { title: conv.title });
    res.json({ ok: true });
  });

  // ─── Chat Messages ────────────────────────────────────────────
  router.get('/chat/conversations/:id/messages', authMiddleware, (req, res) => {
    const conv = stmts.conversations.getById.get(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const msgs = stmts.messages.getByConversation.all(req.params.id);
    res.json(msgs.map(m => ({ ...m, attachments: JSON.parse(m.attachments || '[]'), tool_calls: JSON.parse(m.tool_calls || '[]') })));
  });

  // ─── Chat File Upload ──────────────────────────────────────────
  router.post('/chat/upload', authMiddleware, apiLimiter, (req, res) => {
    const { filename, mime_type, content_b64, message_id } = req.body;
    if (!filename || !content_b64) return res.status(400).json({ error: 'filename and content_b64 required' });
    // M2: never trust the client-supplied filename — strip to a bare name
    // and reject anything that even smells like traversal.
    const rawName = String(filename);
    const safeName = path.basename(rawName);
    if (!safeName || safeName === '.' || safeName === '..' || rawName.includes('..') || /[\\/]/.test(rawName)) {
      return res.status(400).json({ error: 'invalid filename' });
    }
    const id = randomUUID();
    const buf = Buffer.from(content_b64, 'base64');
    const storagePath = path.join(UPLOAD_DIR, `${id}-${safeName}`);
    // Defense in depth: the resolved path must stay inside UPLOAD_DIR.
    if (!path.resolve(storagePath).startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
      return res.status(400).json({ error: 'invalid filename' });
    }
    writeFileSync(storagePath, buf);
    const msgId = message_id || null;
    try {
      stmts.attachments.insert.run(id, msgId, null, safeName, mime_type || 'application/octet-stream', buf.length, storagePath);
    } catch (e) {
      db.prepare('INSERT INTO chat_attachments (id, filename, mime_type, size, storage_path) VALUES (?, ?, ?, ?, ?)')
        .run(id, safeName, mime_type || 'application/octet-stream', buf.length, storagePath);
    }
    res.status(201).json({ id, filename: safeName, mime_type: mime_type || 'application/octet-stream', size: buf.length, message_id: msgId });
  });

  router.get('/chat/attachments/:id', authMiddleware, (req, res) => {
    const att = db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(req.params.id);
    if (!att) return res.status(404).json({ error: 'Attachment not found' });
    if (!att.storage_path || !existsSync(att.storage_path)) return res.status(404).json({ error: 'File missing' });
    res.setHeader('Content-Type', att.mime_type);
    // L2: sanitize the reflected filename — basename + strip quotes,
    // backslashes and line breaks so it can't break out of the header.
    const dlName = path.basename(String(att.filename || 'download')).replace(/["\\\r\n]/g, '');
    res.setHeader('Content-Disposition', `inline; filename="${dlName}"`);
    res.sendFile(att.storage_path);
  });

  return router;
}
