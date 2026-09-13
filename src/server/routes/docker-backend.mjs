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

import { execSync, spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

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
 * Build the `docker run` argv for a skill execution. Exported for tests.
 *
 * L2: the command is an argv ARRAY — never a shell string. With
 * shell:false every element (env values, image name, volume path) is
 * passed to docker as inert data, so a value like `$(touch /tmp/pwned)`
 * cannot be interpreted by any shell. Container hardening is unchanged:
 * --network none, --read-only, --pids-limit, mem/cpu caps.
 */
export function buildDockerArgs({ image, timeoutMs, env, hostDir, containerName }) {
  const stopTimeout = Math.max(1, Math.ceil(
    (Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT) / 1000));
  const args = [
    'run', '--rm',
    '--name', containerName,
    '--memory', '512m',
    '--cpus', '1',
    '--network', 'none',
    '--pids-limit', '64',
    '--read-only',
    '--tmpfs', '/tmp:size=64m',
    '--stop-timeout', String(stopTimeout),
    '-v', `${hostDir}:/app:ro`,
  ];
  // -e k=v as two argv elements: the value is data, never shell-parsed.
  for (const [k, v] of Object.entries(env || {})) {
    args.push('-e', `${k}=${v}`);
  }
  args.push(image, 'node', '/app/runner.js');
  return args;
}

/**
 * Run docker with shell:false, capturing stdout/stderr. Resolves with
 * stdout on exit 0; rejects with an Error carrying .stdout (for the
 * best-effort result parse on timeout) and .timedOut (true when the
 * timeout killed the process).
 */
function spawnDocker(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, timeout: timeoutMs });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      const err = new Error(`Docker spawn failed: ${e.message}`);
      err.stdout = stdout;
      err.timedOut = false;
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(stdout);
      const timedOut = signal === 'SIGTERM' || signal === 'SIGKILL';
      const err = new Error((stderr || `docker exited with code ${code}`).slice(0, 500));
      err.stdout = stdout;
      err.timedOut = timedOut;
      reject(err);
    });
  });
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

  const containerName = `cf-skill-${jobId.slice(0, 8)}`;
  const args = buildDockerArgs({ image, timeoutMs, env, hostDir, containerName });

  const startTime = Date.now();

  try {
    // L2: spawn('docker', argv, { shell:false }) — no shell string is
    // ever built, so env values and the image name cannot inject.
    const stdout = await spawnDocker(args, timeoutMs);

    // stdout contains the JSON result
    const result = JSON.parse(stdout.trim() || '{"ok":false,"error":"empty output"}');
    return { ...result, durationMs: Date.now() - startTime };
  } catch (err) {
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
      error: err.timedOut ? `Docker execution timed out after ${timeoutMs}ms` : String(err.message || err).slice(0, 500),
      durationMs: Date.now() - startTime,
    };
  } finally {
    try { rmSync(hostDir, { recursive: true, force: true }); } catch {}
  }
}

export { executeInDocker as runDockerSkill };
