#!/usr/bin/env node
// Smoke test for the bridge MCP server.
//
// Spawns the server the way the host does — a long-lived child with stdin open —
// then drives one request at a time and prints what came back. Piping a batch of
// lines into a short-lived process is not a faithful test: the client keeps the
// connection open for the whole session.
//
// Usage:
//   node scripts/smoke-test.mjs                    # status + agents + models
//   node scripts/smoke-test.mjs ask "hello"        # also send a real prompt
//   node scripts/smoke-test.mjs ask "hi" codex     # ... to a specific backend
//   node scripts/smoke-test.mjs full               # create a conversation, then ask
//
// Set BRIDGE_DATA_DIR to test against a throwaway config instead of your real one.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'src', 'mcp', 'server.mjs');

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('[non-json]', line.slice(0, 300));
      continue;
    }
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    } else {
      console.error('[unsolicited]', JSON.stringify(msg).slice(0, 300));
    }
  }
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { stderr += d; });

child.on('exit', (code, signal) => {
  if (pending.size) {
    for (const [, waiter] of pending) waiter({ error: { message: `server exited (${code ?? signal})` } });
    pending.clear();
  }
});

function call(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时 (60s)`));
    }, 60000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

async function tool(name, args = {}) {
  const res = await call('tools/call', { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  const text = res.result?.content?.[0]?.text || '';
  const parsed = (() => { try { return JSON.parse(text); } catch { return text; } })();
  if (res.result?.isError) throw new Error(`${name} failed: ${text.slice(0, 400)}`);
  return parsed;
}

function show(label, value, keys) {
  console.log(`\n=== ${label} ===`);
  if (!value || typeof value !== 'object') {
    console.log(value);
    return;
  }
  for (const k of keys || Object.keys(value)) {
    const v = value[k];
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    console.log(`${k}: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`);
  }
}

async function main() {
  const mode = process.argv[2] || 'readonly';
  const promptArg = process.argv[3];
  const targetArg = process.argv[4];

  const init = await call('initialize', { protocolVersion: '2024-11-05' });
  console.log('initialize:', init.result?.serverInfo?.name, init.result?.protocolVersion);

  const list = await call('tools/list', {});
  console.log('tools:', list.result?.tools?.map(t => t.name).join(', '));

  const status = await tool('bridge_status');
  show('status', status, ['path', 'defaultBackend', 'available', 'automation', 'pending']);

  const agents = await tool('bridge_agents');
  console.log(`\n=== agents (${agents.agents.length}) ===`);
  for (const a of agents.agents) {
    console.log(` ${a.id.padEnd(12)} ${String(a.type).padEnd(12)} online=${a.online} ${a.detail || ''}`);
  }

  const target = targetArg || status.defaultBackend;
  if (!target) throw new Error('没有可用的后端');

  try {
    const models = await tool('bridge_models', { target });
    console.log(`\n=== models on ${target} (${models.models.length}) ===`);
    for (const m of models.models.slice(0, 8)) {
      console.log(` ${m.id}  ${m.label}  quota=${m.remainingQuota ?? m.quotaRemaining ?? '-'}`);
    }
    console.log(` selected: ${models.selectedModel ?? '(unset)'}`);
  } catch (err) {
    console.log(`\n=== models on ${target} ===\n(不可用: ${err.message})`);
  }

  const convs = await tool('bridge_conversations', { target, limit: 5 });
  console.log(`\n=== conversations on ${target} (${convs.total ?? 0}) ===`);
  for (const c of convs.conversations || []) {
    console.log(` ${String(c.id).slice(0, 8)}  ${String(c.title || '').slice(0, 40).padEnd(40)} ws=${(c.workspaces || []).length}`);
  }
  console.log(` selected: ${convs.selected ?? '(unset)'}`);

  if (mode === 'full') {
    const picked = await tool('bridge_select', {
      target,
      create: true,
      workspace: process.cwd(),
    });
    show('select', picked, ['backend', 'conversationId', 'created', 'model']);
  }

  if (mode === 'ask' || mode === 'full') {
    const prompt = promptArg || '用一句话说明你现在能读到哪个目录的代码。';
    console.log(`\n>>> ask ${target}: ${prompt}`);
    const answer = await tool('bridge_ask', { prompt, target, role: 'review' });
    show('ask', answer, ['backend', 'conversationId', 'status', 'model', 'reply', 'errors', 'awaitingReply']);
    if (answer.awaitingReply) {
      console.log('\n>>> 票据已记录，取回中…');
      const again = await tool('bridge_fetch', { conversationId: answer.conversationId });
      show('fetch', again, ['conversationId', 'status', 'reply', 'awaitingReply']);
    }
  }

  if (mode === 'review') {
    const report = await tool('bridge_review', {
      target,
      summary: '桥接插件已重构为多后端架构：core 抽象出 Backend 契约，Antigravity / ACP / CLI 三种适配器，'
        + 'MCP 工具改为 bridge_* 通用命名，hooks 复用同一套 session 逻辑。',
      request: '请从架构角度审查：这种以本地 RPC 或子进程直连的方式有什么风险？',
      cwd: process.cwd(),
    });
    show('review', report, ['backend', 'conversationId', 'status', 'reply', 'errors', 'awaitingReply']);
  }

  console.log('\n[ok] smoke test finished');
}

main()
  .catch((err) => {
    console.error('\n[fail]', err.message);
    if (stderr.trim()) console.error('--- server stderr ---\n' + stderr.slice(-2000));
    process.exitCode = 1;
  })
  .finally(() => {
    child.stdin.end();
    setTimeout(() => child.kill(), 1500);
  });
