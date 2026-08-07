/**
 * Cardinal Frame — Context Compression Engine
 *
 * Framework module (not a plugin) that compresses long context before it
 * is fed to an LLM or stored. Exposes a pure `compressContext(text, opts)`
 * function plus strategy-specific helpers. The HTTP route + Aimi tool wrap
 * this module; chains and the agent loop may call it directly.
 *
 * Blob strategies (`opts.strategy`):
 *   - 'truncate'   : keep first N chars + last M chars, drop the middle
 *   - 'headtail'    : keep first K lines + last K lines
 *   - 'dedupe'      : collapse repeated lines / runs of whitespace
 *   - 'summarize'   : LLM summarization (requires `llmCall` injected)
 *   - 'auto'        : pick by size — small=invariant, medium=dedupe, large=summarize
 *
 * Conversation compression (chat transcripts / tool loops):
 *   - `compressConversation(messages, opts, llmCall)` — head/middle/tail
 *     compaction: no-LLM tool-result pruning, token-budget tail protection,
 *     structured LLM summary of the middle, boundary-safe cuts.
 *   - `pruneToolResults(messages, opts)`            — cheap pre-pass
 *   - `findCompactionBoundary(messages, opts)`      — token-budget cut point
 *   - `shouldCompress(...)` / `computeThresholdTokens` — trigger detection
 *   - `emergencyCompress(...)`                      — aggressive variant for
 *     provider `context_overflow` errors
 *
 * All blob strategies return the same shape:
 *   { ok, strategy, original_chars, compressed, compressed_chars,
 *     ratio, tokens: {...} | null, duration_ms, sections }
 */

// ─── Helpers ─────────────────────────────────────────────────
const DEFAULT_OPTS = {
  strategy: 'auto',
  maxChars: 12000,        // above this, auto switches to summarize
  keepHead: 4000,         // truncate: chars to keep from the start
  keepTail: 2000,         // truncate: chars to keep from the end
  headTailLines: 50,      // headtail: lines per side
  summarizeModel: null,   // optional model override for llmCall
  summarizeMaxChars: 2000, // cap on produced summary length
  // Conversation-compaction options
  protectFirstN: 3,          // messages pinned at the head (system prompt + first exchange)
  protectLastN: 20,          // minimum messages pinned at the tail
  tailTokenBudget: 20000,    // ~tokens kept as recent tail
  minTailUserMessages: 1,    // real user messages guaranteed in the tail
  pruneMinChars: 200,        // tool results larger than this are pruned pre-pass
  pruneResultHead: 80,       // chars of the tool result kept in the 1-line stub
  contextLength: 128000,     // model context window used for trigger math
  thresholdPercent: 0.5,     // compress when prompt tokens reach this % of context
  maxTokens: 0,              // output reservation subtracted from the window
  previousSummary: null,     // prior compaction summary (iterative update)
};

const SUMMARY_CEILING = 8000;   // max summary tokens (blob path)
const SUMMARY_RATIO = 0.2;      // summary budget = 20% of compressed content
const MIN_SUMMARY_CHARS = 200;  // floor for the summary size (chars)

function mergeOpts(opts) {
  return { ...DEFAULT_OPTS, ...(opts || {}) };
}

function stats(original, compressed, strategy, extra = {}) {
  return {
    ok: true,
    strategy,
    original_chars: original.length,
    compressed,
    compressed_chars: compressed.length,
    ratio: original.length ? +(compressed.length / original.length).toFixed(4) : 0,
    tokens: extra.tokens || null,
    duration_ms: extra.duration_ms || 0,
    sections: extra.sections || null,
  };
}

// ─── Token estimation ────────────────────────────────────────
// Rough but deterministic: ~4 chars per token plus per-message overhead.

