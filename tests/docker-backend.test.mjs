import { describe, it, expect } from 'vitest';
import { isDockerAvailable, executeInDocker, buildDockerArgs } from '../src/server/routes/docker-backend.mjs';
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

describe('Docker Backend — argv execution (L2 audit)', () => {
  it('invokes docker via spawn with shell:false — no shell string is built', () => {
    expect(dockerBackendSrc).toMatch(/spawn\(\s*['"]docker['"]/);
    expect(dockerBackendSrc).toContain('shell: false');
    expect(dockerBackendSrc).not.toContain('execAsync');
    expect(dockerBackendSrc).not.toMatch(/`-e \$/);
  });

  it('buildDockerArgs keeps env values as single inert argv elements', () => {
    const args = buildDockerArgs({
      image: 'node:22-slim',
      timeoutMs: 30000,
      env: { EVIL: '$(touch /tmp/pwned)', SEMI: 'a;b', BT: '`id`' },
      hostDir: '/tmp/cf-docker-x',
      containerName: 'cf-skill-1',
    });
    // Every element is a plain string (no shell joining).
    expect(args.every(a => typeof a === 'string')).toBe(true);
    // The hostile value stays ONE argv element after its -e flag —
    // with shell:false no shell ever interprets the $(), ; or backticks.
    const pairs = { EVIL: '$(touch /tmp/pwned)', SEMI: 'a;b', BT: '`id`' };
    for (const [k, v] of Object.entries(pairs)) {
      const idx = args.indexOf(`${k}=${v}`);
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx - 1]).toBe('-e');
    }
    // Image is an argv element too, not interpolated into a command line.
    expect(args).toContain('node:22-slim');
  });

  it('buildDockerArgs keeps the container hardening flags', () => {
    const args = buildDockerArgs({
      image: 'node:22-slim', timeoutMs: 30000, env: {},
      hostDir: '/tmp/x', containerName: 'c',
    });
    for (const flag of ['--network', 'none', '--read-only', '--pids-limit', '64',
      '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:size=64m']) {
      expect(args).toContain(flag);
    }
    // --stop-timeout derives from timeoutMs (30s -> 30).
    const stIdx = args.indexOf('--stop-timeout');
    expect(args[stIdx + 1]).toBe('30');
  });

  it('still has the original security flags in source (--pids-limit, --read-only, --tmpfs, --memory, --cpus, --network none)', () => {
    for (const flag of ["'--pids-limit'", "'64'", "'--read-only'",
      "'--tmpfs'", "'/tmp:size=64m'", "'--memory'", "'512m'",
      "'--cpus'", "'1'", "'--network'", "'none'"]) {
      expect(dockerBackendSrc).toContain(flag);
    }
  });
});
