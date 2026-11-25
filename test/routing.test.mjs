// Target resolution decides who gets asked. Two failure modes matter: asking
// yourself (no second opinion, and a loop) and picking an agent that cannot
// answer (a dead end the user has to debug).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTarget } from '../src/core/registry.mjs';

function fakeBackends(map) {
  const entries = Object.entries(map).map(([id, ok]) => [
    id,
    { id, available: async () => (ok ? { ok: true } : { ok: false, detail: 'offline' }) },
  ]);
  return new Map(entries);
}

test('an explicit target is honoured', async () => {
  const backends = fakeBackends({ a: true, b: true });
  const picked = await resolveTarget(backends, 'b', { caller: 'a' });
  assert.equal(picked.id, 'b');
});

test('an explicit self-target is refused, not silently accepted', async () => {
  const backends = fakeBackends({ a: true, b: true });
  // Accepting would produce a paraphrase and call it a second opinion, which is
  // worse than an error because the user cannot tell the difference.
  await assert.rejects(
    () => resolveTarget(backends, 'a', { caller: 'a' }),
    (err) => err.code === 'self_target',
  );
});

test('auto skips the caller', async () => {
  const backends = fakeBackends({ a: true, b: true });
  const picked = await resolveTarget(backends, 'auto', { caller: 'a' });
  assert.equal(picked.id, 'b', 'never returns the agent that asked');
});

test('auto skips unavailable backends', async () => {
  const backends = fakeBackends({ dead: false, alive: true });
  const picked = await resolveTarget(backends, 'auto', { caller: 'x' });
  assert.equal(picked.id, 'alive');
});

test('auto with only the caller available reports why instead of returning it', async () => {
  const backends = fakeBackends({ a: true });
  await assert.rejects(
    () => resolveTarget(backends, 'auto', { caller: 'a' }),
    (err) => err.code === 'none_available' && /已排除发起方/.test(err.message),
  );
});

test('random only ever returns an available, non-self backend', async () => {
  const backends = fakeBackends({ a: true, b: true, c: false });
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    seen.add((await resolveTarget(backends, 'random', { caller: 'a' })).id);
  }
  assert.deepEqual([...seen].sort(), ['b'], 'c is offline and a is the caller');
});

test('an unknown target names the configured ones', async () => {
  const backends = fakeBackends({ a: true, b: true });
  await assert.rejects(
    () => resolveTarget(backends, 'nope', { caller: 'a' }),
    (err) => err.code === 'unknown_backend' && /a, b/.test(err.message),
  );
});