/** Estimate tokens for a text blob (chars / 4). */
export function estimateTokens(text) {
  if (typeof text !== 'string') text = text == null ? '' : String(text);
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for a single chat message including tool-call payloads. */
export function estimateMessageTokens(msg) {
  if (!msg) return 0;
  let t = estimateTokens(msg.content || '');
  const tc = msg.tool_calls;
  if (Array.isArray(tc)) {
    for (const c of tc) t += estimateTokens(JSON.stringify(c));
  }
  return t + 10; // role / key overhead
}

/** Estimate tokens for a whole message list. */
export function estimateMessagesTokens(messages) {
  return (messages || []).reduce((s, m) => s + estimateMessageTokens(m), 0);
}

// ─── Compression trigger math ────────────────────────────────

/**
 * Token threshold at which compaction should fire. Base value is
 * `(contextLength - maxTokens) * thresholdPercent`, floored at a minimum so
 * tiny-context models don't compact too early. If the floor would meet or
 * exceed the usable window, trigger at 85% of the window instead so small
 * models still compact before the provider rejects the request.
 */
export function computeThresholdTokens(contextLength = 128000, thresholdPercent = 0.5, maxTokens = 0) {
  const effective = Math.max(1, contextLength - (maxTokens || 0));
  const pctValue = Math.floor(effective * thresholdPercent);
  const floor = Math.max(pctValue, 8000);
  if (floor >= effective) return Math.max(1, Math.min(Math.floor(effective * 0.85), effective - 1));
  return floor;
}

/**
 * Decide whether a conversation needs compaction.
 * @returns { { compress:boolean, tokens:number, threshold:number, usage_percent:number } }
 */
export function shouldCompress(messages, opts = {}) {
  const o = mergeOpts(opts);
  const threshold = computeThresholdTokens(o.contextLength, o.thresholdPercent, o.maxTokens);
  const tokens = estimateMessagesTokens(messages || []);
  return {
    compress: tokens >= threshold,
    tokens,
    threshold,
    usage_percent: o.contextLength ? +(tokens / o.contextLength * 100).toFixed(1) : 0,
  };
}

// ─── Tool-result pruning (no-LLM pre-pass) ──────────────────

/**
 * Cheap pre-pass that shrinks old tool outputs before any LLM work:
 *  - outside the protected tail, tool results larger than `pruneMinChars`
 *    become a one-line stub (first `pruneResultHead` chars kept)
 *  - identical tool results are deduped — the newest keeps its full copy,
 *    older ones become a back-reference
 *  - large tool_call argument blobs in assistant messages are truncated
 *
 * @returns { { messages:Array, pruned:number, deduped:number, truncated:number } }
 */
export function pruneToolResults(messages, opts = {}) {
  const o = mergeOpts(opts);
  const result = (messages || []).map(m => ({ ...m }));
  if (!result.length) return { messages: result, pruned: 0, deduped: 0, truncated: 0 };

  const tailStart = findCompactionBoundary(result, o);
  let pruned = 0;
  let deduped = 0;
  let truncated = 0;

  // Pass 1 — dedupe identical tool results (keep the newest full copy).
  const seen = new Map(); // contentHash -> index
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role !== 'tool') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content || content === '[deduped]') continue;
    const hash = content.length + ':' + content.slice(0, 120);
    if (seen.has(hash)) {
      const first = seen.get(hash);
      result[i] = { ...msg, content: `[deduped — identical to a later tool result]` };
      deduped++;
    } else {
      seen.set(hash, i);
    }
  }

  // Pass 2 — shrink big tool results outside the protected tail.
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== 'tool' || i >= tailStart) continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length <= o.pruneMinChars) continue;
    const stub = content.replace(/\s+/g, ' ').slice(0, o.pruneResultHead);
    result[i] = { ...msg, content: `[tool output pruned: was ${content.length} chars] ${stub}…` };
    pruned++;
  }

  // Pass 3 — truncate large tool_call args in assistant messages outside the tail.
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== 'assistant' || i >= tailStart) continue;
    const tc = msg.tool_calls;
    if (!Array.isArray(tc) || !tc.length) continue;
    let changed = false;
    const next = tc.map(c => {
      const args = typeof c?.function?.arguments === 'string' ? c.function.arguments : '';
      if (args.length > o.pruneMinChars) {
        changed = true;
        return { ...c, function: { ...c.function, arguments: args.slice(0, 300) + '…[truncated]' } };
      }
      return c;
    });
    if (changed) {
      result[i] = { ...msg, tool_calls: next };
      truncated++;
    }
  }

  return { messages: result, pruned, deduped, truncated };
}

