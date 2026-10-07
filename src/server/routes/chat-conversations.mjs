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
    // Sanitize the user-supplied filename so it can never escape UPLOAD_DIR
    // (strip path separators, directory traversal, and control chars).
    const safeName = String(filename).split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const id = randomUUID();
    const buf = Buffer.from(content_b64, 'base64');
    const storagePath = path.join(UPLOAD_DIR, `${id}-${safeName}`);
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
    // Ownership check: an attachment belongs to the user who owns the
    // conversation that its message belongs to. Admins can read any.
    const att = db.prepare(`
      SELECT a.*, c.user_id AS owner_id
      FROM chat_attachments a
      LEFT JOIN chat_messages m ON a.message_id = m.id
      LEFT JOIN chat_conversations c ON m.conversation_id = c.id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!att) return res.status(404).json({ error: 'Attachment not found' });
    // file_id-only attachments carry no conversation owner; lock those to
    // their uploader at creation time if available, otherwise require admin.
    if (att.owner_id && att.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!att.storage_path || !existsSync(att.storage_path)) return res.status(404).json({ error: 'File missing' });
    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${att.filename}"`);
    res.sendFile(att.storage_path);
  });

  return router;
}
