// Config is one file shared by every window, and each MCP server process used to
// keep its own copy and rewrite the whole thing. Two windows editing config was a
// guaranteed lost update: the second write came from a snapshot taken before the
// first, so it restored the first window's old values. The symptom is a binding
// (or a role, or an automation flag) that exists and then quietly disappears.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { updateConfig, loadConfig, resolveModelChoice } from '../src/core/config.mjs';

function scratch() {
  const dataDir = mkdtempSync(join(tmpdir(), 'bridge-config-'));
  // Seed a config so updateConfig has somewhere to work.
  loadConfig({ dataDir });
  return { dataDir };
}

const bind = (backendId, conversationId, model) => (fresh) => ({
  conversationModels: {
    ...(fresh.conversationModels || {}),
    [backendId]: {
      ...((fresh.conversationModels || {})[backendId] || {}),
      [conversationId]: model,
    },
  },
});

test('two writers binding different conversations both survive', async () => {
  const opts = scratch();

  // "Window A and window B each read the config, then write." With a snapshot
  // handed in by each caller, B's write would drop A's binding.
  await updateConfig(bind('ag', 'conv-A', 'MODEL_A'), opts);
  await updateConfig(bind('ag', 'conv-B', 'MODEL_B'), opts);

  const { config } = loadConfig(opts);
  assert.equal(config.conversationModels.ag['conv-A'], 'MODEL_A');
  assert.equal(config.conversationModels.ag['conv-B'], 'MODEL_B');
});

test('a later write against another key does not drop earlier bindings', async () => {
  const opts = scratch();
  await updateConfig(bind('ag', 'conv-A', 'MODEL_A'), opts);
  // A different concern entirely — an automation toggle.
  await updateConfig(fresh => ({ auto: { ...fresh.auto, onStop: false } }), opts);

  const { config } = loadConfig(opts);
  assert.equal(config.conversationModels.ag['conv-A'], 'MODEL_A');
  assert.equal(config.auto.onStop, false);
});

test('updateConfig sees changes made since the caller last read', async () => {
  const opts = scratch();
  // This is the property the old cached-config approach lacked: the callback
  // receives what is on disk now, not what the process loaded at startup.
  await updateConfig(bind('ag', 'conv-A', 'FIRST'), opts);

  let observed = null;
  await updateConfig((fresh) => {
    observed = fresh.conversationModels?.ag?.['conv-A'] ?? null;
    return {};
  }, opts);

  assert.equal(observed, 'FIRST', 'the second write saw the first');
});

test('a binding written by one writer is visible to the next reader', async () => {
  const opts = scratch();
  await updateConfig(bind('ag', 'conv-1', 'NEON'), opts);

  const { config } = loadConfig(opts);
  assert.equal(resolveModelChoice(config, 'ag', { conversationId: 'conv-1' }), 'NEON');
  // And it did not leak into the default.
  assert.equal(
    resolveModelChoice(config, 'ag', { conversationId: 'conv-2' }),
    null,
    'the default is still unset',
  );
});

test('removing the last binding drops the backend entry rather than leaving {}', async () => {
  // An empty map reads back as "there are bindings here", which is confusing in
  // the config and in every tool response that echoes it.
  const opts = scratch();
  await updateConfig(bind('ag', 'conv-1', 'X'), opts);

  await updateConfig((fresh) => {
    const all = { ...(fresh.conversationModels || {}) };
    const inner = { ...(all.ag || {}) };
    delete inner['conv-1'];
    if (Object.keys(inner).length) all.ag = inner;
    else delete all.ag;
    return { conversationModels: all };
  }, opts);

  const { config } = loadConfig(opts);
  assert.equal(config.conversationModels.ag, undefined);
});
