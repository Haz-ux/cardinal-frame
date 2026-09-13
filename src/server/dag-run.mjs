/**
 * Cardinal Frame — shared DAG executor (v2 fix, no re-architecture)
 *
 * Used by BOTH execution paths:
 *  - the durable queue's `dag` handler (src/server/job-queue.mjs) — the production path
 *  - the in-process fallback in POST /api/dags/:id/run (src/server/routes/tasks.mjs)
 *
 * Fixes vs the original main-branch executor:
 *  1. Dispatches on `node.type` instead of shelling every node's `command`.
 *     Editor types: trigger, task, condition, parallel, output, delay, webhook,
 *     transform, branch, loop, notify.
 *  2. Data flows along edges: each node sees its predecessors' outputs via `$`
 *     (`$.nodes.<id>`, `$.up[]`, `$.data`) and `{{nodes.<id>.output}}` mustache
 *     substitution in string fields before execution.
 *  3. `sanitizeCommand` (allowlist) is enforced on EVERY shell path — the old
 *     queue handler ran `node.command` with no check at all.
 *
 * Security invariants:
 *  - `task` nodes run only through the allowlist `sanitizeCommand`; anything
 *    else is recorded as failed, never executed.
 *  - `transform` / `condition` / `branch` expressions run in node:vm with a
 *    sterilized, null-prototype `$` context only — no require, no process,
 *    no console, no network — with a 5s timeout and code generation disabled.
 *  - `webhook` / `loop` / unknown types are NEVER executed; they are recorded
 *    as `skipped` with reason 'not supported yet'. No network fetch, ever.
 *
 * Behavior contract (unchanged from the original):
 *  - layers run in topological order; cycle still throws 'Cycle detected in DAG'
 *  - per-node result objects carry { nodeId, nodeName, type, status, ... }
 *  - statuses: 'success' | 'failed' | 'skipped'
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import vm from 'node:vm';

const execAsync = promisify(exec);
const EXPR_TIMEOUT_MS = 5000;
const MAX_DELAY_S = 300;

// ─── Graph helpers ──────────────────────────────────────────────────

/** Accept both {source,target} (API/DB) and {from,to} (client) edge shapes. */
export function normalizeEdges(edges) {
  const out = [];
  for (const e of edges || []) {
    if (!e || typeof e !== 'object') continue;
    const source = e.source ?? e.from;
    const target = e.target ?? e.to;
    if (typeof source !== 'string' || typeof target !== 'string') continue;
    // label/sourcePort are persisted by DAGEditor.jsx (T/F, A/B/C port tags).
    out.push({ source, target, label: e.label ?? '', sourcePort: e.sourcePort ?? null });
  }
  return out;
}

/** Layers of node IDs that can run in parallel. Throws on cycle. */
export function topoSortLayers(nodes, edges) {
  const norm = normalizeEdges(edges);
  const inDeg = new Map();
  const adj = new Map();
  for (const n of nodes) {
    inDeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of norm) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue; // ignore dangling edges
    adj.get(e.source).push(e.target);
    inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
  }
  const layers = [];
  let current = [];
  for (const [id, deg] of inDeg) if (deg === 0) current.push(id);

  while (current.length) {
    layers.push([...current]);
    const next = [];
    for (const cur of current) {
      for (const nxt of adj.get(cur) || []) {
        inDeg.set(nxt, inDeg.get(nxt) - 1);
        if (inDeg.get(nxt) === 0) next.push(nxt);
      }
    }
    current = next;
  }

  const totalSorted = layers.reduce((s, l) => s + l.length, 0);
  if (totalSorted !== nodes.length) throw new Error('Cycle detected in DAG');
  return layers;
}

// ─── Data flow ──────────────────────────────────────────────────────

/**
 * Mustache substitution for string fields: {{nodes.<id>.output}}.
 * Objects are JSON-encoded. Unresolvable references are left as-is (visible).
 */