// ─── Boundary alignment ──────────────────────────────────────

/**
 * Make sure a compaction boundary never splits a tool_call / tool_result
 * group. Walks the boundary forward so the protected tail starts at a
 * non-tool message, keeping any assistant tool_call group complete.
 */
export function alignBoundaryForward(messages, boundary) {
  let b = boundary;
  // Don't cut directly before a tool result — push it into the tail group.
  while (b < messages.length && messages[b]?.role === 'tool') b++;
  // If the message just before the cut made tool calls and its results were
  // stranded on the far side, advance past the whole group.
  if (b > 0 && Array.isArray(messages[b - 1]?.tool_calls) && messages[b - 1].tool_calls.length) {
    let g = b;
    while (g < messages.length && messages[g]?.role === 'tool') g++;
    if (g > b) b = g;
  }
  return b;
}

// ─── Compaction boundary (token-budget tail protection) ─────

/**
 * Find the index where the middle section ends and the protected tail
 * begins. Walks backward from the end accumulating estimated tokens, keeping
 * at least `protectLastN` messages and `minTailUserMessages` user messages,
 * and stops when the accumulated tail would exceed `tailTokenBudget`.
 *
 * @returns {number} index — messages [index..end) are the protected tail
 */
export function findCompactionBoundary(messages, opts = {}) {
  const o = mergeOpts(opts);
  const n = messages.length;
  // Everything already fits inside the protected budget — the entire
  // conversation from the head onward is the protected tail, nothing to cut.
  if (n <= o.protectFirstN + o.protectLastN) return o.protectFirstN;
  const minProtect = Math.min(o.protectLastN, n - o.protectFirstN);
  let boundary = n;
  let accumulated = 0;
  let userMsgs = 0;
  for (let i = n - 1; i >= o.protectFirstN; i--) {
    const t = estimateMessageTokens(messages[i]);
    const isUser = messages[i]?.role === 'user';
    const tailCount = n - i;
    if (accumulated + t > o.tailTokenBudget && tailCount >= minProtect && (userMsgs + (isUser ? 1 : 0)) >= o.minTailUserMessages) {
      boundary = i + 1;
      break;
    }
    accumulated += t;
    if (isUser) userMsgs++;
    boundary = i;
  }
  return Math.max(alignBoundaryForward(messages, boundary), o.protectFirstN);
}

// ─── Serialization + structured summary ─────────────────────

/** Serialize conversation turns into labeled text for the summarizer. */
export function serializeTurns(messages, opts = {}) {
  const maxChars = opts.serializeMaxChars || 3000;
  const parts = [];
  for (const msg of messages || []) {
    const role = msg.role || 'unknown';
    let content = typeof msg.content === 'string' ? msg.content : (msg.content == null ? '' : JSON.stringify(msg.content));
    if (content.length > maxChars) content = content.slice(0, 2000) + '\n…[truncated]…\n' + content.slice(-800);
    if (role === 'tool') {
      parts.push(`[TOOL RESULT]: ${content}`);
      continue;
    }
    if (role === 'assistant') {
      const tc = msg.tool_calls;
      let line = `[ASSISTANT]: ${content}`;
      if (Array.isArray(tc) && tc.length) {
        const calls = tc.map(c => `${c.function?.name || 'tool'}(${String(c.function?.arguments || '').slice(0, 500)})`).join(', ');
        line += `\n  tool_calls: ${calls}`;
      }
      parts.push(line);
      continue;
    }
    parts.push(`[${role.toUpperCase()}]: ${content}`);
  }
  return parts.join('\n');
}

