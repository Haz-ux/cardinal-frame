// ── Embedding Engine: On-demand MiniLM with load/unload ─────────────
// Uses @xenova/transformers with Xenova/all-MiniLM-L6-v2 (~22MB)
// Designed to be loaded on demand and unloaded to free memory (avoid OOM when running 7B models)

let _pipeline = null;
let _loading = false;
let _loadPromise = null;
let _lastUsed = null;
let _modelSize = null;

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const IDLE_UNLOAD_MS = 5 * 60 * 1000; // auto-unload after 5 min idle

/**
 * Load the embedding pipeline on demand.
 * Returns the cached pipeline if already loaded.
 */
export async function getEmbeddingPipeline() {
  if (_pipeline) {
    _lastUsed = Date.now();
    return _pipeline;
  }
  if (_loadPromise) return _loadPromise;

  _loading = true;
  _loadPromise = (async () => {
    try {
      const { pipeline } = await import('@xenova/transformers');
      _pipeline = await pipeline('feature-extraction', MODEL_ID, {
        quantized: true, // use quantized model for smaller footprint
      });
      _lastUsed = Date.now();
      _modelSize = '~22MB (quantized)';
      console.log(`[Embeddings] Loaded ${MODEL_ID} (${_modelSize})`);

      // Start idle unload watcher
      _startIdleWatcher();

      return _pipeline;
    } catch (e) {
      console.error(`[Embeddings] Failed to load model: ${e.message}`);
      _loadPromise = null;
      throw e;
    } finally {
      _loading = false;
    }
  })();

  return _loadPromise;
}

/**
 * Unload the model and free memory.
 */
export function unloadEmbeddingModel() {
  if (_pipeline) {
    // Xenova/transformers doesn't have explicit dispose, but we can drop references
    _pipeline = null;
    _loadPromise = null;
    _modelSize = null;
    _lastUsed = null;
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    console.log('[Embeddings] Model unloaded, memory freed');
    return true;
  }
  return false;
}

/**
 * Check if the model is currently loaded.
 */
export function isModelLoaded() {
  return _pipeline !== null;
}

/**
 * Get model status info.
 */
export function getEmbeddingStatus() {
  return {
    loaded: _pipeline !== null,
    loading: _loading,
    model_id: MODEL_ID,
    model_size: _modelSize,
    last_used: _lastUsed ? new Date(_lastUsed).toISOString() : null,
    idle_ms: _lastUsed ? Date.now() - _lastUsed : null,
  };
}

// ── Idle unload watcher ──
let _idleTimer = null;

function _startIdleWatcher() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(_checkIdle, 60000); // check every 60s
}

function _checkIdle() {
  if (_pipeline && _lastUsed) {
    const idle = Date.now() - _lastUsed;
    if (idle > IDLE_UNLOAD_MS) {
      console.log(`[Embeddings] Auto-unloading after ${Math.round(idle / 1000)}s idle`);
      unloadEmbeddingModel();
      return;
    }
  }
  if (_pipeline) {
    _idleTimer = setTimeout(_checkIdle, 60000);
  }
}

/**
 * Generate embeddings for a text string.
 * Loads the model on demand if not already loaded.
 * Returns a Float32Array of dimension 384.
 */
export async function embed(text, { pooling = 'mean', normalize = true } = {}) {
  if (!text || typeof text !== 'string') throw new Error('text required (string)');
  const pipe = await getEmbeddingPipeline();
  const output = await pipe(text, { pooling, normalize });
  _lastUsed = Date.now();
  return Array.from(output.data);
}

/**
 * Generate embeddings for multiple texts (batch).
 * More efficient than calling embed() multiple times.
 */
export async function embedBatch(texts, { pooling = 'mean', normalize = true } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const pipe = await getEmbeddingPipeline();
  const results = [];
  for (const text of texts) {
    const output = await pipe(text, { pooling, normalize });
    results.push(Array.from(output.data));
  }
  _lastUsed = Date.now();
  return results;
}

/**
 * Compute cosine similarity between two embedding vectors.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find the most similar texts from a corpus given a query.
 * Returns array of { index, similarity } sorted by similarity desc.
 */
export function searchSimilar(queryEmbedding, corpusEmbeddings, limit = 5) {
  const scores = corpusEmbeddings.map((emb, i) => ({
    index: i,
    similarity: cosineSimilarity(queryEmbedding, emb),
  }));
  scores.sort((a, b) => b.similarity - a.similarity);
  return scores.slice(0, limit);
}

export default {
  getEmbeddingPipeline,
  unloadEmbeddingModel,
  isModelLoaded,
  getEmbeddingStatus,
  embed,
  embedBatch,
  cosineSimilarity,
  searchSimilar,
};
