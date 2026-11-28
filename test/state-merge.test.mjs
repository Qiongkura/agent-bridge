// State is a single file shared by every ZCode window and every hook. The
// failure mode this file guards against is quiet: an exchange takes tens of
// seconds, so each caller holds a `state` object it read before starting and
// writes the whole thing back afterwards. Without a merge, the last writer
// restores every field as it was when it *started* — undoing, among other
// things, the conversation mappings that keep two windows from sharing a thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveStateMerged, loadState, statePath } from '../src/core/config.mjs';

function scratch() {
  return { dataDir: mkdtempSync(join(tmpdir(), 'bridge-state-')) };
}

test('a stale snapshot does not undo another writer\'s mapping', () => {
  const opts = scratch();

  // Window A reads state, then starts a 40-second exchange.
  const snapshotA = loadState(opts);

  // Window B finishes first and records which conversation it is bound to.
  saveStateMerged({
    sessionConversations: { antigravity: { 'sess-B': 'conv-B' } },
  }, opts);

  // A finishes and commits everything it knew — including its stale (empty)
  // sessionConversations. Merging keeps B's entry.
  saveStateMerged({ ...snapshotA, lastExchange: { at: 'now' } }, opts);

  const after = loadState(opts);
  assert.equal(after.sessionConversations.antigravity['sess-B'], 'conv-B',
    'B\'s conversation mapping survived A\'s late write');
  assert.deepEqual(after.lastExchange, { at: 'now' });
});

test('two windows adding different sessions both survive', () => {
  const opts = scratch();

  saveStateMerged({ sessionConversations: { ag: { 'sess-A': 'conv-1' } } }, opts);
  saveStateMerged({ sessionConversations: { ag: { 'sess-B': 'conv-2' } } }, opts);

  const { sessionConversations } = loadState(opts);
  assert.deepEqual(sessionConversations.ag, { 'sess-A': 'conv-1', 'sess-B': 'conv-2' });
});

test('a writer that does not mention a key leaves it alone', () => {
  const opts = scratch();
  saveStateMerged({ sessionConversations: { ag: { s: 'c' } }, autoEnabled: true }, opts);
  saveStateMerged({ lastReview: { verdict: 'ok' } }, opts);

  const after = loadState(opts);
  assert.equal(after.autoEnabled, true);
  assert.equal(after.sessionConversations.ag.s, 'c');
});

test('pending is replaced, not merged', () => {
  // A ticket is redeemed by being absent. Merging lists would keep a redeemed
  // ticket alive and let it be fetched twice.
  const opts = scratch();
  saveStateMerged({ pending: [{ id: 'old', conversationId: 'c1' }] }, opts);
  saveStateMerged({ pending: [{ id: 'new', conversationId: 'c2' }] }, opts);

  const { pending } = loadState(opts);
  assert.deepEqual(pending.map(p => p.id), ['new']);
});

test('an explicit null clears a field', () => {
  // `undefined` means "not mentioned"; `null` is a deliberate clear, and the
  // two must not be conflated or a user can never unpin anything.
  const opts = scratch();
  saveStateMerged({ lastReview: { verdict: 'ok' } }, opts);
  saveStateMerged({ lastReview: null }, opts);
  assert.equal(loadState(opts).lastReview, null);
});

test('undefined means "not mentioned" and does not overwrite', () => {
  const opts = scratch();
  saveStateMerged({ lastReview: { verdict: 'ok' } }, opts);
  saveStateMerged({ lastReview: undefined }, opts);
  assert.deepEqual(loadState(opts).lastReview, { verdict: 'ok' });
});

test('unknown keys are preserved', () => {
  // The hooks store cooldown stamps and commit watermarks here. A whitelist
  // would silently drop them, turning "once every N minutes" into "every time".
  const opts = scratch();
  writeFileSync(statePath(opts), JSON.stringify({ lastErrorHelpAt: '2026-01-01T00:00:00Z' }));
  saveStateMerged({ lastExchange: { at: 'x' } }, opts);

  assert.equal(loadState(opts).lastErrorHelpAt, '2026-01-01T00:00:00Z');
});

test('state is written as readable JSON with a trailing newline', () => {
  const opts = scratch();
  saveStateMerged({ a: 1 }, opts);
  const raw = readFileSync(statePath(opts), 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.equal(JSON.parse(raw).a, 1);
});
