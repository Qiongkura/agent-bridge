// The CLI backend's placeholder handling is the most dangerous code in the
// project, because every way it can go wrong is silent: the process still runs,
// still exits 0, and still returns text — just not an answer to your question.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildInvocation } from '../src/backends/cli.mjs';

test('a {prompt} placeholder is replaced in place, keeping flag order', () => {
  const { args, useStdin } = buildInvocation(
    { args: ['--prompt', '{prompt}', '--json'] },
    { text: 'hello' },
  );
  assert.deepEqual(args, ['--prompt', 'hello', '--json']);
  assert.equal(useStdin, false, 'the prompt was delivered as an argument');
});

test('a template without {prompt} falls back to stdin', () => {
  const { args, useStdin } = buildInvocation({ args: ['exec', '-s', 'read-only'] }, { text: 'hi' });
  assert.deepEqual(args, ['exec', '-s', 'read-only']);
  assert.equal(useStdin, true);
});

test('stdin:false with no placeholder still uses stdin rather than losing the prompt', () => {
  // There is nowhere else to put it. Dropping it would run the agent on nothing.
  const { useStdin } = buildInvocation({ args: ['run'] }, { text: 'hi' });
  assert.equal(useStdin, true);
});

test('an explicit stdin:true wins even when a placeholder exists', () => {
  const { args, useStdin } = buildInvocation(
    { args: ['--prompt', '{prompt}'], stdin: true },
    { text: 'hello' },
  );
  assert.equal(useStdin, true);
  // The placeholder is left alone rather than blanked: passing `--prompt ""`
  // alongside stdin makes some CLIs read the empty flag and ignore stdin.
  assert.deepEqual(args, ['--prompt', '{prompt}']);
});

test('multiple placeholders are all replaced', () => {
  const { args } = buildInvocation({ args: ['{prompt}', '-p', '{prompt}'] }, { text: 'x' });
  assert.deepEqual(args, ['x', '-p', 'x']);
});

test('modelArg is appended in its own template', () => {
  const { args } = buildInvocation(
    { args: ['exec'], modelArg: ['-m', '{model}'] },
    { text: 'hi', model: 'gpt-x' },
  );
  assert.deepEqual(args, ['exec', '-m', 'gpt-x']);
});

test('defaultArgs apply only when no model was asked for', () => {
  const withModel = buildInvocation({ args: [], defaultArgs: ['--fast'], modelArg: ['-m', '{model}'] },
    { text: 'hi', model: 'm' });
  assert.deepEqual(withModel.args, ['-m', 'm']);

  const withoutModel = buildInvocation({ args: [], defaultArgs: ['--fast'] }, { text: 'hi' });
  assert.deepEqual(withoutModel.args, ['--fast']);
});

test('the options object is not mutated', () => {
  const opts = { args: ['--prompt', '{prompt}'] };
  buildInvocation(opts, { text: 'hello' });
  assert.deepEqual(opts.args, ['--prompt', '{prompt}'], 'a backend instance is reused across calls');
});
