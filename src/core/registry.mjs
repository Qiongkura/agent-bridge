// Backend registry.
//
// This is the only place that knows which backend implementations exist. Adding
// a backend is a two-line change here plus one file in ./backends/, which keeps
// the core ignorant of any particular agent.
import { AntigravityBackend } from '../backends/antigravity.mjs';
import { AcpBackend } from '../backends/acp.mjs';
import { CliBackend } from '../backends/cli.mjs';
import { BridgeError } from './contract.mjs';

const TYPES = {
  [AntigravityBackend.type]: AntigravityBackend,
  [AcpBackend.type]: AcpBackend,
  [CliBackend.type]: CliBackend,
};

export function backendTypes() {
  return Object.keys(TYPES);
}

export function createBackend(id, entry, context) {
  const type = entry?.type;
  const Impl = TYPES[type];
  if (!Impl) {
    throw new BridgeError(
      `unknown backend type "${type}" for "${id}". Known types: ${backendTypes().join(', ')}`,
      { code: 'unknown_backend_type' },
    );
  }
  return new Impl({ ...entry, id }, context);
}

/**
 * Instantiate every configured backend.
 *
 * Instances are *pooled* per `context.pool`, because a backend is not always
 * stateless: an ACP agent lives in a child process and remembers its session
 * there. A fresh instance per tool call would spawn a new process each time and
 * leave the previous session unreachable — the conversation id would point at a
 * process that no longer exists.
 *
 * Construction is still cheap: a backend must not spawn or connect in its
 * constructor, so a cache miss costs nothing.
 */
export function loadBackends(config, context = {}) {
  const configured = config?.backends || {};
  const pool = context.pool instanceof Map ? context.pool : new Map();
  if (context.pool !== pool) context.pool = pool;
  const out = new Map();

  for (const [id, entry] of Object.entries(configured)) {
    if (entry?.enabled === false) continue;
    const key = `${id}:${JSON.stringify(entry)}`;
    const cached = pool.get(id);
    if (cached && cached.key === key) {
      out.set(id, cached.backend);
      continue;
    }
    try {
      const backend = createBackend(id, entry, context);
      if (cached) {
        try { cached.backend.dispose?.(); } catch { /* best effort */ }
      }
      pool.set(id, { key, backend });
      out.set(id, backend);
    } catch (err) {
      context.log?.(`backend "${id}" skipped: ${err.message}`);
    }
  }

  // Drop instances whose backend was removed, so their child processes do not
  // outlive the config that created them.
  for (const [id, cached] of pool) {
    if (!out.has(id)) {
      try { cached.backend.dispose?.(); } catch { /* best effort */ }
      pool.delete(id);
    }
  }

  return out;
}

/**
 * Release every pooled backend.
 *
 * Long-lived processes (the MCP server, a hook that is about to exit) must call
 * this: an ACP child keeps the event loop alive forever otherwise, and a hook
 * that never exits is a broken turn.
 */
export function disposeBackends(context = {}) {
  const pool = context.pool;
  if (!(pool instanceof Map)) return;
  for (const [, cached] of pool) {
    try { cached.backend.dispose?.(); } catch { /* best effort */ }
  }
  pool.clear();
}

// Resolve a target argument. A bare name is a backend id; "auto" or empty means
// "the first backend that reports itself available", so a fresh install works
// without any configuration.
export async function resolveTarget(backends, target) {
  if (target && target !== 'auto') {
    const found = backends.get(target);
    if (!found) {
      throw new BridgeError(
        `unknown backend "${target}". Configured: ${[...backends.keys()].join(', ') || '(none)'}`,
        { code: 'unknown_backend' },
      );
    }
    return found;
  }

  const reports = [];
  for (const backend of backends.values()) {
    const check = await backend.available();
    if (check.ok) return backend;
    reports.push(`${backend.id}: ${check.detail || 'unavailable'}`);
  }

  throw new BridgeError(
    `no backend is available.\n${reports.join('\n') || 'no backends configured'}`,
    { code: 'none_available' },
  );
}

// Availability of every backend, for status output. Failures are data here, not
// exceptions: the point is to show the user what is and is not working.
export async function describeAll(backends) {
  const out = [];
  for (const [id, backend] of backends) {
    try {
      const desc = await backend.describe();
      out.push({ id, ...desc });
    } catch (err) {
      out.push({ id, type: backend.constructor.type, connected: false, detail: err.message });
    }
  }
  return out;
}
