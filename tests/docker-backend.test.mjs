import { describe, it, expect } from 'vitest';
import { isDockerAvailable, executeInDocker } from '../src/server/routes/docker-backend.mjs';

describe('Docker Execution Backend', () => {
  it('isDockerAvailable should return a boolean (whether Docker is present or not)', () => {
    const result = isDockerAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('should return graceful error when Docker is not available', async () => {
    // This test passes regardless of whether Docker is installed.
    // If Docker is available, the actual execution is skipped (no image to pull).
    // If Docker is not available, the graceful fallback is tested.
    const result = await executeInDocker({
      code: 'function (input) { return { echo: input }; }',
      input: { test: true },
      timeoutMs: 5000,
    });

    // If Docker is not available, we get a graceful error
    if (!isDockerAvailable()) {
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not available');
      expect(result.durationMs).toBe(0);
      return;
    }

    // If Docker IS available, the execution should succeed
    // (This won't run in CI since Docker isn't installed there)
    expect(result.ok).toBe(true);
    expect(result.output).toBeDefined();
  });
});
