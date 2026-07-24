import express from 'express';

/**
 * Memory, Session Search, and Embedding Engine routes.
 * Dependencies: stmts, db, authMiddleware, apiLimiter, requireRole, broadcast,
 *               randomUUID, embeddings, callAgentLLM
 */

const SUMMARY_SYSTEM_PROMPT = 'You are Aimi, the Cardinal Frame AI assistant. Summarize the following content concisely and accurately in 2-3 sentences.';

/**
 * Generate LLM summaries for a set of items.
 * If the LLM call fails, returns an empty summaries array (graceful degradation).
 * @param {Array<{id:string, content:string}>} items
 * @returns {Promise<Array<{id:string, summary:string}>>}
 */
async function generateSummaries(callAgentLLM, items) {
  if (!items?.length || !callAgentLLM) return [];
  try {
    const summaries = [];
    for (const item of items) {
      const messages = [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: item.content },
      ];
      const response = await callAgentLLM(messages);
      summaries.push({ id: item.id, summary: response.content });
    }
    return summaries;
  } catch {
    // LLM unavailable — return empty so caller still gets results
    return [];
  }
}

export default function memoryRoutes(ctx) {
  const {
    stmts, db, authMiddleware, apiLimiter, requireRole,
    broadcast, randomUUID, embeddings, callAgentLLM
  } = ctx;
  const router = express.Router();

  // ─── Memory API (persistent cross-session memory) ────────────────
  // POST /api/memory — store a memory
  router.post('/memory', authMiddleware, apiLimiter, (req, res) => {
    try {
      const { category = 'memory', content, source = 'manual', confidence = 1.0 } = req.body;
      if (!content) return res.status(400).json({ error: 'content required' });
      const id = randomUUID();
      stmts.memories.insert.run(id, req.user.id, category, content, source, confidence);
      // Index in FTS
      try { db.prepare('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)').run(db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id).rowid, content); } catch { }
      broadcast('memory:created', { id, category, content: content.slice(0, 100) });
      res.status(201).json({ id, category, content, source, confidence });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/memory/stats — memory statistics (must be before /:id)
  router.get('/memory/stats', authMiddleware, (req, res) => {
    try {
      const count = stmts.memories.count.get(req.user.id).count;
      const all = stmts.memories.getByUser.all(req.user.id);
      const byCategory = {};
      for (const m of all) byCategory[m.category] = (byCategory[m.category] || 0) + 1;
      res.json({ total: count, by_category: byCategory });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/memory — list memories (optionally filtered by category, with ?summary=true for LLM summaries)
  router.get('/memory', authMiddleware, async (req, res) => {
    try {
      const { category, q, limit: lim, summary } = req.query;
      const limit = Math.min(parseInt(lim) || 50, 200);

      let results;
      if (q) {
        results = stmts.memories.search.all(q + '*', req.user.id, limit);
        for (const m of results) stmts.memories.updateAccess.run(m.id);
      } else if (category) {
        results = stmts.memories.getByCategory.all(req.user.id, category);
      } else {
        results = stmts.memories.getByUser.all(req.user.id).slice(0, limit);
      }

      if (summary && results.length > 0) {
        const summaries = await generateSummaries(callAgentLLM, results);
        return res.json({ results, summaries });
      }
      if (summary) {
        // summary requested but no results — return consistent shape
        return res.json({ results, summaries: [] });
      }
      res.json(results);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/memory/:id — get a specific memory (with optional ?summary=true)
  router.get('/memory/:id', authMiddleware, async (req, res) => {
    try {
      const memory = stmts.memories.getById.get(req.params.id);
      if (!memory) return res.status(404).json({ error: 'Memory not found' });
      if (memory.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
      stmts.memories.updateAccess.run(req.params.id);
      if (req.query.summary) {
        const summaries = await generateSummaries(callAgentLLM, [memory]);
        const summary = summaries.length > 0 ? summaries[0].summary : null;
        return res.json({ ...memory, summary });
      }
      res.json(memory);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /api/memory/:id — update a memory
  router.patch('/memory/:id', authMiddleware, (req, res) => {
    try {
      const memory = stmts.memories.getById.get(req.params.id);
      if (!memory) return res.status(404).json({ error: 'Memory not found' });
      if (memory.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
      const { content, category } = req.body;
      stmts.memories.update.run(content || memory.content, category || memory.category, req.params.id);
      // Update FTS
      try { db.prepare('UPDATE memories_fts SET content = ? WHERE rowid = ?').run(content || memory.content, db.prepare('SELECT rowid FROM memories WHERE id = ?').get(req.params.id).rowid); } catch { }
      res.json({ ...memory, content: content || memory.content, category: category || memory.category });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/memory/:id — delete a memory
  router.delete('/memory/:id', authMiddleware, (req, res) => {
    try {
      const memory = stmts.memories.getById.get(req.params.id);
      if (!memory) return res.status(404).json({ error: 'Memory not found' });
      if (memory.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
      try { db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(db.prepare('SELECT rowid FROM memories WHERE id = ?').get(req.params.id).rowid); } catch { }
      stmts.memories.delete.run(req.params.id);
      res.json({ deleted: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Session Search API (FTS5 across chat + agent sessions) ───────
  // GET /api/search — full-text search across all sessions (with optional ?summary=true)
  router.get('/search', authMiddleware, async (req, res) => {
    try {
      const { q, limit: lim, summary } = req.query;
      if (!q) return res.status(400).json({ error: 'q (query) required' });
      const limit = Math.min(parseInt(lim) || 20, 100);
      const results = stmts.sessionIndex.getUserSearch.all(q + '*', req.user.id, limit);
      if (summary && results.length > 0) {
        const items = results.map(r => ({ id: r.ref_id, content: r.content }));
        const summaries = await generateSummaries(callAgentLLM, items);
        return res.json({ results, summaries });
      }
      if (summary) {
        return res.json({ results, summaries: [] });
      }
      res.json(results);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/search/index — manually index a chat message or agent action
  router.post('/search/index', authMiddleware, (req, res) => {
    try {
      const { session_type, ref_id, title, content } = req.body;
      if (!session_type || !ref_id || !content) return res.status(400).json({ error: 'session_type, ref_id, content required' });
      const id = randomUUID();
      stmts.sessionIndex.insert.run(id, session_type, ref_id, req.user.id, title || '', content);
      // Index in FTS
      try { db.prepare('INSERT INTO session_index_fts(rowid, content, title) VALUES (?, ?, ?)').run(db.prepare('SELECT rowid FROM session_index WHERE id = ?').get(id).rowid, content, title || ''); } catch { }
      res.status(201).json({ id, indexed: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Embedding Engine Endpoints ─────────────────────────────────────
  // GET /api/embeddings/status — check if model is loaded
  router.get('/embeddings/status', authMiddleware, (_req, res) => {
    res.json(embeddings.getEmbeddingStatus());
  });
  // POST /api/embeddings/load — load the MiniLM model on demand
  router.post('/embeddings/load', authMiddleware, requireRole('admin'), apiLimiter, async (_req, res) => {
    try {
      if (embeddings.isModelLoaded()) return res.json({ loaded: true, message: 'Already loaded' });
      await embeddings.getEmbeddingPipeline();
      res.json({ loaded: true, message: 'Model loaded', ...embeddings.getEmbeddingStatus() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // POST /api/embeddings/unload — unload model to free memory
  router.post('/embeddings/unload', authMiddleware, requireRole('admin'), (_req, res) => {
    const unloaded = embeddings.unloadEmbeddingModel();
    res.json({ unloaded, status: embeddings.getEmbeddingStatus() });
  });
  // POST /api/embeddings/generate — generate embeddings for given text
  router.post('/embeddings/generate', authMiddleware, apiLimiter, async (req, res) => {
    try {
      const { text, texts } = req.body;
      if (texts && Array.isArray(texts)) {
        const result = await embeddings.embedBatch(texts);
        return res.json({ embeddings: result, count: result.length, dim: result[0]?.length || 0 });
      }
      if (!text) return res.status(400).json({ error: 'text or texts required' });
      const result = await embeddings.embed(text);
      res.json({ embedding: result, dim: result.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/embeddings/similarity — compute cosine similarity between two texts
  router.post('/embeddings/similarity', authMiddleware, apiLimiter, async (req, res) => {
    try {
      const { text1, text2 } = req.body;
      if (!text1 || !text2) return res.status(400).json({ error: 'text1 and text2 required' });
      const [emb1, emb2] = await embeddings.embedBatch([text1, text2]);
      const sim = embeddings.cosineSimilarity(emb1, emb2);
      res.json({ similarity: sim });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/embeddings/search — semantic search over provided corpus
  router.post('/embeddings/search', authMiddleware, apiLimiter, async (req, res) => {
    try {
      const { query, corpus, limit = 5 } = req.body;
      if (!query || !corpus || !Array.isArray(corpus)) {
        return res.status(400).json({ error: 'query (string) and corpus (string[]) required' });
      }
      if (corpus.length === 0) return res.json({ results: [] });
      const queryEmb = await embeddings.embed(query);
      const corpusEmbs = await embeddings.embedBatch(corpus);
      const results = embeddings.searchSimilar(queryEmb, corpusEmbs, limit);
      res.json({
        results: results.map(r => ({
          index: r.index,
          text: corpus[r.index],
          similarity: r.similarity,
        })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
