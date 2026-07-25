import { describe, it, expect } from 'vitest';
import { isDockerAvailable, executeInDocker } from '../src/server/routes/docker-backend.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dockerBackendPath = join(__dirname, '..', 'src', 'server', 'routes', 'docker-backend.mjs');
const dockerBackendSrc = readFileSync(dockerBackendPath, 'utf8');

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

describe('Docker Backend — Security Flags (Task 5 audit)', () => {
  it('should include --pids-limit in the docker run command (fork-bomb protection)', () => {
    expect(dockerBackendSrc).toContain('--pids-limit 64');
  });

  it('should include --read-only in the docker run command (filesystem write protection)', () => {
    expect(dockerBackendSrc).toContain('--read-only');
  });

  it('should include --tmpfs /tmp for writable temp inside read-only container', () => {
    expect(dockerBackendSrc).toContain('--tmpfs /tmp:size=64m');
  });

  it('should still have the original security flags (--memory, --cpus, --network none)', () => {
    expect(dockerBackendSrc).toContain('--memory 512m');
    expect(dockerBackendSrc).toContain('--cpus 1');
    expect(dockerBackendSrc).toContain('--network none');
  });

  it('should have --pids-limit set to a reasonable value (<=128)', () => {
    const match = dockerBackendSrc.match(/--pids-limit\s+(\d+)/);
    expect(match).not.toBeNull();
    const limit = parseInt(match[1]);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(128);
  });

  it('should have --tmpfs with a size limit', () => {
    const match = dockerBackendSrc.match(/--tmpfs\s+\/tmp:size=(\d+)m/);
    expect(match).not.toBeNull();
    const size = parseInt(match[1]);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(128);
  });
});
