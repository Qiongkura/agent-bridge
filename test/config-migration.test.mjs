// v1 configs have flat top-level `model` / `autoModel`. Migration folds them
// into `selections[backend]` — but if the flat keys survive, every later
// `normalize` re-applies them over whatever the user has since set. The setting
// then reverts on every save, which looks exactly like the bridge ignoring it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalize } from '../src/core/config.mjs';

const BASE = { backends: { antigravity: { type: 'antigravity' } } };

test('a v1 flat model is still migrated when nothing else names one', () => {
  const c = normalize({ ...BASE, model: 'OLD_MODEL', autoModel: 'OLD_AUTO' });
  assert.equal(c.selections.antigravity.model, 'OLD_MODEL');
  assert.equal(c.selections.antigravity.autoModel, 'OLD_AUTO');
});

test('a v2 selection beats a leftover flat key', () => {
  // This is the configuration that produced a model the user never chose: the
  // file had been migrated once, edited under `selections`, and the stale flat
  // key was still there to overwrite the edit.
  const c = normalize({
    ...BASE,
    selections: { antigravity: { model: 'NEW_MODEL', autoModel: 'NEW_AUTO' } },
    model: 'STALE_MODEL',
    autoModel: 'STALE_AUTO',
  });

  assert.equal(c.selections.antigravity.model, 'NEW_MODEL', 'the v2 choice must win');
  assert.equal(c.selections.antigravity.autoModel, 'NEW_AUTO');
});

test('the migrated keys do not leak back out at the top level', () => {
  // A leaked top-level key is what lets the next load overwrite the edit again.
  // normalizing twice must be a fixed point.
  const once = normalize({ ...BASE, model: 'OLD', autoModel: 'OLD_AUTO' });
  const twice = normalize(once);

  assert.equal(once.model, undefined);
  assert.equal(once.autoModel, undefined);
  assert.deepEqual(twice.selections, once.selections, 'second pass changes nothing');
});

test('normalize is idempotent for a migrated config', () => {
  const raw = {
    ...BASE,
    selections: { antigravity: { model: 'KEEP' } },
    model: 'STALE',
  };
  const a = normalize(raw);
  const b = normalize(a);
  assert.equal(b.selections.antigravity.model, 'KEEP');
});

test('a v1 conversationId still migrates but does not outlive the move', () => {
  const c = normalize({ ...BASE, conversationId: 'old-conv' });
  assert.equal(c.selections.antigravity.conversationId, 'old-conv');
  assert.equal(c.conversationId, undefined);
});