/** Structured summary template — reference-only framing, section-driven. */
export function buildSummaryPrompt(middleText, opts = {}) {
  const cap = opts.summarizeMaxChars || 2000;
  const previous = opts.previousSummary;
  const lines = [
    'You are a context-compression engine. Compress the provided conversation history into a dense, faithful summary that the agent can read as REFERENCE ONLY — it is historical background, NOT active instructions.',
    'The latest user message is the single source of truth for current intent.',
    'Preserve every concrete fact: file paths, identifiers, commands, numbers, decisions, and task progress. Do NOT invent new information. Do NOT editorialize. Prefer tight bullets.',
    'Use this structure:',
    '  • OBJECTIVE — the goal being worked toward',
    '  • PROGRESS — concrete work already done (files, commands, results)',
    '  • DECISIONS — choices made and why (brief)',
    '  • KEY DETAILS — identifiers, paths, params, code fragments to remember verbatim',
    '  • PENDING — next steps and open questions',
    `Keep the whole summary to at most ~${cap} characters.`,
  ];
  if (previous) {
    lines.unshift(
      'There is an EXISTING summary from a previous compaction. PRESERVE all information in it, ADD any new progress since then, and mark items that are now DONE as done — do not discard prior details.',
      '',
      `=== EXISTING SUMMARY ===\n${typeof previous === 'string' ? previous : JSON.stringify(previous)}`,
      '=== END EXISTING SUMMARY ===',
      '',
    );
  }
  lines.push(
    '',
    '=== CONVERSATION HISTORY ===',
    middleText,
    '=== END CONVERSATION HISTORY ===',
  );
  return lines.join('\n');
}

// ─── Pure strategies ─────────────────────────────────────────

/** Truncate: keep first keepHead + last keepTail, with an elision marker. */
export function truncateStrategy(text, opts) {
  const { keepHead, keepTail } = opts;
  if (text.length <= keepHead + keepTail) {
    return stats(text, text, 'truncate', { sections: { head: text.length, tail: 0, dropped: 0 } });
  }
  const head = text.slice(0, keepHead);
  const tail = text.slice(-keepTail);
  const dropped = text.length - keepHead - keepTail;
  const out = `${head}\n\n…[compressed: ${dropped} chars omitted]…\n\n${tail}`;
  return stats(text, out, 'truncate', {
    sections: { head: keepHead, tail: keepTail, dropped },
  });
}

/** head/tail line keep: keep first K and last K lines. */
export function headtailStrategy(text, opts) {
  const k = opts.headTailLines;
  const lines = text.split('\n');
  if (lines.length <= k * 2) {
    return stats(text, text, 'headtail', { sections: { head: lines.length, tail: 0, dropped: 0 } });
  }
  const head = lines.slice(0, k);
  const tail = lines.slice(-k);
  const dropped = lines.length - k * 2;
  const out = head.join('\n') + `\n\n…[compressed: ${dropped} lines omitted]…\n\n` + tail.join('\n');
  return stats(text, out, 'headtail', {
    sections: { head: k, tail: k, dropped },
  });
}

/** Dedupe: collapse blank runs, drop identical consecutive lines. */
export function dedupeStrategy(text, opts) {
  const lines = text.split('\n');
  const out = [];
  let lastNonBlank = null;
  let blankRun = 0;
  let droppedDuplicates = 0;
  let droppedBlanks = 0;
  for (const line of lines) {
    const isBlank = /^\s*$/.test(line);
    if (isBlank) {
      blankRun++;
      if (blankRun > 1) { droppedBlanks++; continue; }
      out.push(line);
      continue;
    }
    blankRun = 0;
    if (lastNonBlank === line) { droppedDuplicates++; continue; }
    lastNonBlank = line;
    out.push(line);
  }
  const compressed = out.join('\n');
  return stats(text, compressed, 'dedupe', {
    sections: { dropped_duplicates: droppedDuplicates, dropped_blanks: droppedBlanks },
  });
}

// ─── LLM-backed strategy ────────────────────────────────────

