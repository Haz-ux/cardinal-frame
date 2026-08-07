import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth } from './helpers.mjs';
import {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  computeThresholdTokens,
  shouldCompress,
  pruneToolResults,
  alignBoundaryForward,
  findCompactionBoundary,
  compressConversation,
  emergencyCompress,
  buildSummaryPrompt,
} from '../src/server/compression.mjs';

const longTranscript = () => [
  { role: 'system', content: 'you are an agent' },
  { role: 'user', content: 'task: audit the repo' },
  ...Array.from({ length: 60 }, (_, i) => ({
    role: 'user',
    content: `turn ${i}: some moderately long conversation content about the feature work here`.repeat(3),
  })),
];

describe('token estimation', () => {
  it('estimates chars/4 for blobs', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens(null)).toBe(0);
  });

  it('estimates per-message tokens with tool-call payloads', () => {
    expect(estimateMessageTokens({ role: 'user', content: 'abcd' })).toBe(11); // 1 + 10 overhead
    // 0 content + JSON.stringify({function:{name:'x',arguments:'aaaa'}}) ≈ 44 chars → 11 + 10 overhead
    expect(estimateMessageTokens({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'x', arguments: 'aaaa' } }] })).toBe(21);
  });

  it('sums messages', () => {
    const msgs = [{ role: 'user', content: 'a'.repeat(4000) }, { role: 'user', content: 'b'.repeat(4000) }];
    expect(estimateMessagesTokens(msgs)).toBeGreaterThanOrEqual(2000);
  });
});

describe('trigger math', () => {
  it('threshold = contextLength * percent, floored at 8000', () => {
    expect(computeThresholdTokens(128000, 0.5, 0)).toBe(64000);
    expect(computeThresholdTokens(10000, 0.5, 0)).toBe(8000); // floor
  });

  it('does not let the floor consume the whole window', () => {
    // floor (8000) meets/exceeds a 7000 window -> trigger at 85% of window
    const t = computeThresholdTokens(7000, 0.5, 0);
    expect(t).toBe(Math.floor(7000 * 0.85)); // 5950
  });

  it('subtracts maxTokens reservation', () => {
    expect(computeThresholdTokens(128000, 0.5, 64000)).toBe(32000);
  });

  it('shouldCompress flags when tokens pass the threshold', () => {
    const big = { role: 'user', content: 'x'.repeat(128000 * 4) }; // ~128K tokens
    const s = shouldCompress([big], { contextLength: 128000, thresholdPercent: 0.5 });
    expect(s.compress).toBe(true);
    expect(s.usage_percent).toBeGreaterThan(50);
    expect(s.threshold).toBe(64000);
  });

  it('shouldCompress is false for small conversations', () => {
    const s = shouldCompress([{ role: 'user', content: 'hi' }], { contextLength: 128000 });
    expect(s.compress).toBe(false);
  });
});

describe('pruneToolResults', () => {
  const makeTool = (content, id) => ({ role: 'tool', tool_call_id: id || 't1', content });

  it('prunes big tool results outside the protected tail', () => {
    const big = 'y'.repeat(5000);
    const msgs = [
      { role: 'user', content: 'go' },
      makeTool(big, 't1'),
      { role: 'assistant', content: 'done' },
    ];
    const { messages, pruned } = pruneToolResults(msgs, { protectFirstN: 1, protectLastN: 1, tailTokenBudget: 1000 });
    expect(pruned).toBe(1);
    expect(messages[1].content).toMatch(/^\[tool output pruned: was 5000 chars\]/);
    expect(messages[1].content).toContain('…');
  });

  it('keeps small tool results untouched', () => {
    const msgs = [{ role: 'user', content: 'go' }, makeTool('ok', 't1')];
    const { messages, pruned } = pruneToolResults(msgs, {});
    expect(pruned).toBe(0);
    expect(messages[1].content).toBe('ok');
  });

  it('dedupes identical tool results keeping the newest copy', () => {
    const msgs = [
      { role: 'user', content: 'go' },
      makeTool('SAME'.repeat(100), 't1'),
      { role: 'assistant', content: 'a', tool_calls: [{ id: 't1', function: { name: 'x', arguments: '' } }] },
      makeTool('SAME'.repeat(100), 't2'),
    ];
    const { messages, deduped } = pruneToolResults(msgs, {});
    expect(deduped).toBe(1);
    expect(messages[1].content).toBe('[deduped — identical to a later tool result]');
    expect(messages[3].content).toContain('SAME');
  });

  it('does not prune inside the protected tail', () => {
    const big = 'y'.repeat(5000);
    const msgs = [
      { role: 'user', content: 'go' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
      makeTool(big, 't1'),
    ];
    // Whole conversation is protected (small) -> no pruning.
    const { messages, pruned } = pruneToolResults(msgs, { protectFirstN: 1, protectLastN: 4, tailTokenBudget: 100000 });
    expect(pruned).toBe(0);
    expect(messages[4].content).toBe(big);
  });
});

describe('boundary alignment', () => {
  it('pushes a boundary past a stray tool result', () => {
    const msgs = [{ role: 'user', content: 'a' }, { role: 'tool', tool_call_id: 't1', content: 'r' }];
    expect(alignBoundaryForward(msgs, 1)).toBe(2);
  });

  it('keeps an assistant tool_call group intact', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'x', arguments: '' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'r' },
      { role: 'user', content: 'b' },
    ];
    // Cutting at index 2 would strand the tool result; must move to 3.
    expect(alignBoundaryForward(msgs, 2)).toBe(3);
  });
});

