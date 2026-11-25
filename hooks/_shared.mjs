// Shared plumbing for the two hooks.
//
// Hooks are the most fragile part of this project: they run on every turn, they
// are killed if they are slow, and a wrong byte on stdout corrupts the
// transcript. So the rules live here once, not twice:
//
//   * read stdin with a timeout instead of hanging a turn
//   * log to a file, never to stdout (stdout is the hook protocol)
//   * on any problem, exit 0 with no output = "nothing to add"
//   * resolve the backend from the same config the tools use
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir, loadConfig, saveConfig, loadState, saveState } from '../src/core/config.mjs';
import { loadBackends, disposeBackends, resolveTarget } from '../src/core/registry.mjs';
import { callerIdentity } from '../src/core/session.mjs';

export const DATA_DIR = defaultDataDir();
export const LOG_PATH = join(DATA_DIR, 'hook.log');

// Who the hook speaks for. Under ZCode this is "zcode"; when the same hooks are
// installed in another host, BRIDGE_CALLER names it.
export const CALLER = callerIdentity();

// One context for the whole hook process. The `pool` matters: an ACP backend
// lives in a child process, so the instance that sent the prompt must be the
// same one that waits for it.
export const CONTEXT = {
  dataDir: DATA_DIR,
  log: (m) => log(m),
  pool: new Map(),
};

export function log(msg) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {}
}

// Hooks fire constantly; only leave evidence when something actually happened.
//
// Exiting must release pooled backends first: an ACP child process keeps the
// event loop alive, so a hook that just returns would linger until the host
// kills it — and a hook that never exits is a broken turn.
export function quiet() {
  releaseBackends();
  process.exit(0);
}

export function releaseBackends() {
  try {
    disposeBackends(CONTEXT);
  } catch { /* best effort, we are on the way out */ }
}

export async function readInput() {
  const raw = await new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    // A hook with no stdin should not hang the turn.
    setTimeout(() => resolve(buf), 2000);
  });

  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    log(`bad stdin: ${raw.slice(0, 200)}`);
    return null;
  }
}

export function configuration() {
  return loadConfig({ dataDir: DATA_DIR }).config;
}

export function updateConfiguration(patch) {
  const next = { ...configuration(), ...patch };
  saveConfig(next, { dataDir: DATA_DIR });
  return next;
}

// Same repair the MCP path does: a pinned thread the agent has forgotten must be
// replaced, or every later automatic forward fails on the stale id.
export function repairPin({ backend, role, stale, conversationId }) {
  const config = configuration();
  const patch = {};
  const pinned = role ? config.roles?.[role] : null;
  if (pinned?.conversationId === stale) {
    patch.roles = { ...config.roles, [role]: { backend, conversationId } };
  }
  const selection = { ...(config.selections?.[backend] || {}) };
  if (selection.conversationId === stale) {
    selection.conversationId = conversationId;
    patch.selections = { ...config.selections, [backend]: selection };
  }
  if (Object.keys(patch).length) {
    saveConfig({ ...config, ...patch }, { dataDir: DATA_DIR });
    log(`repaired stale conversation pin ${String(stale).slice(0, 8)} -> ${String(conversationId).slice(0, 8)}`);
  }
}export function state() {
  return loadState({ dataDir: DATA_DIR });
}

export function commitState(next) {
  saveState(next, { dataDir: DATA_DIR });
  return next;
}

/**
 * The backend an automatic hook should talk to, or null when none is usable.
 *
 * `autoBackend` lets automation point somewhere other than the interactive
 * default — e.g. review with a stronger model on a different agent than the one
 * used for ad-hoc questions.
 *
 * The caller is excluded. This is the single most important line in the file for
 * loop safety: if ZCode is itself registered as a backend, a hook that fires when
 * ZCode's turn ends and forwards the summary "to ZCode" would start a turn in
 * ZCode, whose end fires the hook again. Excluding self makes that impossible.
 */
export async function autoBackend(config) {
  const backends = loadBackends(config, CONTEXT);
  const wanted = config.autoBackend || config.defaultBackend;
  if (wanted && wanted !== CALLER) {
    const found = backends.get(wanted);
    if (found) return found;
    // A stale autoBackend (agent uninstalled, id renamed) must not kill the
    // hook: fall through to whatever else is configured.
    log(`autoBackend "${wanted}" is not configured, falling back`);
  } else if (wanted === CALLER) {
    log(`autoBackend "${wanted}" is the caller; refusing to send a turn back to itself`);
  }
  try {
    return await resolveTarget(backends, 'auto', { caller: CALLER });
  } catch {
    return null;
  }
}

export function backendLabel(backend) {
  const label = backend?.label;
  return typeof label === 'string' ? label : (backend?.id || '协作方');
}

// The transcript is JSONL of {message:{role,content:[...]}}; pull tool names out
// of it when they were recorded, otherwise return nothing.
export function readToolTrail(path) {
  if (!path) return [];
  try {
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const content = rec?.message?.content || rec?.content || [];
        for (const item of content) {
          if (item?.type === 'tool_use' && item.name) out.push(String(item.name));
          if (item?.type === 'tool_result' && item.name) out.push(String(item.name));
        }
      } catch { /* skip malformed */ }
    }
    return [...new Set(out)].slice(0, 15);
  } catch {
    return [];
  }
}

export function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
