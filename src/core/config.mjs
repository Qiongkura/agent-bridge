// Configuration and first-run detection.
//
// A project that only works after the user hand-writes a config file will not be
// adopted. So the bridge ships with a detector: on first run it looks for agents
// it knows how to reach and writes a config containing the ones it found. The
// user can edit that file, but they never have to create it.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export function defaultDataDir() {
  if (process.env.BRIDGE_DATA_DIR) return process.env.BRIDGE_DATA_DIR;
  if (process.env.ZCODE_PLUGIN_DATA) return process.env.ZCODE_PLUGIN_DATA;
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  return join(homedir(), '.bridge');
}

export function readJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// Where each known agent hides the evidence that it is installed. These are
// probes, not requirements: a missing path only means "do not preconfigure it".
function hasAntigravity() {
  const dir = process.env.ZCODE_AGY_GEMINI_DIR
    ? join(process.env.ZCODE_AGY_GEMINI_DIR, 'antigravity')
    : join(homedir(), '.gemini', 'antigravity');
  return existsSync(dir);
}

function findExecutable(names) {
  const pathDirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const dir of pathDirs) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function findCodex() {
  // Codex ships a versioned bin dir, so match the newest codex.exe under the
  // known install root instead of pinning one hash.
  const roots = process.platform === 'win32'
    ? [join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin')]
    : [join(homedir(), '.codex', 'bin')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const exe = join(root, name, process.platform === 'win32' ? 'codex.exe' : 'codex');
      if (existsSync(exe)) return exe;
    }
  }
  return findExecutable(['codex']);
}

function findAcpCandidates() {
  // ACP is the cheapest path to broad support, so probe for the harnesses known
  // to ship an ACP server. Add new entries here as they appear upstream.
  const out = [];
  const deepseekRoot = process.env.DEEPSEEK_HARNESS_ROOT || 'G:\\deepseek-harness';
  if (existsSync(join(deepseekRoot, 'packages', 'acp'))) {
    out.push({
      id: 'deepseek',
      name: 'DeepSeek Harness',
      type: 'acp',
      command: 'node',
      // The upstream repo exposes its automation server through this script.
      args: ['--import', 'tsx', join(deepseekRoot, 'packages', 'examples', 'acp-demo', 'src', 'bin.ts'),
        '--config', join(deepseekRoot, 'examples', 'acp-agent', 'cordis.yml')],
      cwd: deepseekRoot,
      autoApprove: true,
      enabled: false, // present but off until the user confirms the path works
    });
  }
  return out;
}

/**
 * Build the config a first-time user should get.
 *
 * The result is deliberately conservative: agents that were detected are added,
 * but automation stays off. Sending work to another agent costs money and can
 * loop, so that is an opt-in.
 */
export function detectConfig({ cwd = process.cwd() } = {}) {
  const backends = {};

  if (hasAntigravity()) {
    backends.antigravity = { type: 'antigravity', enabled: true };
  }

  const codex = findCodex();
  if (codex) {
    backends.codex = {
      type: 'cli',
      name: 'Codex',
      enabled: false,
      command: codex,
      args: ['exec', '--skip-git-repo-check', '-s', 'read-only', '{prompt}'],
      timeoutMs: 300000,
    };
  }

  for (const acp of findAcpCandidates()) {
    backends[acp.id] = acp;
  }

  return {
    version: 1,
    // What the bridge talks to when a tool call names no target.
    defaultBackend: backends.antigravity ? 'antigravity' : Object.keys(backends)[0] || null,
    // Per-role routing: a review can go to a different agent than a question.
    roles: {},
    model: null,
    autoModel: null,
    auto: {
      onStop: false,
      onError: false,
      continueAfterReview: true,
      reviewOnStop: true,
      minResponseChars: 80,
    },
    backends,
  };
}

/**
 * Load config, creating it from detection on first run.
 * Returns { config, created, path } so callers can tell the user what happened.
 */
export function loadConfig({ dataDir = defaultDataDir(), cwd } = {}) {
  const path = join(dataDir, 'config.json');
  const existing = readJson(path, null);

  if (existing) {
    // A config from version 1 has no `backends` section at all: it predates the
    // idea of choosing an agent. Detection has to happen *before* normalizing,
    // because migration attributes the old flat keys to the default backend and
    // there is no default until one is detected.
    if (!existing.backends || !Object.keys(existing.backends).length) {
      const detected = detectConfig({ cwd });
      const merged = {
        ...existing,
        backends: detected.backends,
        defaultBackend: existing.defaultBackend || detected.defaultBackend,
      };
      const config = normalize(merged);
      writeJson(path, config);
      return { config, created: false, path, upgraded: true };
    }
    return { config: normalize(existing), created: false, path };
  }

  const fresh = detectConfig({ cwd });
  writeJson(path, fresh);
  return { config: normalize(fresh), created: true, path };
}