/**
 * summarize: ask the injected LLM to compress the text into a tight summary.
 * Uses the structured template and supports iterative updates via
 * `opts.previousSummary`. Requires `llmCall(messages, model?)` returning
 * { content, promptTokens, completionTokens }.
 */
export async function summarizeStrategy(text, opts, llmCall) {
  const start = Date.now();
  const cap = opts.summarizeMaxChars;
  let user;
  if (opts.previousSummary) {
    user = buildSummaryPrompt(text, { ...opts, summarizeMaxChars: cap });
  } else {
    user = `Compress the following context to at most ~${cap} characters. Preserve all key facts and any code/identifiers verbatim. Do not add new information.\n\n=== BEGIN CONTEXT ===\n${text}\n=== END CONTEXT ===`;
  }
  const messages = [{ role: 'system', content: 'You are a context-compression engine.' }, { role: 'user', content: user }];
  const res = await llmCall(messages, opts.summarizeModel || undefined);
  const compressed = (res?.content || '').slice(0, cap + 500);
  return stats(text, compressed, 'summarize', {
    tokens: { prompt: res?.promptTokens || null, completion: res?.completionTokens || null },
    duration_ms: Date.now() - start,
  });
}

// ─── Auto selection ──────────────────────────────────────────

function pickAutoStrategy(text, opts) {
  const n = text.length;
  if (n <= opts.maxChars / 2) return 'dedupe';     // small — cheap dedupe is enough
  if (n <= opts.maxChars) return 'truncate';       // medium — truncate keeps edges
  return 'summarize';                              // large — needs the LLM
}

/**
 * Main entry — compress a context blob.
 *
 * @param {string} text          - the context to compress
 * @param {object} [opts]       - see DEFAULT_OPTS
 * @param {function} [llmCall]  - required only for strategy: 'summarize' / 'auto' (large)
 * @returns {Promise<object>}   - { ok, strategy, original_chars, compressed, compressed_chars, ratio, tokens, duration_ms, sections }
 */
export async function compressContext(text, opts = {}, llmCall = null) {
  const o = mergeOpts(opts);
  const input = typeof text === 'string' ? text : (text == null ? '' : String(text));
  if (!input) {
    return stats('', '', o.strategy || 'auto', {});
  }

  let strategy = o.strategy === 'auto' ? pickAutoStrategy(input, o) : o.strategy;

  switch (strategy) {
    case 'truncate':
      return truncateStrategy(input, o);
    case 'headtail':
      return headtailStrategy(input, o);
    case 'dedupe':
      return dedupeStrategy(input, o);
    case 'summarize': {
      if (typeof llmCall !== 'function') {
        // No LLM available — graceful fallback to truncate.
        const r = truncateStrategy(input, o);
        return { ...r, strategy: 'summarize', fallback: 'truncate (no llmCall provided)' };
      }
      try {
        return await summarizeStrategy(input, o, llmCall);
      } catch (err) {
        const r = truncateStrategy(input, o);
        return { ...r, strategy: 'summarize', fallback: `truncate (llm error: ${err.message})` };
      }
    }
    default:
      throw new Error(`Unknown compression strategy: ${strategy}`);
  }
}

// ─── Conversation compaction (head / middle / tail) ─────────

/**
 * Compress a chat transcript using the head/middle/tail compaction:
 *   1. prune old tool results (no-LLM pre-pass)
 *   2. protect head (first `protectFirstN` messages)
 *   3. protect tail by token budget (most recent ~`tailTokenBudget` tokens)
 *   4. summarize the middle with the structured template
 *   5. assemble head + summary + tail
 *
 * If `llmCall` is not provided, the middle is collapsed with a cheap
 * head/tail-line fallback so the API never hard-fails.
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} opts
 * @param {function} llmCall
 * @returns {Promise<object>} { ok, strategy, messages, original_msgs, compressed_msgs, pruned, summary, tokens, duration_ms }
 */
