/**
 * Learning-sources routes: import external conversations into the Phase-1
 * learning pipeline.
 *
 * Dependencies: db, stmts, logger, audit, authMiddleware, requireRole,
 * apiLimiter, randomUUID
 *
 * stmts used (the coordinator adds these to server.mjs — see TRACK B report):
 *   learningImports.insert / .getAll / .getByUser
 *   commsChannels.getByPlatform / .getById   (already exist)
 *
 * All import routes are admin-gated. Every import — including dry runs —
 * writes a learning_imports row and is audit()ed. Imported events land in
 * learning_events via the adapters' record() calls (redacted, idempotent,
 * capture-only: no reviews or behavior changes are triggered).
 */
import express from 'express';
import { parseJsonl, importJsonl } from '../learning/sources/jsonl.mjs';
import {
  listTelegramSources,
  resolveTelegramBotToken,
  importTelegram,
} from '../learning/sources/telegram.mjs';

const JSONL_BODY_CAP_BYTES = 1_048_576; // 1MB explicit cap, inside the 10mb global json limit
const IMPORTS_LIST_LIMIT = 100;

export default function learningSourcesRoutes(ctx) {
  const { db, stmts, logger, audit, authMiddleware, requireRole, apiLimiter, randomUUID } = ctx;
  const router = express.Router();

  function writeImportRun({ source, userId, label, status, stats, dryRun }) {
    const id = randomUUID();
    stmts.learningImports.insert.run(
      id, source, userId, label || '', status,
      stats.total || 0, stats.imported || 0, stats.deduplicated || 0,
      (stats.errors || []).length, dryRun ? 1 : 0,
    );
    return id;
  }

  // ─── JSONL text import ──────────────────────────────────────────
  router.post(
    '/learning-sources/jsonl/import',
    authMiddleware, requireRole('admin'), apiLimiter,
    (req, res) => {
      const { user_id, format, data, dry_run, label } = req.body || {};
      if (!user_id) return res.status(400).json({ error: 'user_id is required' });
      if (format !== 'jsonl-text') {
        return res.status(400).json({ error: "format must be 'jsonl-text'" });
      }
      if (typeof data !== 'string' || data.length === 0) {
        return res.status(400).json({ error: 'data is required (JSONL text)' });
      }
      if (Buffer.byteLength(data, 'utf8') > JSONL_BODY_CAP_BYTES) {
        return res.status(413).json({ error: 'data exceeds the 1MB import cap' });
      }

      const stats = importJsonl(db, {
        userId: user_id,
        text: data,
        sourceLabel: label || 'jsonl',
        dryRun: !!dry_run,
      });

      const status = stats.errors.length > 0 && stats.imported === 0 && stats.deduplicated === 0
        ? 'failed'
        : 'completed';
      const importId = writeImportRun({
        source: 'jsonl', userId: user_id, label: label || 'jsonl',
        status, stats, dryRun: !!dry_run,
      });

      audit('learning.import', 'learning_import', importId, req.user?.id || user_id, {
        source: 'jsonl', target_user: user_id, dry_run: !!dry_run,
        total: stats.total, imported: stats.imported,
        deduplicated: stats.deduplicated, errors: stats.errors.length,
      });
      logger.info(`Learning JSONL import ${importId} by ${req.user?.username || '?'}: ` +
        `${stats.imported} imported, ${stats.deduplicated} dedup, ${stats.errors.length} errors (dry_run=${!!dry_run})`);

      res.status(201).json({ import_id: importId, source: 'jsonl', dry_run: !!dry_run, status, ...stats });
    },
  );

  // ─── Telegram history import ──────────────────────────────────
  router.post(
    '/learning-sources/telegram/import',
    authMiddleware, requireRole('admin'), apiLimiter,
    async (req, res) => {
      const { user_id, chat_id, channel_id, limit, dry_run, label } = req.body || {};
      if (!user_id) return res.status(400).json({ error: 'user_id is required' });

      // The token is resolved server-side from the comms channel config —
      // the client may never supply one.
      const botToken = resolveTelegramBotToken({ stmts }, channel_id || null);
      const sources = listTelegramSources({ stmts });

      let stats;
      if (!botToken) {
        stats = {
          total: 0, imported: 0, deduplicated: 0, redacted: 0,
          errors: [{ line: 0, error: 'no Telegram bot token configured (connect a Telegram channel first)' }],
        };
      } else {
        stats = await importTelegram(db, {
          userId: user_id,
          botToken,
          chatId: chat_id || null,
          limit: limit || 50,
          dryRun: !!dry_run,
        });
      }

      const status = stats.errors.length > 0 && stats.imported === 0 && stats.deduplicated === 0
        ? 'failed'
        : 'completed';
      const importId = writeImportRun({
        source: 'telegram', userId: user_id, label: label || 'telegram',
        status, stats, dryRun: !!dry_run,
      });

      audit('learning.import', 'learning_import', importId, req.user?.id || user_id, {
        source: 'telegram', target_user: user_id, dry_run: !!dry_run,
        chat_id: chat_id || null, total: stats.total, imported: stats.imported,
        deduplicated: stats.deduplicated, errors: stats.errors.length,
      });
      logger.info(`Learning Telegram import ${importId} by ${req.user?.username || '?'}: ` +
        `${stats.imported} imported, ${stats.deduplicated} dedup, ${stats.errors.length} errors (dry_run=${!!dry_run})`);

      res.status(201).json({ import_id: importId, source: 'telegram', dry_run: !!dry_run, status, ...stats });
    },
  );

  // ─── Import run history ─────────────────────────────────────────
  router.get(
    '/learning-sources/imports',
    authMiddleware, requireRole('admin'),
    (req, res) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), IMPORTS_LIST_LIMIT);
      // Admins may filter to one user's runs; otherwise list all runs.
      const rows = req.query.user_id
        ? stmts.learningImports.getByUser.all(req.query.user_id, limit)
        : stmts.learningImports.getAll.all(limit);
      res.json(rows);
    },
  );

  // ─── Available sources (ids only — never secrets) ─────────────
  router.get(
    '/learning-sources/sources',
    authMiddleware, requireRole('admin'),
    (_req, res) => {
      res.json({
        jsonl: { format: 'jsonl-text', description: 'Paste JSONL conversation text' },
        telegram: { channels: listTelegramSources({ stmts }) },
      });
    },
  );

  return router;
}

// Pre-parse helper exported for tests/coordinator checks.
export { parseJsonl };
