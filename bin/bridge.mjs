#!/usr/bin/env node
// Standalone CLI.
//
// The MCP server makes the bridge usable *from* ZCode, but that is only one
// direction. Any agent that can run a shell command — Codex, MiMo, a cron job, a
// git hook — can call this file and reach every configured backend, including
// ZCode itself. That is what turns a star (ZCode in the middle) into a mesh
// where any pair can talk.
//
//   bridge ask "does this design hold up?"            # default target
//   bridge ask "..." --target codex --caller mimo     # explicit, self-aware
//   bridge review --file NOTES.md --target zcode
//   bridge status --json
//   bridge agents
//   bridge fetch --conversation <id>
//   bridge select --target codex --model gpt-5.6-luna
//
// Exit codes are meaningful, because a calling agent has to branch on them:
//   0  answered
//   3  accepted but still running (ticket) — call `fetch`
//   2  usage/config error
//   1  runtime error
import { readFileSync } from 'node:fs';

import { loadConfig, saveConfig, defaultDataDir, loadState, saveState, selectionFor } from '../src/core/config.mjs';
import { loadBackends, describeAll, resolveTarget, disposeBackends } from '../src/core/registry.mjs';
import { converse, redeem, callerIdentity } from '../src/core/session.mjs';
import { buildBrief, buildSummaryPrompt } from '../src/core/brief.mjs';
import { activeLeases, clearLeases, currentHop } from '../src/core/lease.mjs';
import { reverseEntry } from '../src/core/bridge-entry.mjs';
import { hostTargets, installInto, manualInstructions } from '../src/core/setup.mjs';

const DATA_DIR = defaultDataDir();
const CONTEXT = { dataDir: DATA_DIR, log: (m) => process.stderr.write(`[bridge] ${m}\n`), pool: new Map() };

const USAGE = `agent-bridge ${readVersion()}

用法:
  bridge status  [--json]
  bridge agents  [--json]
  bridge ask <问题>        [--target <id>] [--role <role>] [--model <name>] [--conversation <id>]
  bridge review [总结]     [--file <path>] [--request <重点>] [--target <id>]
  bridge fetch   [--conversation <id>] [--target <id>] [--wait]
  bridge select  [--target <id>] [--conversation <id>] [--model <name>] [--create]
  bridge leases  [--clear]
  bridge setup   [--host zcode|codex|claude|all] [--dry-run] [--overwrite]

全局选项:
  --caller <name>     你是谁（默认 $BRIDGE_CALLER，否则 zcode/bridge）
  --target <id>       目标代理；省略用默认，"auto" 选第一个可用的，"random" 随机
  --json              机器可读输出
  --timeout <秒>      等待上限
  --no-guard          跳过防循环检查（仅供测试）
  -h, --help

退出码: 0 已回答 / 3 已受理待取回 / 2 用法错误 / 1 运行错误
`;