// Version 1 was a single-backend plugin with a flat config. Upgrading users
// still have that file on disk, so fold the old keys into the new shape instead
// of silently resetting their choices.
function migrateLegacy(raw) {
  const auto = { ...(raw.auto || {}) };
  if (raw.autoOnStop !== undefined) auto.onStop = raw.autoOnStop === true;
  if (raw.autoOnError !== undefined) auto.onError = raw.autoOnError === true;
  if (raw.autoContinue !== undefined) auto.continueAfterReview = raw.autoContinue !== false;
  if (raw.reviewOnStop !== undefined) auto.reviewOnStop = raw.reviewOnStop === true;
  if (raw.autoTimeoutMs !== undefined) auto.timeoutMs = Number(raw.autoTimeoutMs);
  if (raw.autoMinEdits !== undefined) auto.minEdits = Number(raw.autoMinEdits);
  if (raw.autoRole !== undefined) auto.role = raw.autoRole || 'review';

  const backends = raw.backends || {};
  const defaultBackend = raw.defaultBackend || (backends.antigravity ? 'antigravity' : null);

  // Old shape: a flat `conversationId`, `model`, `autoModel`, plus a
  // role -> conversation map. All of it implicitly belonged to the only backend
  // there was, so attribute it to the default and move on.
  const selections = { ...(raw.selections || {}) };
  if (defaultBackend && (raw.conversationId || raw.model || raw.autoModel)) {
    selections[defaultBackend] = {
      ...(selections[defaultBackend] || {}),
      ...(raw.conversationId ? { conversationId: raw.conversationId } : {}),
      ...(raw.model ? { model: raw.model } : {}),
      ...(raw.autoModel ? { autoModel: raw.autoModel } : {}),
    };
  }

  const roles = {};
  for (const [role, value] of Object.entries(raw.roles || raw.conversations || {})) {
    if (typeof value === 'string') {
      if (defaultBackend) roles[role] = { backend: defaultBackend, conversationId: value };
    } else if (value && typeof value === 'object') {
      roles[role] = { backend: value.backend || defaultBackend, conversationId: value.conversationId || null };
    }
  }

  return { auto, roles, selections, defaultBackend, backends };
}

// Fill in defaults without clobbering the user's values. Config files written by
// an older version stay valid.
export function normalize(raw) {
  const { auto, roles, selections, defaultBackend, backends } = migrateLegacy(raw);

  return {
    version: 2,
    defaultBackend,
    // Automation may deliberately point at a different agent than interactive
    // work (review with the strong model, ask the fast one).
    autoBackend: raw.autoBackend || null,
    // Per-backend sticky choices. A conversation id is meaningless to any other
    // backend, so it must never live in a shared slot — a single `conversationId`
    // would hand Antigravity's cascade id to Codex.
    selections,
    roles,
    workspace: raw.workspace || null,
    maxReplyChars: Number(raw.maxReplyChars) || 12000,
    auto: {
      onStop: auto.onStop === true,
      onError: auto.onError === true,
      continueAfterReview: auto.continueAfterReview !== false,
      reviewOnStop: auto.reviewOnStop !== false,
      // A greeting or acknowledgement is not worth a round trip. Counting
      // characters alone gets this wrong for Chinese, where 65 characters is a
      // substantial paragraph: a CJK codepoint carries far more meaning per unit
      // than a Latin one. The threshold is therefore weighted rather than raw.
      minResponseChars: Number.isFinite(Number(auto.minResponseChars))
        ? Number(auto.minResponseChars)
        : 80,
      // How much a turn must change before a review round trip is worth it.
      // 0 means "review every turn" — the behaviour this gate exists to avoid,
      // but some users want it.
      minEdits: Number.isFinite(Number(auto.minEdits)) ? Number(auto.minEdits) : 3,
      timeoutMs: Number(auto.timeoutMs) || 180000,
      errorTimeoutMs: Number(auto.errorTimeoutMs) || 90000,
      errorCooldownMs: Number(auto.errorCooldownMs) || 120000,
      role: auto.role || 'review',
    },
    backends,
  };
}

// Helpers so callers never index `selections` by hand and forget the fallback.
export function selectionFor(config, backendId) {
  return { ...(config.selections?.[backendId] || {}) };
}

export function conversationFor(config, backendId, role) {
  const pinned = role ? config.roles?.[role] : null;
  if (pinned && (!pinned.backend || pinned.backend === backendId)) return pinned.conversationId;
  return config.selections?.[backendId]?.conversationId || null;
}

export function saveConfig(config, { dataDir = defaultDataDir() } = {}) {
  const path = join(dataDir, 'config.json');
  writeJson(path, config);
  return path;
}

// Runtime state (what is in flight, what was already forwarded) is separate from
// config: it changes on every turn, and a corrupted state file should never cost
// the user their settings.
export function statePath({ dataDir = defaultDataDir() } = {}) {
  return join(dataDir, 'state.json');
}

export function loadState(opts) {
  const state = readJson(statePath(opts), {});
  // Keep unknown keys rather than whitelisting: the hooks write bookkeeping here
  // (commit watermarks, cooldown stamps) and a whitelist silently discards them,
  // which is how a "once per N minutes" guard turns into "every single time".
  return {
    ...state,
    pending: Array.isArray(state.pending) ? state.pending : [],
    lastForwarded: state.lastForwarded || {},
    lastSeenCommit: state.lastSeenCommit || {},
    lastExchange: state.lastExchange || null,
    lastReview: state.lastReview || null,
  };
}

export function saveState(state, opts) {
  writeJson(statePath(opts), state);
}

// Read-modify-write in one helper, so a caller cannot accidentally drop the
// fields it did not touch.
export function updateState(mutate, opts) {
  const next = { ...loadState(opts), ...mutate(loadState(opts)) };
  saveState(next, opts);
  return next;
}
