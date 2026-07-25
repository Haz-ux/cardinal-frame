/**
 * Cardinal Frame — Docker Execution Backend
 *
 * Alternative to local VM sandbox for skill execution. Runs skill
 * handlers inside a Docker container for isolation and resource
 * control. Primarily for offloading heavier skill executions to
 * Docker-capable hosts (e.g., IKARIS).
 *
 * Usage:
 *   import { executeInDocker } from './docker-backend.mjs';
 *   const result = await executeInDocker({ code, input, timeoutMs, image });
 *
 * Falls back gracefully if Docker is not available.
 */

import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const execAsync = promisify(exec);

const DEFAULT_IMAGE = 'node:22-slim';
const DEFAULT_TIMEOUT = 30_000;

// Check if Docker is available on this host
let dockerAvailable = null;

export function isDockerAvailable() {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

/**
 * Execute a skill handler in a Docker container.
 *
 * @param {object} opts
 * @param {string} opts.code — JS handler code (function body or expression)
 * @param {*} opts.input — Input to pass to the handler
 * @param {string} [opts.image] — Docker image to use (default: node:22-slim)
 * @param {number} [opts.timeoutMs] — Timeout in ms (default: 30000)
 * @param {object} [opts.env] — Environment variables to pass (KEY=VALUE)
 * @returns {Promise<{ ok: boolean, output: any, error?: string, durationMs: number }>}
 */
export async function executeInDocker({
  code,
  input,
  image = DEFAULT_IMAGE,
  timeoutMs = DEFAULT_TIMEOUT,
  env = {},
}) {
  if (!isDockerAvailable()) {
    return { ok: false, error: 'Docker is not available on this host', durationMs: 0 };
  }

  const jobId = randomUUID();
  const hostDir = join(tmpdir(), `cf-docker-${jobId}`);
  mkdirSync(hostDir, { recursive: true });

  // Write the skill code + input
  writeFileSync(join(hostDir, 'input.json'), JSON.stringify(input));
  writeFileSync(join(hostDir, 'handler.js'), code);

  // Runner script that loads handler, calls it, writes output to stdout
  const runner = `
const { readFileSync } = require('fs');
const input = JSON.parse(readFileSync('/app/input.json', 'utf8'));
const code = readFileSync('/app/handler.js', 'utf8');
try {
  let handler;
  if (code.includes('module.exports')) {
    handler = eval(code);
  } else if (code.includes('async') || code.includes('function')) {
    handler = eval('(${code})');
  } else {
    handler = eval(code);
  }
  Promise.resolve(typeof handler === 'function' ? handler(input) : handler)
    .then(result => {
      process.stdout.write(JSON.stringify({ ok: true, output: result }));
      process.exit(0);
    })
    .catch(err => {
      process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
      process.exit(1);
    });
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}
`;
  writeFileSync(join(hostDir, 'runner.js'), runner);

  const envFlags = Object.entries(env).map(([k, v]) => `-e ${k}=${v}`).join(' ');
  const containerName = `cf-skill-${jobId.slice(0, 8)}`;

  const dockerCmd = [
    'docker run --rm',
    `--name ${containerName}`,
    `--memory 512m --cpus 1`,
    `--network none`,
    `--pids-limit 64`,
    `--read-only`,
    `--tmpfs /tmp:size=64m`,
    `--stop-timeout ${Math.ceil(timeoutMs / 1000)}`,
    `-v ${hostDir}:/app:ro`,
    envFlags,
    image,
    'node /app/runner.js',
  ].filter(Boolean).join(' ');

  const startTime = Date.now();

  try {
    const { stdout } = await execAsync(dockerCmd, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
    });

    // stdout contains the JSON result
    const result = JSON.parse(stdout.trim() || '{"ok":false,"error":"empty output"}');
    return { ...result, durationMs: Date.now() - startTime };
  } catch (err) {
    const isTimeout = err.killed || err.signal === 'SIGTERM';
    // Try to parse stdout from error (docker may have written before timeout)
    const stdout = err.stdout?.trim();
    if (stdout) {
      try {
        const result = JSON.parse(stdout);
        return { ...result, durationMs: Date.now() - startTime };
      } catch {}
    }
    return {
      ok: false,
      error: isTimeout ? `Docker execution timed out after ${timeoutMs}ms` : (err.stderr || err.message).slice(0, 500),
      durationMs: Date.now() - startTime,
    };
  } finally {
    try { rmSync(hostDir, { recursive: true, force: true }); } catch {}
  }
}

export { executeInDocker as runDockerSkill };