// ---------------------------------------------------------------- argv

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { _: [], flags: {} };
  const takesValue = new Set([
    'target', 'caller', 'role', 'model', 'conversation', 'timeout', 'file', 'request', 'cwd', 'host',
  ]);

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('-')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    let name = eq > -1 ? token.slice(0, eq) : token;
    let value = eq > -1 ? token.slice(eq + 1) : null;
    name = name.replace(/^--?/, '');

    if (name === 'h') name = 'help';
    if (name === 'help' || name === 'json' || name === 'wait' || name === 'create' || name === 'no-guard'
      || name === 'dry-run' || name === 'overwrite') {
      const key = name === 'no-guard' ? 'noGuard' : name === 'dry-run' ? 'dryRun' : name;
      out.flags[key] = value === null ? true : value !== 'false';
      continue;
    }
    if (takesValue.has(name)) {
      if (value === null) {
        value = args[i + 1];
        i += 1;
      }
      if (value === undefined || value.startsWith('--')) {
        fail(`选项 --${name} 需要一个值`);
      }
      out.flags[name] = value;
      continue;
    }
    fail(`未知选项 ${token}`);
  }
  return out;
}

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function readVersion() {
  try {
    const url = new URL('../package.json', import.meta.url);
    return `v${JSON.parse(readFileSync(url, 'utf8')).version}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- output

function emit(value, { json }) {
  if (!json) {
    process.stdout.write(`${render(value)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// A single readable rendering for every command, so `--json` is genuinely
// optional rather than the only usable mode.
function render(value) {
  if (value == null) return '';
  // Arrays may contain pre-rendered prose (setup), so they are joined as blocks
  // rather than turned into JSON lines: an escaped multi-line string is the one
  // output shape nobody wants to read.
  if (Array.isArray(value)) {
    return value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n\n');
  }
  if (typeof value === 'string') return value;
  if (value.answer !== undefined) {
    const head = `[${value.backend}${value.conversationId ? ` · ${value.conversationId}` : ''}]`;
    const body = value.answer || (value.awaitingReply ? '(仍在生成，用 bridge fetch 取回)' : '(空回复)');
    return `${head}\n\n${body}`;
  }
  return Object.entries(value)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
}

// ---------------------------------------------------------------- commands

async function commandStatus(flags) {
  const { config, path } = loadConfig({ dataDir: DATA_DIR });
  const backends = loadBackends(config, CONTEXT);
  const agents = await describeAll(backends);
  const state = loadState({ dataDir: DATA_DIR });
  return {
    config: path,
    caller: callerIdentity(flags.caller),
    hop: currentHop(),
    defaultBackend: config.defaultBackend,
    available: agents.filter(a => a.connected).map(a => a.id),
    agents,
    leases: activeLeases({ dataDir: DATA_DIR }),
    automation: { onStop: config.auto.onStop, onError: config.auto.onError },
    lastExchange: state.lastExchange,
    pending: state.pending,
  };
}

async function commandAgents(flags) {
  const { config } = loadConfig({ dataDir: DATA_DIR });
  const backends = loadBackends(config, CONTEXT);
  const out = [];
  for (const [id, backend] of backends) {
    const entry = config.backends[id] || {};
    const check = await backend.available();
    let models = [];
    try { models = await backend.listModels(); } catch { models = []; }
    out.push({
      id,
      type: backend.constructor.type,
      label: backend.label,
      online: check.ok,
      detail: check.detail,
      model: entry.model || null,
      models: models.length,
      // The agent that asked must not be offered to itself.
      self: id === callerIdentity(flags.caller),
    });
  }
  return out;
}

async function commandAsk(parsed) {
  const question = parsed._.slice(1).join(' ').trim();
  if (!question) fail('缺少问题文本。用法：bridge ask "你的问题"');
  const flags = parsed.flags;
  const { config } = loadConfig({ dataDir: DATA_DIR });
  const caller = callerIdentity(flags.caller);

  const backends = loadBackends(config, CONTEXT);
  const backend = await resolveTarget(backends, flags.target || config.defaultBackend, { caller });

  const prompt = buildBrief({
    request: question,
    cwd: flags.cwd || config.workspace || process.cwd(),
    kind: 'question',
    peer: backend.label,
    requester: caller,
  });

  const result = await converse({
    config,
    target: backend.id,
    prompt,
    role: flags.role,
    conversationId: flags.conversation,
    model: flags.model,
    timeoutMs: seconds(flags.timeout),
    ceilingMs: seconds(flags.timeout),
    caller,
    guard: flags.noGuard !== true,
    context: CONTEXT,
    state: loadState({ dataDir: DATA_DIR }),
    onStateChange: (next) => saveState(next, { dataDir: DATA_DIR }),
  });

  return result;
}

async function commandReview(parsed) {
  const flags = parsed.flags;
  const inline = parsed._.slice(1).join(' ').trim();
  const summary = flags.file ? readFileSync(flags.file, 'utf8') : inline;
  if (!summary) fail('缺少完成总结。用法：bridge review "总结" 或 bridge review --file NOTES.md');

  const { config } = loadConfig({ dataDir: DATA_DIR });
  const caller = callerIdentity(flags.caller);
  const backends = loadBackends(config, CONTEXT);
  const backend = await resolveTarget(backends, flags.target || config.defaultBackend, { caller });

  const prompt = buildSummaryPrompt({
    summary,
    request: flags.request,
    cwd: flags.cwd || config.workspace || process.cwd(),
    peer: backend.label,
    requester: caller,
  });

  return converse({
    config,
    target: backend.id,
    prompt,
    role: flags.role || 'review',
    conversationId: flags.conversation,
    model: flags.model,
    timeoutMs: seconds(flags.timeout),
    ceilingMs: seconds(flags.timeout),
    caller,
    guard: flags.noGuard !== true,
    context: CONTEXT,
    state: loadState({ dataDir: DATA_DIR }),
    onStateChange: (next) => saveState(next, { dataDir: DATA_DIR }),
  });
}

async function commandFetch(parsed) {
  const flags = parsed.flags;
  const { config } = loadConfig({ dataDir: DATA_DIR });
  const caller = callerIdentity(flags.caller);
  return redeem({
    config,
    target: flags.target,
    conversationId: flags.conversation,
    role: flags.role,
    wait: flags.wait === true,
    timeoutMs: seconds(flags.timeout),
    state: loadState({ dataDir: DATA_DIR }),
    onStateChange: (next) => saveState(next, { dataDir: DATA_DIR }),
    context: CONTEXT,
    caller,
  });
}

async function commandSelect(parsed) {
  const flags = parsed.flags;
  const { config, path } = loadConfig({ dataDir: DATA_DIR });
  const caller = callerIdentity(flags.caller);
  const backends = loadBackends(config, CONTEXT);
  const backend = await resolveTarget(backends, flags.target || config.defaultBackend, { caller });

  let conversationId = flags.conversation || null;
  if (flags.create) {
    const created = await backend.start({
      workspace: flags.cwd || config.workspace || process.cwd(),
      model: flags.model,
    });
    conversationId = created.id;
  } else if (!conversationId && flags.model === undefined) {
    fail('没有要设定的内容。用 --conversation / --model / --create 之一。');
  }

  const selection = { ...selectionFor(config, backend.id) };
  if (conversationId) selection.conversationId = conversationId;
  if (flags.model) selection.model = await backend.resolveModel(flags.model);

  const next = {
    ...config,
    selections: { ...config.selections, [backend.id]: selection },
    defaultBackend: config.defaultBackend || backend.id,
  };
  saveConfig(next, { dataDir: DATA_DIR });

  return {
    backend: backend.id,
    selection,
    config: path,
    hint: '默认目标也一并固定了，之后的 ask 不带 --target 就会走这里。',
  };
}

function seconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n * 1000;
}

/**
 * Register the bridge with hosts so the reverse channel exists.
 *
 * `--host` accepts a name or "all". Running this against `all` is the intended
 * default behaviour for a new installation: it configures whichever hosts are
 * actually present and silently skips the rest.
 */
async function commandSetup(parsed) {
  const flags = parsed.flags;
  const targets = hostTargets();
  const wanted = flags.host && flags.host !== 'all' ? [flags.host] : Object.keys(targets);

  const unknown = wanted.filter(name => !targets[name]);
  if (unknown.length) {
    fail(`未知的 host "${unknown.join(', ')}"。可用：${Object.keys(targets).join(', ')}, all`);
  }

  const results = [];
  for (const name of wanted) {
    const host = targets[name];
    // Each host is told it speaks as its own id, so a callback from Codex is
    // attributable to Codex rather than to whichever process installed it.
    const entry = reverseEntry({ backendId: name, dataDir: DATA_DIR });
    const result = installInto(host, entry, {
      dryRun: flags.dryRun === true,
      overwrite: flags.overwrite === true,
    });
    results.push({ host: name, label: host.label, ...result, entry });
  }

  return results;
}

// ---------------------------------------------------------------- main

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.flags.help || parsed._.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }

  const command = parsed._[0];
  const json = parsed.flags.json === true;

  switch (command) {
    case 'status':
      emit(await commandStatus(parsed.flags), { json });
      return 0;
    case 'agents':
      emit(await commandAgents(parsed.flags), { json });
      return 0;
    case 'ask': {
      const result = await commandAsk(parsed);
      emit(shape(result, json), { json });
      return result.awaitingReply ? 3 : 0;
    }
    case 'review': {
      const result = await commandReview(parsed);
      emit(shape(result, json), { json });
      return result.awaitingReply ? 3 : 0;
    }
    case 'fetch': {
      const result = await commandFetch(parsed);
      emit(shape(result, json), { json });
      return result.awaitingReply ? 3 : 0;
    }
    case 'select':
      emit(await commandSelect(parsed), { json });
      return 0;
    case 'setup': {
      const results = await commandSetup(parsed);
      emit(renderSetup(results, json), { json });
      return 0;
    }
    case 'leases':
      if (parsed.flags.clear) clearLeases({ dataDir: DATA_DIR });
      emit(activeLeases({ dataDir: DATA_DIR }), { json });
      return 0;
    default:
      fail(`未知命令 "${command}"`);
      return 2;
  }
}

