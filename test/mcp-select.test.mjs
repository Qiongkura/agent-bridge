// End-to-end checks of `bridge_select` over a real MCP connection.
//
// The handler has three rules that are easy to state and easy to get wrong, each
// with a different failure mode:
//
//   * `create: true` + `model` must bind the *new* conversation, never the global
//     default — otherwise every other window silently switches model.
//   * `conversationId` + `model` must move only that thread.
//   * `conversationId` + `model: ""` must remove the binding, falling back to the
//     default; without it a binding can never be undone.
//
// Tested through the protocol rather than by calling the handler directly, because
// the bugs all lived in how the handler assembled the patch, which a unit test
// that stubs the write would not see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.mjs');

/**
 * A live MCP server over stdio, with calls issued one at a time.
 *
 * Serial on purpose: `bridge_select` writes a file, and the point here is the
 * handler's own rules, not how two concurrent writes interleave — that is covered
 * separately in config-concurrency.test.mjs.
 */
function connect() {
  const dataDir = mkdtempSync(join(tmpdir(), 'bridge-mcp-'));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ZCODE_PLUGIN_DATA: dataDir },
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('{')) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });

  let nextId = 0;
  const call = (method, params) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  return {
    dataDir,
    async init() {
      await call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
    },
    async tool(name, args) {
      const message = await call('tools/call', { name, arguments: args });
      const text = message.result?.content?.[0]?.text;
      assert.ok(text, `tool ${name} returned no content: ${JSON.stringify(message)}`);
      return JSON.parse(text);
    },
    config() {
      const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
      return {
        globalModel: raw.selections?.antigravity?.model ?? null,
        bindings: raw.conversationModels?.antigravity ?? {},
      };
    },
    close() { child.kill(); },
  };
}

test('create:true with a model binds the new conversation, not the default', async () => {
  const mcp = connect();
  try {
    await mcp.init();
    const created = await mcp.tool('bridge_select', { create: true, model: 'gemini 4 neon medium' });
    assert.ok(created.conversationId);

    const after = mcp.config();
    assert.equal(
      after.globalModel,
      null,
      'the global default must be untouched — other windows read it',
    );
    assert.equal(after.bindings[created.conversationId], 'MODEL_PLACEHOLDER_M533');
  } finally {
    mcp.close();
  }
});

test('binding a model to a conversation leaves the default alone', async () => {
  const mcp = connect();
  try {
    await mcp.init();
    await mcp.tool('bridge_select', { model: 'gemini 4 neon high' });
    const before = mcp.config();
    assert.equal(before.globalModel, 'MODEL_PLACEHOLDER_M532');

    const result = await mcp.tool('bridge_select', {
      conversationId: 'conv-A',
      model: 'gemini 3.8 flash low',
    });
    assert.equal(result.effectiveModel, 'MODEL_PLACEHOLDER_M320');

    const after = mcp.config();
    assert.equal(after.bindings['conv-A'], 'MODEL_PLACEHOLDER_M320');
    assert.equal(after.globalModel, 'MODEL_PLACEHOLDER_M532', 'the default did not move');
  } finally {
    mcp.close();
  }
});

test('an empty model removes the binding and falls back to the default', async () => {
  const mcp = connect();
  try {
    await mcp.init();
    await mcp.tool('bridge_select', { model: 'gemini 4 neon high' });
    await mcp.tool('bridge_select', { conversationId: 'conv-A', model: 'gemini 3.8 flash low' });
    assert.equal(mcp.config().bindings['conv-A'], 'MODEL_PLACEHOLDER_M320');

    const cleared = await mcp.tool('bridge_select', { conversationId: 'conv-A', model: '' });
    assert.equal(cleared.effectiveModel, 'MODEL_PLACEHOLDER_M532', 'back to the default');

    const after = mcp.config();
    assert.deepEqual(after.bindings, {}, 'the binding is gone, and no empty map is left behind');
    assert.equal(after.globalModel, 'MODEL_PLACEHOLDER_M532', 'unbinding does not change the default');
  } finally {
    mcp.close();
  }
});

test('a second conversation binding does not disturb the first', async () => {
  const mcp = connect();
  try {
    await mcp.init();
    await mcp.tool('bridge_select', { conversationId: 'conv-A', model: 'gemini 3.8 flash low' });
    await mcp.tool('bridge_select', { conversationId: 'conv-B', model: 'gemini 4 neon medium' });

    const { bindings } = mcp.config();
    assert.equal(bindings['conv-A'], 'MODEL_PLACEHOLDER_M320');
    assert.equal(bindings['conv-B'], 'MODEL_PLACEHOLDER_M533');
  } finally {
    mcp.close();
  }
});

test('a bad model name fails loudly instead of being stored', async () => {
  const mcp = connect();
  try {
    await mcp.init();
    const result = await mcp.tool('bridge_select', {
      conversationId: 'conv-A',
      model: 'definitely-not-a-model',
    }).catch(err => ({ error: err.message }));
    assert.ok(result.error, 'a typo must reject');
    assert.deepEqual(mcp.config().bindings, {}, 'nothing was written');
  } finally {
    mcp.close();
  }
});
