// Cross-talk is the bug this suite exists for: two ZCode windows asking about
// two unrelated projects ended up sharing one Antigravity conversation, so both
// topics landed in one context window. Every test here fails if that comes back.
//
// These call `resolveConversation` directly. Going through `converse` would also
// exercise routing, leases and the backend registry — each already tested
// elsewhere — and would obscure which function is actually responsible.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConversation, normalizePath } from '../src/core/session.mjs';

/**
 * A backend that remembers its conversations.
 *
 * `existing` seeds what the agent "already knows", i.e. what a real agent's
 * listConversations returns. The resolver is allowed to use that list to
 * validate a mapping it already has — but never to pick one, which is what the
 * original code did and what merged every window into one thread.
 */
function fakeBackend({ existing = [] } = {}) {
  let counter = 0;
  const created = [];
  const conversations = existing.map(id => ({ id, workspaces: [] }));

  return {
    id: 'fake',
    created,
    conversations,
    async listConversations() { return conversations.map(c => ({ ...c })); },
    async start({ workspace } = {}) {
      counter += 1;
      const id = `new-${counter}`;
      conversations.push({ id, workspaces: workspace ? [workspace] : [] });
      created.push({ id, workspace });
      return { backend: 'fake', id, workspaces: workspace ? [workspace] : [] };
    },
  };
}

const EMPTY_CONFIG = { selections: {}, roles: {} };

// Resolve once, applying whatever the resolver recorded so the next call sees it
// — the same way the real callers persist through onStateChange.
async function resolve(backend, { state = {}, config = EMPTY_CONFIG, sessionKey = null, workspace = null, conversationId = null } = {}) {
  let merged = state;
  const result = await resolveConversation(backend, config, {
    conversationId,
    role: null,
    workspace,
    model: null,
    sessionKey,
    state,
    onStateChange: (next) => { merged = next; },
  });
  return { ...result, state: merged };
}

test('two sessions never share a conversation, even in one workspace', async () => {
  const backend = fakeBackend();
  // Same workspace is the hardest case: a workspace mapping is a legitimate
  // shortcut for a script, so it must not outrank a session's own identity.
  const ws = 'I:\\projects\\app';

  const a = await resolve(backend, { workspace: ws, sessionKey: 'sess-A' });
  const b = await resolve(backend, { workspace: ws, sessionKey: 'sess-B', state: a.state });

  assert.notEqual(b.id, a.id, 'two windows on one project must not share a thread');
  assert.equal(backend.created.length, 2, 'each session got its own conversation');
});

test('the same session reuses its conversation across turns', async () => {
  const backend = fakeBackend();
  const first = await resolve(backend, { workspace: 'I:\\p', sessionKey: 'sess-A' });
  const second = await resolve(backend, { workspace: 'I:\\p', sessionKey: 'sess-A', state: first.state });

  assert.equal(second.id, first.id);
  assert.equal(backend.created.length, 1, 'a second turn must not spawn a new thread');
});

test('sessions in different workspaces stay apart', async () => {
  const backend = fakeBackend();
  const a = await resolve(backend, { workspace: 'I:\\alpha', sessionKey: 'sess-A' });
  const b = await resolve(backend, { workspace: 'I:\\beta', sessionKey: 'sess-B', state: a.state });

  assert.notEqual(a.id, b.id, 'two projects must not share one conversation');
  assert.equal(backend.created.length, 2);
});

test('pre-existing agent conversations are never adopted by guesswork', async () => {
  // The original bug, exactly: with conversations already in the agent, a fresh
  // session was handed `existing[0]` — someone else's thread.
  const backend = fakeBackend({ existing: ['someone-elses-1', 'someone-elses-2'] });
  const result = await resolve(backend, { workspace: 'I:\\fresh', sessionKey: 'sess-new' });

  assert.ok(!['someone-elses-1', 'someone-elses-2'].includes(result.id),
    'must create a new conversation rather than reuse an unrelated one');
  assert.equal(backend.created.length, 1);
});

test('a workspace mapping is keyed exactly, not by substring', async () => {
  const backend = fakeBackend();
  const parent = await resolve(backend, { workspace: 'I:\\projects', sessionKey: 'sess-parent' });
  const child = await resolve(backend, {
    workspace: 'I:\\projects\\marble',
    sessionKey: 'sess-child',
    state: parent.state,
  });

  // `I:\projects` must not adopt `I:\projects\marble`'s thread, and a substring
  // test gets this wrong in both directions.
  assert.notEqual(child.id, parent.id);
  assert.equal(backend.created.length, 2);
});

test('trailing separators and case do not defeat the mapping', () => {
  assert.equal(normalizePath('I:\\Projects\\App\\'), normalizePath('i:/projects/app'));
  assert.notEqual(normalizePath('I:\\projects'), normalizePath('I:\\projects\\marble'));
});

test('a stale mapping is discarded rather than used', async () => {
  // The agent garbage-collected the thread. Reusing the id would make every
  // later call fail with "trajectory not found".
  const backend = fakeBackend({ existing: ['still-here'] });
  const stale = { sessionConversations: { fake: { 'sess-A': 'gone' } } };

  const result = await resolve(backend, { sessionKey: 'sess-A', workspace: 'I:\\p', state: stale });

  assert.notEqual(result.id, 'gone');
  assert.equal(backend.created.length, 1);
});

test('an explicit conversationId always wins', async () => {
  const backend = fakeBackend({ existing: ['explicit-one'] });
  const result = await resolve(backend, {
    conversationId: 'explicit-one',
    sessionKey: 'sess-A',
    workspace: 'I:\\p',
  });

  assert.equal(result.id, 'explicit-one');
  assert.equal(backend.created.length, 0);
});

test('automatic choices are recorded in state, not in config', async () => {
  const backend = fakeBackend();
  const { state } = await resolve(backend, { sessionKey: 'sess-A', workspace: 'I:\\p' });

  assert.equal(state.sessionConversations.fake['sess-A'], 'new-1');
  assert.equal(state.workspaceConversations.fake[normalizePath('I:\\p')], 'new-1');
  // config.selections is shared by every window; writing there is precisely how
  // all windows ended up merged into one thread.
  assert.equal(state.selections, undefined);
});

test('a config pin applies only when there is no session or workspace', async () => {
  const backend = fakeBackend({ existing: ['pinned'] });
  const config = { selections: { fake: { conversationId: 'pinned' } }, roles: {} };

  // With a pin and nothing narrower, the pin is the user's deliberate choice.
  const withPin = await resolve(backend, { config });
  assert.equal(withPin.id, 'pinned');

  // With a session, the pin must be ignored: honouring it would collapse every
  // window back into one conversation, which is the bug.
  const withSession = await resolve(backend, { config, sessionKey: 'sess-A', workspace: 'I:\\p' });
  assert.notEqual(withSession.id, 'pinned');
  assert.equal(backend.created.length, 1);
});
