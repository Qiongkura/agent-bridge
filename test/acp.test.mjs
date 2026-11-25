// The ACP backend is tested against a real child process speaking real
// newline-delimited JSON-RPC, because the interesting failures here are all
// protocol-level: a reversed enum, an `env` shaped like an object instead of an
// array, a notification arriving before its request resolves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpBackend, toAcpMcpServers } from '../src/backends/acp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'fake-acp-server.mjs');

function scratch() {
  return mkdtempSync(join(tmpdir(), 'bridge-acp-'));
}

function makeBackend({ logPath, reverseBridge = false, entry } = {}) {
  const args = [FIXTURE];
  if (logPath) args.push(logPath);
  return new AcpBackend(
    { id: 'fake', name: 'Fake', command: process.execPath, args, reverseBridge },
    { dataDir: scratch(), log: () => {}, reverseServer: entry ? () => entry : () => null },
  );
}

test('toAcpMcpServers emits env as an array of name/value pairs', () => {
  // Every other config format uses an object here. An agent given the object
  // shape typically starts the server with no environment, which silently loses
  // BRIDGE_CALLER and therefore attribution of callbacks.
  const [server] = toAcpMcpServers({
    name: 'agent-bridge',
    command: '/node',
    args: ['/server.mjs'],
    env: { BRIDGE_CALLER: 'codex', BRIDGE_DATA_DIR: '/d' },
  });

  assert.equal(server.name, 'agent-bridge');
  assert.deepEqual(server.args, ['/server.mjs']);
  assert.deepEqual(server.env, [
    { name: 'BRIDGE_CALLER', value: 'codex' },
    { name: 'BRIDGE_DATA_DIR', value: '/d' },
  ]);
  assert.equal(Array.isArray(server.env), true);
});

test('a session is created and a prompt round-trips', async () => {
  const backend = makeBackend();
  try {
    const conversation = await backend.start({});
    assert.equal(conversation.id, 'sess_fake_1');

    await backend.send({ conversationId: conversation.id, text: 'hello' });
    const result = await backend.wait({ conversationId: conversation.id, fromIndex: 0, timeoutMs: 10000 });

    assert.equal(result.reply?.text, 'FAKE_ACP_OK');
    assert.equal(result.timedOut, undefined);
  } finally {
    await backend.dispose();
  }
});

test('reverse bridging off sends an empty mcpServers list', async () => {
  const dir = scratch();
  const logPath = join(dir, 'sessionnew.json');
  const backend = makeBackend({ logPath });
  try {
    await backend.start({});
    const params = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.deepEqual(params.mcpServers, []);
  } finally {
    await backend.dispose();
  }
});

test('reverse bridging on hands the agent a working server entry', async () => {
  const dir = scratch();
  const logPath = join(dir, 'sessionnew.json');
  const backend = makeBackend({
    logPath,
    reverseBridge: true,
    entry: {
      name: 'agent-bridge',
      command: '/usr/bin/node',
      args: ['/bridge/src/mcp/server.mjs'],
      env: { BRIDGE_CALLER: 'fake' },
    },
  });

  try {
    await backend.start({});
    const params = JSON.parse(readFileSync(logPath, 'utf8'));

    assert.equal(params.mcpServers.length, 1);
    const [server] = params.mcpServers;
    assert.equal(server.name, 'agent-bridge');
    assert.equal(server.command, '/usr/bin/node');
    assert.deepEqual(server.args, ['/bridge/src/mcp/server.mjs'], 'stdio transport needs the entry script');
    assert.deepEqual(server.env, [{ name: 'BRIDGE_CALLER', value: 'fake' }]);
  } finally {
    await backend.dispose();
  }
});

test('reverse bridging without a resolvable entry degrades to a plain session', async () => {
  const dir = scratch();
  const logPath = join(dir, 'sessionnew.json');
  // reverseBridge is on but no entry resolved: a peer that cannot call back is
  // still worth talking to, so this must not fail the conversation.
  const backend = makeBackend({ logPath, reverseBridge: true });
  try {
    const conversation = await backend.start({});
    assert.equal(conversation.id, 'sess_fake_1');
    const params = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.deepEqual(params.mcpServers, []);
  } finally {
    await backend.dispose();
  }
});

test('dispose leaves no child process behind', async () => {
  const backend = makeBackend();
  await backend.start({});
  await backend.dispose();
  assert.equal(backend.child, null);
});