function shape(result, json) {
  const reply = result.reply || null;
  const value = {
    backend: result.backend,
    conversationId: result.conversationId,
    answer: reply?.text || '',
    awaitingReply: result.awaitingReply === true,
    status: result.status,
  };
  if (result.model) value.model = result.model;
  if (result.errors?.length) value.errors = result.errors;
  if (json) return value;
  return value;
}

// Setup output is for a human deciding whether to trust it: say what happened
// per host, and show the exact block for anything that was not written.
//
// "would change" and "did change" are different answers, and conflating them is
// how a --dry-run ends up looking like it wrote files.
function renderSetup(results, json) {
  if (json) return results.map(({ entry, ...rest }) => rest);
  return results.map((r) => {
    const head = r.changed
      ? `✓ ${r.label} 已写入`
      : r.wouldChange
        ? `→ ${r.label} 待写入（dry-run，未改动）`
        : `· ${r.label} 未改动`;
    const reason = r.reason ? `\n  ${r.reason}` : '';
    const where = `\n  ${r.path}`;
    const preview = (r.wouldChange || !r.changed) && r.preview ? `\n\n${r.preview}` : '';
    return `${head}${reason}${where}${preview}`;
  }).join('\n\n');
}

main()
  .then(async (code) => {
    await shutDown();
    // Set the code and let the loop drain instead of calling process.exit().
    // On Windows, exit() while a child or socket handle is mid-teardown trips a
    // libuv assertion and the process dies with 127 — a successful command
    // reported as a failure. Draining costs a few milliseconds and is honest.
    process.exitCode = code;
    // Backstop: if something still holds the loop open (a wedged child), leave
    // rather than hang the calling agent's shell command.
    setTimeout(() => process.exit(code), 2000).unref();
  })
  .catch(async (err) => {
    // A backend failure is data for the calling agent, not a crash. Print the
    // actionable part and keep the stack behind BRIDGE_VERBOSE.
    const message = err?.message || String(err);
    process.stderr.write(`bridge 失败: ${message}\n`);
    if (err?.code) process.stderr.write(`  code: ${err.code}\n`);
    if (process.env.BRIDGE_VERBOSE === '1' && err?.stack) process.stderr.write(`${err.stack}\n`);
    await shutDown();
    process.exitCode = 2;
    setTimeout(() => process.exit(2), 2000).unref();
  });

async function shutDown() {
  try {
    await disposeBackends(CONTEXT);
  } catch {
    /* best effort on the way out */
  }
}