export function substitute(template, resultsById) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*nodes\.([A-Za-z0-9_-]+)\.output\s*\}\}/g, (m, id) => {
    const r = resultsById ? resultsById.get(id) : undefined;
    if (!r) return m;
    const v = r.output;
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** Recursively rebuild plain data with null prototypes (closes vm escape via .constructor). */
function sterilize(value, seen = new Map()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const out = Array.isArray(value) ? [] : Object.create(null);
  seen.set(value, out);
  for (const k of Object.keys(value)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = sterilize(value[k], seen);
  }
  return out;
}

/** The `$` every expression node sees: predecessor outputs + all results so far. */
function makeDollar(ups, resultsById) {
  const nodes = Object.create(null);
  if (resultsById) {
    for (const [id, r] of resultsById) nodes[id] = r ? r.output : undefined;
  }
  const up = ups.map((u) => u.output);
  return { nodes, up, data: up.length === 1 ? up[0] : up };
}

function evalExpr(expr, $) {
  const sandbox = { $: sterilize($) };
  vm.createContext(sandbox);
  const opts = { timeout: EXPR_TIMEOUT_MS, codeGeneration: { strings: false, wasm: false } };
  try {
    // Parenthesized first so object literals evaluate as expressions.
    return vm.runInContext(`(${expr})`, sandbox, opts);
  } catch (err) {
    if (err && err.name === 'SyntaxError') return vm.runInContext(expr, sandbox, opts);
    throw err;
  }
}

/** Map a branch expression value to an outgoing port label. */
function mapBranchLabel(v) {
  if (typeof v === 'string') {
    const s = v.trim().toUpperCase();
    if (s === 'A' || s === 'B' || s === 'C') return s;
    if (s === 'TRUE') return 'A';
    if (s === 'FALSE') return 'B';
    const n = Number(s);
    if (Number.isFinite(n)) return ['A', 'B', 'C'][Math.max(0, Math.min(2, Math.round(n)))] || 'A';
    return 'A';
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return ['A', 'B', 'C'][Math.max(0, Math.min(2, Math.round(v)))] || 'A';
  }
  if (typeof v === 'boolean') return v ? 'A' : 'B';
  return 'A';
}

function mergeUpstream(ups) {
  if (!ups.length) return null;
  if (ups.length === 1) return ups[0].output;
  return ups.map((u) => u.output);
}

// ─── Single-node dispatch ───────────────────────────────────────────

/**
 * Run one node. Returns a result object; never throws for node-level problems
 * (node failures are recorded, not raised). `nodeCtx`:
 * { upstream:[{id,output}], $, resultsById, sanitizeCommand, timeoutMs, broadcast, dagId, layer }
 */
export async function runNode(node, nodeCtx) {
  const start = Date.now();
  const type = node.type || (node.command ? 'task' : 'trigger');
  const base = {
    nodeId: node.id,
    nodeName: node.name || node.id,
    type,
    timestamp: new Date().toISOString(),
    layer: nodeCtx.layer ?? 0,
  };
  const done = (patch) => ({ ...base, durationMs: Date.now() - start, ...patch });

  const raw = typeof node.command === 'string' ? node.command : '';
  const field = substitute(raw, nodeCtx.resultsById).trim();

  switch (type) {
    case 'task': {
      if (!field) return done({ status: 'skipped', reason: 'no command' });
      const check = nodeCtx.sanitizeCommand
        ? nodeCtx.sanitizeCommand(field)
        : { safe: false, error: 'no sanitizer configured' };
      if (!check.safe) return done({ status: 'failed', error: check.error });
      try {
        const { stdout } = await execAsync(check.command, {
          timeout: nodeCtx.timeoutMs || 30000,
          shell: '/bin/sh',
          env: { PATH: process.env.PATH },
          cwd: '/tmp',
        });
        return done({ status: 'success', exitCode: 0, output: stdout.trim().slice(0, 2000) });
      } catch (err) {
        return done({
          status: 'failed',
          exitCode: err.code ?? 1,
          error: (err.stderr || err.message || 'command failed').slice(0, 500),
        });
      }
    }

    case 'transform': {
      if (!field) return done({ status: 'skipped', reason: 'no expression' });
      try {
        const value = evalExpr(field, nodeCtx.$);
        return done({ status: 'success', output: value === undefined ? null : value });
      } catch (err) {
        return done({ status: 'failed', error: `transform error: ${err.message}`.slice(0, 500) });
      }
    }

    case 'notify': {
      const message = field || node.name || 'notification';
      try {
        nodeCtx.broadcast && nodeCtx.broadcast('dag:notify', { dagId: nodeCtx.dagId, nodeId: node.id, message });
      } catch { /* broadcast is best-effort */ }
      return done({ status: 'success', message, output: { notified: true, message } });
    }

    case 'delay': {
      const secs = Math.min(MAX_DELAY_S, Math.max(0, parseFloat(field) || 0));
      await new Promise((r) => setTimeout(r, secs * 1000));
      return done({ status: 'success', output: { delayedSeconds: secs } });
    }

    case 'trigger':
    case 'parallel':
    case 'output': {
      return done({ status: 'success', output: mergeUpstream(nodeCtx.upstream) });
    }

    case 'condition': {
      let result = true;
      let note;
      if (!field) {
        note = 'no expression — defaulted to true';
      } else {
        try {
          result = !!evalExpr(field, nodeCtx.$);
        } catch (err) {
          return done({ status: 'failed', error: `condition error: ${err.message}`.slice(0, 500) });
        }
      }
      const taken = result ? 'T' : 'F';
      return done({ status: 'success', taken, output: { result, taken, ...(note ? { note } : {}) } });
    }

    case 'branch': {
      let selected = 'A';
      let note;
      if (!field) {
        note = 'no expression — defaulted to A';
      } else {
        try {
          selected = mapBranchLabel(evalExpr(field, nodeCtx.$));
        } catch (err) {
          return done({ status: 'failed', error: `branch error: ${err.message}`.slice(0, 500) });
        }
      }
      return done({ status: 'success', taken: selected, output: { selected, ...(note ? { note } : {}) } });
    }

    default:
      // webhook, loop, unknown types: honest skip — never fake execution, never shell out.
      return done({ status: 'skipped', reason: 'not supported yet' });
  }
}

// ─── Full DAG run ───────────────────────────────────────────────────

/**
 * Run all layers in order with data flow + branch routing.
 *
 * events: { onLayerStart(layerIdx, layer), onLayerDone(layerIdx, layer, results),
 *           onNodeStart(nodeId), onNodeDone(nodeId, result) }
 *
 * Returns { layers, layerResults:[{layer, results}], resultsById, outputs, finalOutput }.
 * Throws only on structural problems (cycle); node failures are recorded per-node.
 */
export async function runDag({ nodes, edges, sanitizeCommand, broadcast, dagId, timeoutMs = 30000, events = {} }) {
  const normEdges = normalizeEdges(edges);
  const layers = topoSortLayers(nodes, normEdges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map();
  const outgoing = new Map();
  for (const n of nodes) {
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }
  let seq = 0; // creation order — stable fallback for legacy edges without sourcePort
  for (const e of normEdges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    outgoing.get(e.source).push({ target: e.target, label: e.label, sourcePort: e.sourcePort, i: seq++ });
    incoming.get(e.target).push(e.source);
  }

  const resultsById = new Map();
  const layerResults = [];
  const inactiveReason = new Map();
  // Seed: nodes with no incoming edges are active from the start.
  const active = new Set(nodes.filter((n) => incoming.get(n.id).length === 0).map((n) => n.id));

  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    events.onLayerStart && events.onLayerStart(li, layer);

    const settled = await Promise.all(
      layer.map(async (nodeId) => {
        const node = byId.get(nodeId);
        if (!active.has(nodeId)) {
          const r = {
            nodeId,
            nodeName: (node && node.name) || nodeId,
            type: (node && node.type) || 'task',
            status: 'skipped',
            reason: inactiveReason.get(nodeId) || 'branch not taken',
            timestamp: new Date().toISOString(),
            layer: li,
            durationMs: 0,
          };
          resultsById.set(nodeId, r);
          events.onNodeDone && events.onNodeDone(nodeId, r);
          return r;
        }
        const ups = incoming.get(nodeId).map((srcId) => ({
          id: srcId,
          output: resultsById.has(srcId) ? resultsById.get(srcId).output : undefined,
        }));
        const $ = makeDollar(ups, resultsById);
        events.onNodeStart && events.onNodeStart(nodeId);
        const r = await runNode(node, {
          upstream: ups,
          $,
          resultsById,
          sanitizeCommand,
          timeoutMs,
          broadcast,
          dagId,
          layer: li,
        });
        resultsById.set(nodeId, r);
        events.onNodeDone && events.onNodeDone(nodeId, r);
        return r;
      })
    );
    layerResults.push({ layer: li, results: settled });

    // Propagate taken-ness for the next layers.
    for (const r of settled) {
      const outs = outgoing.get(r.nodeId) || [];
      if (!outs.length) continue;
      // Port order: persisted sourcePort first, creation order as fallback (legacy edges).
      const byPort = [...outs].sort((a, b) => (a.sourcePort ?? 1e9) - (b.sourcePort ?? 1e9) || a.i - b.i);
      let takenTargets;
      if ((r.type === 'condition' || r.type === 'branch') && r.status === 'success' && r.taken) {
        const labels = r.type === 'condition' ? ['T', 'F'] : ['A', 'B', 'C'];
        const idx = labels.indexOf(r.taken);
        takenTargets = idx >= 0 && byPort[idx] ? [byPort[idx].target] : [byPort[0].target];
      } else if (r.status === 'failed') {
        // A failed node halts its downstream path (standard DAG semantics).
        for (const o of outs) {
          if (!active.has(o.target) && !inactiveReason.has(o.target)) inactiveReason.set(o.target, 'upstream failed');
        }
        continue;
      } else {
        takenTargets = outs.map(o => o.target);
      }
      for (const t of takenTargets) active.add(t);
    }

    events.onLayerDone && events.onLayerDone(li, layer, settled);
  }

  const outputs = {};
  for (const n of nodes) {
    if ((n.type || '') === 'output') outputs[n.id] = resultsById.has(n.id) ? resultsById.get(n.id).output : null;
  }
  const outputIds = Object.keys(outputs);
  const finalOutput = outputIds.length === 1 ? outputs[outputIds[0]] : outputIds.length ? outputs : null;

  return { layers, layerResults, resultsById, outputs, finalOutput };
}
