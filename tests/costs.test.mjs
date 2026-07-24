/**
 * Tests for Cost Tracking (getModelCost, budget alerts, pricing table coverage)
 */
import { describe, it, expect } from 'vitest';
import { getModelCost } from '../src/server/routes/costs.mjs';

describe('Cost Tracking — getModelCost', () => {
  it('should calculate cost for known models', () => {
    const cost = getModelCost('gpt-4o', 1000, 500);
    // 1000 tokens * $2.50/1M + 500 tokens * $10.00/1M
    // = 0.0025 + 0.005 = 0.0075
    expect(cost).toBeCloseTo(0.0075, 4);
  });

  it('should calculate cost for claude-3.5-sonnet', () => {
    const cost = getModelCost('claude-3.5-sonnet', 1000000, 500000);
    // 1M * $3/1M + 500K * $15/1M = 3.0 + 7.5 = 10.5
    expect(cost).toBeCloseTo(10.5, 2);
  });

  it('should return 0 for local/ollama models', () => {
    expect(getModelCost('ollama/llama3', 10000, 5000)).toBe(0);
    expect(getModelCost('local-model', 10000, 5000)).toBe(0);
  });

  it('should use fallback pricing for unknown models', () => {
    const cost = getModelCost('unknown-model-xyz', 1000000, 500000);
    // Fallback: 1M * $1/1M + 500K * $3/1M = 1.0 + 1.5 = 2.5
    expect(cost).toBeCloseTo(2.5, 2);
  });

  it('should handle partial model name matches', () => {
    // 'gpt-4o' should match 'gpt-4o-mini' substring
    const cost = getModelCost('gpt-4o-mini', 1000000, 0);
    // 1M * $0.15/1M = 0.15
    expect(cost).toBeCloseTo(0.15, 2);
  });

  it('should handle zero tokens', () => {
    const cost = getModelCost('gpt-4o', 0, 0);
    expect(cost).toBe(0);
  });

  it('should calculate correctly for NVIDIA NIM models', () => {
    const cost = getModelCost('glm-5', 1000000, 1000000);
    // 1M * $0.10/1M + 1M * $0.30/1M = 0.10 + 0.30 = 0.40
    expect(cost).toBeCloseTo(0.40, 2);
  });

  it('should calculate correctly for Groq models', () => {
    const cost = getModelCost('gemma2-9b', 1000000, 500000);
    // 1M * $0.10/1M + 500K * $0.10/1M = 0.10 + 0.05 = 0.15
    expect(cost).toBeCloseTo(0.15, 2);
  });

  it('should match grok-3 correctly (not grok-2)', () => {
    const grok3Cost = getModelCost('grok-3', 1000000, 0);
    // grok-3: $3.00/1M input → 1M = $3.00
    expect(grok3Cost).toBeCloseTo(3.0, 2);

    const grok2Cost = getModelCost('grok-2', 1000000, 0);
    // grok-2: $2.00/1M input → 1M = $2.00
    expect(grok2Cost).toBeCloseTo(2.0, 2);
  });

  it('should handle large token counts', () => {
    const cost = getModelCost('gpt-4o', 100_000_000, 50_000_000);
    // 100M * $2.50/1M + 50M * $10/1M = 250 + 500 = 750
    expect(cost).toBeCloseTo(750, 2);
  });
});
