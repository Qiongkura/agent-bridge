// The truncation bug: a model that says "let me check the file" before calling a
// tool looks identical, on the wire, to a model that has finished answering.
// The only thing that separates them is the trajectory status. Getting this
// wrong does not error out — it silently returns a sentence fragment as the
// review, which is worse, because it looks like the peer had nothing to say.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { turnSettled } from '../src/backends/antigravity.mjs';

const assistant = (text) => ({ role: 'assistant', text });
const user = (text) => ({ role: 'user', text });

const fresh = (turns = [], errors = []) => ({ turns, errors, tools: [] });

test('interim text while busy is not an answer', () => {
  // Exactly the failing shape: the first poll sees RUNNING plus a preamble.
  const verdict = turnSettled({
    busy: true,
    fresh: fresh([user('review this'), assistant('Let me look at the file.')]),
    status: 'CASCADE_RUN_STATUS_RUNNING',
  });

  assert.equal(verdict.done, false, 'must keep polling rather than return the preamble');
});

test('the same text becomes an answer once the run goes idle', () => {
  const verdict = turnSettled({
    busy: false,
    fresh: fresh([user('review this'), assistant('The loop leaks a handle.')]),
    status: 'CASCADE_RUN_STATUS_IDLE',
  });

  assert.equal(verdict.done, true);
  assert.equal(verdict.reply.text, 'The loop leaks a handle.');
  assert.equal(verdict.status, 'CASCADE_RUN_STATUS_IDLE');
});

test('a busy run with no text is not finished', () => {
  const verdict = turnSettled({ busy: true, fresh: fresh([user('go')]), status: 'CASCADE_RUN_STATUS_RUNNING' });
  assert.equal(verdict.done, false);
});

test('an idle run with no answer yet is not finished', () => {
  // The race between accepting a prompt and the planner producing a turn.
  const verdict = turnSettled({ busy: false, fresh: fresh([user('go')]), status: 'CASCADE_RUN_STATUS_IDLE' });
  assert.equal(verdict.done, false);
});

test('the newest assistant turn wins, not the first', () => {
  const verdict = turnSettled({
    busy: false,
    fresh: fresh([assistant('first draft'), assistant('final answer')]),
    status: 'IDLE',
  });
  assert.equal(verdict.reply.text, 'final answer');
});

test('an errored turn ends the wait instead of burning the timeout', () => {
  // An errored cascade never reports busy, so "wait for !busy" alone would spin
  // until the deadline and then report TIMEOUT — hiding the real cause.
  const verdict = turnSettled({
    busy: false,
    fresh: fresh([user('go')], [{ message: 'model overloaded', stepIndex: 1 }]),
    status: 'CASCADE_RUN_STATUS_IDLE',
  });

  assert.equal(verdict.done, true);
  assert.equal(verdict.reply, null, 'no answer to give');
  assert.equal(verdict.status, 'CASCADE_RUN_STATUS_IDLE');
});

test('an answer plus a cascaded error still returns the answer', () => {
  // Partial success is the common case: the agent answered but a tool call in
  // the middle failed. The text is still worth returning.
  const verdict = turnSettled({
    busy: false,
    fresh: fresh([assistant('It works, though the build warned.')], [{ message: 'non-zero exit', stepIndex: 1 }]),
    status: 'IDLE',
  });
  assert.equal(verdict.done, true);
  assert.equal(verdict.reply.text, 'It works, though the build warned.');
});

test('a missing status field is treated as idle rather than busy', () => {
  // GetCascadeTrajectory can omit status; refusing to answer on a missing field
  // would hang the bridge on a protocol detail.
  const verdict = turnSettled({
    busy: false,
    fresh: fresh([assistant('done')]),
    status: undefined,
  });
  assert.equal(verdict.done, true);
  assert.equal(verdict.status, 'IDLE');
});
