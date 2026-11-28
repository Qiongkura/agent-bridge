// A model bound to one conversation must not move any other conversation.
//
// This is the scoping guarantee, and it is easy to lose: the obvious
// implementation writes to `selections[backend].model`, which is the default for
// every thread with that agent. One "use the strong model for this review" then
// silently switches every window, and switching back is a second edit nobody
// remembers to make.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalize, resolveModelChoice, modelForConversation } from '../src/core/config.mjs';

function config(raw) {
  return normalize({
    backends: { ag: { type: 'antigravity' } },
    ...raw,
  });
}

test('a default model applies to every conversation', () => {
  const c = config({ selections: { ag: { model: 'DEFAULT' } } });
  assert.equal(resolveModelChoice(c, 'ag', {}), 'DEFAULT');
  assert.equal(resolveModelChoice(c, 'ag', { conversationId: 'conv-1' }), 'DEFAULT');
  assert.equal(resolveModelChoice(c, 'ag', { conversationId: 'conv-2' }), 'DEFAULT');
});

test('a conversation binding overrides the default for that thread only', () => {
  const c = config({
    selections: { ag: { model: 'DEFAULT' } },
    conversationModels: { ag: { 'conv-special': 'NEON_MEDIUM' } },
  });

  assert.equal(resolveModelChoice(c, 'ag', { conversationId: 'conv-special' }), 'NEON_MEDIUM');
  // Every other thread is untouched. This is the whole point.
  assert.equal(resolveModelChoice(c, 'ag', { conversationId: 'conv-other' }), 'DEFAULT');
  assert.equal(resolveModelChoice(c, 'ag', {}), 'DEFAULT');
});

test('an explicit argument outranks a binding for that one call', () => {
  // The narrower decision wins: a binding is the standing default for a thread,
  // an argument is a decision about this call. The reverse order silently ignored
  // one-off overrides on a bound thread, and it was never needed — the hooks pass
  // no model at all, so they always fall through to the binding.
  const c = config({
    selections: { ag: { model: 'DEFAULT' } },
    conversationModels: { ag: { 'conv-review': 'NEON_MEDIUM' } },
  });

  assert.equal(
    resolveModelChoice(c, 'ag', { conversationId: 'conv-review', model: 'OVERRIDE' }),
    'OVERRIDE',
  );
  // Without an argument the binding still applies, which is what makes it stick.
  assert.equal(
    resolveModelChoice(c, 'ag', { conversationId: 'conv-review' }),
    'NEON_MEDIUM',
  );
});

test('an explicit argument still beats the default for a one-off', () => {
  const c = config({ selections: { ag: { model: 'DEFAULT' } } });
  assert.equal(resolveModelChoice(c, 'ag', { conversationId: 'conv-1', model: 'STRONG' }), 'STRONG');
});

test('automation prefers autoModel over model', () => {
  const c = config({ selections: { ag: { model: 'INTERACTIVE', autoModel: 'AUTO' } } });
  assert.equal(resolveModelChoice(c, 'ag', { auto: true }), 'AUTO');
  assert.equal(resolveModelChoice(c, 'ag', {}), 'INTERACTIVE');
  // A conversation binding is not a default: automation respects it too.
  const bound = config({
    selections: { ag: { model: 'INTERACTIVE', autoModel: 'AUTO' } },
    conversationModels: { ag: { c1: 'BOUND' } },
  });
  assert.equal(resolveModelChoice(bound, 'ag', { conversationId: 'c1', auto: true }), 'BOUND');
});

test('a binding is per backend, so an id reused by another agent is separate', () => {
  const c = config({
    backends: { ag: { type: 'antigravity' }, cx: { type: 'cli', command: 'x' } },
    conversationModels: { ag: { shared: 'NEON' } },
  });
  assert.equal(modelForConversation(c, 'ag', 'shared'), 'NEON');
  assert.equal(modelForConversation(c, 'cx', 'shared'), null);
});

test('no model configured anywhere yields null rather than a wrong guess', () => {
  // null means "let the agent use its own default". Inventing one here would
  // send a model id the agent may not recognise.
  assert.equal(resolveModelChoice(config({}), 'ag', {}), null);
});

test('a malformed binding is dropped instead of breaking every send', () => {
  const c = config({
    conversationModels: {
      ag: { good: 'M1', empty: '', obj: { nested: true }, num: 7 },
      broken: 'not-an-object',
      arr: ['nope'],
    },
  });
  assert.deepEqual(c.conversationModels.ag, { good: 'M1' });
  assert.equal(c.conversationModels.broken, undefined);
  assert.equal(c.conversationModels.arr, undefined);
});

test('a manual review does not silently borrow the automation model', () => {
  // `bridge_review` defaults to role "review", the same role the stop hook uses.
  // Inferring "is automation" from the role meant a user who set a strong model
  // for manual reviews got the cheap automation one instead.
  const c = config({ selections: { ag: { model: 'STRONG', autoModel: 'CHEAP' } } });
  assert.equal(resolveModelChoice(c, 'ag', { auto: false }), 'STRONG');
  assert.equal(resolveModelChoice(c, 'ag', { auto: true }), 'CHEAP');
});