export async function compressConversation(messages, opts = {}, llmCall = null) {
  const o = mergeOpts(opts);
  const msgs = (messages || []).map(m => ({ ...m }));
  const start = Date.now();
  if (!msgs.length) {
    return { ok: true, strategy: 'none', messages: [], original_msgs: 0, compressed_msgs: 0, ratio: 1, summary: '', duration_ms: 0 };
  }

  // Phase 1 — no-LLM pruning.
  const { messages: pruned, pruned: prunedCount } = pruneToolResults(msgs, o);

  // Phase 2 — partition.
  const boundary = findCompactionBoundary(pruned, o);
  const head = pruned.slice(0, o.protectFirstN);
  const middle = pruned.slice(o.protectFirstN, boundary);
  const tail = pruned.slice(boundary);

  // Nothing to compact.
  if (!middle.length) {
    return {
      ok: true,
      strategy: 'none',
      messages: pruned,
      original_msgs: pruned.length,
      compressed_msgs: pruned.length,
      ratio: 1,
      pruned: prunedCount,
      summary: '',
      duration_ms: Date.now() - start,
    };
  }

  // Phase 3 — summarize the middle.
  const middleText = serializeTurns(middle, o);
  let summaryText;
  let summaryMeta = { model: null, tokens: null, fallback: null };
  if (typeof llmCall === 'function') {
    try {
      const sys = 'You are a context-compression engine that produces dense structured summaries (see the user instructions).';
      const res = await llmCall([{ role: 'system', content: sys }, { role: 'user', content: buildSummaryPrompt(middleText, o) }], o.summarizeModel || undefined);
      summaryText = (res?.content || '').trim();
      summaryMeta = { model: res?.model || null, tokens: { prompt: res?.promptTokens || null, completion: res?.completionTokens || null }, fallback: null };
    } catch (err) {
      const fb = headtailStrategy(middleText, { ...o, headTailLines: 20 });
      summaryText = fb.compressed;
      summaryMeta = { model: null, tokens: null, fallback: `headtail (llm error: ${err.message})` };
    }
  } else {
    const fb = headtailStrategy(middleText, { ...o, headTailLines: 20 });
    summaryText = fb.compressed;
    summaryMeta = { model: null, tokens: null, fallback: 'headtail (no llmCall provided)' };
  }

  const summaryMsg = { role: 'system', content: summaryText, compressed_summary: true };
  const compressed = [...head, summaryMsg, ...tail];

  return {
    ok: true,
    strategy: 'summarize',
    messages: compressed,
    original_msgs: pruned.length,
    compressed_msgs: compressed.length,
    ratio: pruned.length ? +(compressed.length / pruned.length).toFixed(4) : 1,
    pruned: prunedCount,
    summary: summaryText,
    summary_model: summaryMeta.model,
    tokens: summaryMeta.tokens,
    fallback: summaryMeta.fallback,
    boundary,
    duration_ms: Date.now() - start,
  };
}

/**
 * Aggressive compaction for provider `context_overflow` errors — shrinks the
 * protected tail and head so more can be cut immediately.
 */
export async function emergencyCompress(messages, opts = {}, llmCall = null) {
  return compressConversation(messages, {
    protectFirstN: 1,
    protectLastN: 4,
    tailTokenBudget: 5000,
    minTailUserMessages: 1,
    strategy: 'summarize',
    ...opts, // explicit caller opts win over the aggressive defaults
  }, llmCall);
}

// ─── Batch helper ────────────────────────────────────────────

/**
 * Compress a list of messages (chat history) into a single string.
 * Each message becomes `role: content` lines, then the joined blob is
 * compressed with the chosen strategy. Useful for fitting long transcripts
 * into a model's context window before a follow-up turn.
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} opts
 * @param {function} llmCall
 */
export async function compressMessages(messages, opts = {}, llmCall = null) {
  const blob = (messages || [])
    .map(m => `${m.role || 'user'}: ${m.content || ''}`)
    .join('\n\n---\n\n');
  return compressContext(blob, opts, llmCall);
}