describe('findCompactionBoundary', () => {
  it('returns protectFirstN when the conversation already fits', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    // 10 <= 3 + 20, so the whole thing is protected; boundary = head end.
    expect(findCompactionBoundary(msgs, { protectFirstN: 3, protectLastN: 20 })).toBe(3);
  });

  it('protects a token-budgeted tail with at least protectLastN messages', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: `message number ${i}`.repeat(5) }));
    const boundary = findCompactionBoundary(msgs, { protectFirstN: 3, protectLastN: 20, tailTokenBudget: 500 });
    expect(boundary).toBeGreaterThanOrEqual(20);
    expect(boundary).toBeLessThan(msgs.length);
  });

  it('never cuts into the protected head', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: `m${i}`.repeat(100) }));
    const boundary = findCompactionBoundary(msgs, { protectFirstN: 3, protectLastN: 20, tailTokenBudget: 10 });
    expect(boundary).toBeGreaterThanOrEqual(3);
  });
});

describe('compressConversation', () => {
  it('falls back to a cheap headtail middle when no llmCall is provided', async () => {
    const r = await compressConversation(longTranscript(), { tailTokenBudget: 2000 });
    expect(r.ok).toBe(true);
    expect(r.compressed_msgs).toBeLessThan(r.original_msgs);
    const summary = r.messages.find(m => m.compressed_summary);
    expect(summary).toBeTruthy();
    expect(summary.content.length).toBeGreaterThan(0);
    // head preserved
    expect(r.messages[0].content).toBe('you are an agent');
    expect(r.messages[1].content).toBe('task: audit the repo');
    // tail preserved (last turn present)
    expect(r.messages[r.messages.length - 1].content).toContain('turn 59');
  });

  it('uses the structured template + iterative summary when llmCall is provided', async () => {
    const seen = [];
    const llmCall = async (messages) => {
      seen.push(messages);
      return { content: 'OBJECTIVE — audit.\nPROGRESS — none yet.', model: 'test-model', promptTokens: 10, completionTokens: 5 };
    };
    const r = await compressConversation(longTranscript(), { tailTokenBudget: 2000, previousSummary: 'OBJECTIVE — old goal.' }, llmCall);
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe('summarize');
    expect(r.summary).toContain('OBJECTIVE');
    const userPrompt = seen[0].find(m => m.role === 'user').content;
    expect(userPrompt).toContain('EXISTING SUMMARY');
    expect(userPrompt).toContain('OBJECTIVE — old goal.');
    expect(userPrompt).toContain('=== CONVERSATION HISTORY ===');
  });

  it('returns everything untouched when the conversation already fits', async () => {
    const small = [{ role: 'user', content: 'hi' }, { role: 'user', content: 'there' }];
    const r = await compressConversation(small, {});
    expect(r.strategy).toBe('none');
    expect(r.messages.length).toBe(2);
    expect(r.compressed_msgs).toBe(2);
  });
});

describe('emergencyCompress', () => {
  it('is more aggressive than normal compaction', async () => {
    const t = longTranscript();
    const normal = await compressConversation(t, { tailTokenBudget: 1000 });
    const emerg = await emergencyCompress(t, { tailTokenBudget: 1000 });
    expect(emerg.compressed_msgs).toBeLessThanOrEqual(normal.compressed_msgs);
    // emergency also trims the protected head/tail harder
    expect(emerg.messages[0].content).toBe('you are an agent'); // head kept (protectFirstN>=1)
  });
});

describe('buildSummaryPrompt', () => {
  it('includes reference-only framing and sections', () => {
    const p = buildSummaryPrompt('middle text', { summarizeMaxChars: 500, previousSummary: null });
    expect(p).toMatch(/REFERENCE ONLY/);
    expect(p).toMatch(/latest user message is the single source of truth/);
    expect(p).toMatch(/OBJECTIVE/);
    expect(p).toMatch(/PROGRESS/);
    expect(p).toMatch(/DECISIONS/);
    expect(p).toMatch(/KEY DETAILS/);
    expect(p).toMatch(/PENDING/);
    expect(p).toMatch(/=== CONVERSATION HISTORY ===/);
  });
});

describe('compression HTTP routes', () => {
  let app;
  beforeAll(async () => {
    ({ app } = await getTestServer());
  });
  afterAll(() => cleanupTestServer());

  it('GET /api/compression/strategies lists conversation modes', async () => {
    const res = await request(app).get('/api/compression/strategies').set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.strategies).toContain('summarize');
    expect(res.body.conversation).toContain('compress');
    expect(res.body.defaults.tailTokenBudget).toBe(20000);
  });

  it('POST /api/compression/conversation compacts and marks the summary', async () => {
    const messages = [
      { role: 'user', content: 'task' },
      ...Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `turn ${i} with some content`.repeat(3) })),
    ];
    const res = await request(app).post('/api/compression/conversation').set(adminAuth()).send({ messages, tailTokenBudget: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.compressed_msgs).toBeLessThan(res.body.original_msgs);
    expect(res.body.messages.some(m => m.compressed_summary)).toBe(true);
  });

  it('POST /api/compression/conversation/status reports usage', async () => {
    const small = [{ role: 'user', content: 'hi' }];
    const res = await request(app).post('/api/compression/conversation/status').set(adminAuth()).send({ messages: small, contextLength: 128000 });
    expect(res.status).toBe(200);
    expect(res.body.compress).toBe(false);
    expect(typeof res.body.usage_percent).toBe('number');
  });

  it('POST /api/compression/conversation requires admin', async () => {
    const res = await request(app).post('/api/compression/conversation').send({ messages: [] });
    expect(res.status).toBe(401);
  });
});
