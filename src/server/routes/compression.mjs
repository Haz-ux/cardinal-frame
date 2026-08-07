/**
 * Cardinal Frame — Context Compression Routes
 *
 * HTTP wrapper around the framework compression engine
 * (src/server/compression.mjs). Exposes:
 *   POST /api/compression            — compress a text blob
 *   POST /api/compression/messages   — compress a chat-message list
 *   GET  /api/compression/strategies  — list available strategies
 *
 * Dependencies: authMiddleware, requireRole, apiLimiter, callAgentLLM, logger, fireHook
 */

import express from 'express';
import { compressContext, compressMessages, compressConversation, emergencyCompress, shouldCompress } from '../compression.mjs';

export default function compressionRoutes(ctx) {
  const { authMiddleware, requireRole, apiLimiter, callAgentLLM, logger, fireHook } = ctx;
  const router = express.Router();

  // Wrap callAgentLLM to the (messages, model?) shape the engine expects.
  const llmCall = (messages, model) => callAgentLLM(messages, model || undefined);

  // List available strategies + their opts.
  router.get('/compression/strategies', authMiddleware, (_req, res) => {
    res.json({
      strategies: ['auto', 'truncate', 'headtail', 'dedupe', 'summarize'],
      conversation: ['compress', 'emergency', 'should_compress'],
      defaults: {
        strategy: 'auto',
        maxChars: 12000,
        keepHead: 4000,
        keepTail: 2000,
        headTailLines: 50,
        summarizeMaxChars: 2000,
        protectFirstN: 3,
        protectLastN: 20,
        tailTokenBudget: 20000,
        minTailUserMessages: 1,
        pruneMinChars: 200,
        contextLength: 128000,
        thresholdPercent: 0.5,
      },
    });
  });

  // Compress a text blob.
  router.post('/compression', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const {
        text,
        strategy,
        maxChars,
        keepHead,
        keepTail,
        headTailLines,
        summarizeModel,
        summarizeMaxChars,
      } = req.body || {};

      if (typeof text !== 'string') {
        return res.status(400).json({ error: 'text (string) required' });
      }

      const opts = {
        strategy: strategy || 'auto',
        ...(maxChars !== undefined && { maxChars }),
        ...(keepHead !== undefined && { keepHead }),
        ...(keepTail !== undefined && { keepTail }),
        ...(headTailLines !== undefined && { headTailLines }),
        ...(summarizeModel !== undefined && { summarizeModel }),
        ...(summarizeMaxChars !== undefined && { summarizeMaxChars }),
      };

      const result = await compressContext(text, opts, llmCall);

      // Notify plugins a compression happened.
      try {
        fireHook?.('onContextCompressed', {
          strategy: result.strategy,
          original_chars: result.original_chars,
          compressed_chars: result.compressed_chars,
          ratio: result.ratio,
        });
      } catch {}

      logger?.info?.(`[compression] strategy=${result.strategy} ${result.original_chars}→${result.compressed_chars} (${result.ratio})`);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Compress a list of chat messages into one blob.
  router.post('/compression/messages', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { messages, ...opts } = req.body || {};
      if (!Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages (array of {role,content}) required' });
      }
      const result = await compressMessages(messages, opts, llmCall);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Compress a conversation transcript with head/middle/tail compaction.
  // Body: { messages, emergency?: bool, ...opts } — opts may include
  // protectFirstN, protectLastN, tailTokenBudget, pruneMinChars,
  // previousSummary, summarizeModel, etc.
  router.post('/compression/conversation', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { messages, emergency, previousSummary, ...opts } = req.body || {};
      if (!Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages (array of {role,content}) required' });
      }
      const run = emergency ? emergencyCompress : compressConversation;
      const result = await run(messages, { ...opts, ...(previousSummary !== undefined && { previousSummary }) }, llmCall);

      try {
        fireHook?.('onContextCompressed', {
          strategy: result.strategy,
          original_msgs: result.original_msgs,
          compressed_msgs: result.compressed_msgs,
          pruned: result.pruned || 0,
        });
      } catch {}

      logger?.info?.(`[compression] conversation strategy=${result.strategy} ${result.original_msgs}→${result.compressed_msgs} msgs (pruned ${result.pruned || 0})`);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Check whether a conversation is approaching the context limit.
  // Body: { messages, contextLength?, thresholdPercent? }
  router.post('/compression/conversation/status', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const { messages, contextLength, thresholdPercent, maxTokens } = req.body || {};
      if (!Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages (array of {role,content}) required' });
      }
      const result = shouldCompress(messages, { contextLength, thresholdPercent, maxTokens });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
