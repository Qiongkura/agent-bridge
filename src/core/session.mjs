// Session orchestration, backend-agnostic.
//
// Everything that used to be Antigravity-specific lives here in a generic form:
// pick a conversation, send, wait, shape the result. The MCP layer and the hooks
// both call this, so behaviour cannot drift between the manual and automatic
// paths.
import { BridgeError, truncate } from './contract.mjs';
import { loadBackends, resolveTarget } from './registry.mjs';
import { conversationFor, resolveModelChoice, defaultDataDir } from './config.mjs';
import { checkHop, checkLease, takeLease } from './lease.mjs';

/**
 * Who this process is, for routing and loop prevention.
 *
 * A caller name is a *role in the conversation*, not a product name: it says
 * which side of the bridge is talking, so that "auto" can rule itself out and
 * so two directions of the same pair share one loop guard.
 *
 * Resolution order: explicit argument, then the environment (set by whatever
 * launched this process), then the host's own name.
 */
export function callerIdentity(explicit) {
  const name = explicit || process.env.BRIDGE_CALLER || null;
  if (name) return sanitizeCaller(name);
  // Under ZCode the plugin's environment is present; standalone runs fall back
  // to a neutral name so a bare `bridge ask` still works.
  if (process.env.ZCODE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA) return 'zcode';
  return 'bridge';
}

function sanitizeCaller(name) {
  // The caller ends up in a lease file key and in prompts; keep it to something
  // that cannot confuse either.
  const clean = String(name).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40);
  return clean || 'bridge';
}

// An MCP host kills every tool call at ~30 s. A "send then wait 5 minutes" tool
// therefore returns nothing at all: the caller is killed before the answer
// arrives. So every waiting path is clamped under that ceiling, and when the
// answer has not arrived we return a *ticket* — a record of what is still in
// flight — which the caller redeems with a cheap follow-up call instead of
// re-sending the prompt.
export const HOST_TOOL_BUDGET_MS = 30000;
export const SOFT_WAIT_MS = 22000;

export function clampWaitMs(timeoutMs, ceilingOverride) {
  const ceiling = Math.max(3000, Number(ceilingOverride) || Number(process.env.BRIDGE_WAIT_MS) || SOFT_WAIT_MS);
  const requested = Number(timeoutMs) || ceiling;
  return Math.max(3000, Math.min(requested, ceiling));
}

export const WAIT_TIMEOUT_DESCRIPTION =
  `How long to wait (default ${Math.round(SOFT_WAIT_MS / 1000)}s, clamped below the host's `
  + '30s tool limit). On timeout the call returns a ticket instead of a reply — '
  + 'call bridge_fetch to collect the answer; do not resend.';

/**
 * Resolve which conversation to talk to on a given backend.
 *
 * The rule that matters: **never guess by looking at conversations the bridge
 * did not create.** An earlier version fell back to the newest conversation in
 * the agent (`existing[0]`) whenever the workspace did not match, which meant
 * every ZCode session on the machine poured its topic into one Antigravity
 * thread. Two unrelated projects shared one context window, and the answers got
 * worse the more you used it.
 *
 * So the order is narrow on purpose:
 *
 *   1. an explicit id from the caller
 *   2. the mapping this session (or workspace) was given earlier
 *   3. a global pin — only when there is no session and no workspace to key on
 *   4. create a new conversation
 *
 * Everything the bridge chooses is recorded in `state`, keyed by the session it
 * belongs to. Automatic choices are *never* written back to `config.selections`:
 * that file is shared by every window, so writing there would recreate exactly
 * the bug this function exists to prevent.
 */
export async function resolveConversation(backend, config, { conversationId, role, workspace, model, sessionKey, state, onStateChange }) {
  if (conversationId) return { id: conversationId, created: false };

  // What the agent still knows. Used only to *validate* a mapping we already
  // made — never to pick one. An empty list means the backend cannot enumerate
  // (CLI backends), in which case our mapping is all we have.
  let known = new Set();
  try {
    known = new Set((await backend.listConversations()).map(c => String(c.id)));
  } catch {
    known = new Set();
  }
  const alive = id => known.size === 0 || known.has(String(id));

  const backendId = backend.id;
  const normWs = workspace ? normalizePath(workspace) : null;

  // 2a. This ZCode session's own mapping.
  if (sessionKey) {
    const mapped = state?.sessionConversations?.[backendId]?.[sessionKey];
    if (mapped && alive(mapped)) {
      return { id: mapped, created: false, reused: true, source: 'session' };
    }
  }

  // 2b. A workspace mapping — but only for a caller that has no session identity
  // of its own (an MCP tool call, a script). If a sessionKey was supplied, the
  // workspace shortcut is exactly what would merge two windows on one project
  // back into a single thread, so it is skipped.
  if (normWs && !sessionKey) {
    const mapped = state?.workspaceConversations?.[backendId]?.[normWs];
    if (mapped && alive(mapped)) {
      return { id: mapped, created: false, reused: true, source: 'workspace' };
    }
  }

  // 3. A deliberate global pin, but only when there is nothing narrower to key
  // on. With a sessionKey present the pin is exactly the thing that would
  // collapse every window into one thread, so it is skipped.
  if (!sessionKey && !normWs) {
    const pinned = conversationFor(config, backendId, role);
    if (pinned && alive(pinned)) return { id: pinned, created: false, source: 'config' };
  }

  // 4. Nothing matched: make a new one and record it against this session and
  // workspace.
  const created = await backend.start({ workspace, model });
  remember(onStateChange, state, backendId, sessionKey, normWs, created.id);
  return { id: created.id, created: true };
}

// Record a mapping without touching config: state is per-install observation,
// config is the user's deliberate choice, and conflating them is what made every
// window share one conversation.
function remember(onStateChange, state, backendId, sessionKey, normWs, id) {
  if (!onStateChange) return;
  const next = { ...state };
  if (sessionKey) {
    next.sessionConversations = {
      ...(next.sessionConversations || {}),
      [backendId]: { ...((next.sessionConversations || {})[backendId] || {}), [sessionKey]: id },
    };
  }
  if (normWs) {
    next.workspaceConversations = {
      ...(next.workspaceConversations || {}),
      [backendId]: { ...((next.workspaceConversations || {})[backendId] || {}), [normWs]: id },
    };
  }
  onStateChange(next);
}

// One normalisation for workspace paths, used both to store a mapping and to
// look it up later. Two implementations would drift, and a key that is written
// one way and read another means every lookup misses — which looks exactly like
// "the mapping feature does not work".
export function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Send a prompt and wait for the answer.
 *
 * Returns `awaitingReply: true` plus a ticket when the answer did not arrive
 * inside the host's tool budget. The caller then redeems the ticket with
 * `redeem` rather than sending the prompt again.
 */
export async function converse({
  config,
  target,
  prompt,
  role,
  conversationId,
  model,
  workspace,
  timeoutMs,
  // Which host session is asking (ZCode's session_id, or any stable per-window
  // id). This is what keeps two windows from sharing one conversation: without
  // it there is nothing to distinguish them, and the safe fallback is to make a
  // new conversation rather than reuse someone else's.
  sessionKey = null,
  // How long this caller is allowed to block. Omitted means "the MCP soft
  // budget"; hooks pass their own, much larger, limit.
  ceilingMs,
  // Whether this send is automation (a hook) rather than a user request. Set
  // explicitly by the hooks. Inferring it from `role` was wrong: `bridge_review`
  // defaults to the same role the automation uses, so a manual review landed on
  // the automation model and a user who set a strong model for manual reviews
  // silently got the cheap one.
  auto = false,
  context = {},
  state = {},
  onStateChange,
  onRepair,
  // Who is asking. Set from --caller / BRIDGE_CALLER so that a ZCode-hosted
  // bridge and a Codex-invoked bridge are distinguishable, and so routing can
  // refuse to send a prompt back to the agent that wrote it.
  caller = callerIdentity(),
  // Loop guards are opt-out only for tests; the defaults are the safe ones.
  guard = true,
  leaseMs,
}) {
  const backends = loadBackends(config, context);
  const backend = await resolveTarget(backends, target || config.defaultBackend, { caller });

  if (guard) {
    const hop = checkHop({ maxHops: config?.maxHops });
    if (!hop.ok) throw new BridgeError(hop.detail, { code: hop.reason, backend: backend.id });

    // The reverse lease does not need a conversation: A→B while B is already
    // calling A is a loop no matter which threads are involved.
    const lease = checkLease({ dataDir: context.dataDir || defaultDataDir(), caller, target: backend.id, leaseMs });
    if (!lease.ok) throw new BridgeError(lease.detail, { code: lease.reason, backend: backend.id });
  }

  // Model names are backend-specific: Antigravity wants an enum, Codex wants a
  // provider id. The backend is the authority on what a given name means, so it
  // resolves the choice — "claude sonnet low" must become whatever that agent
  // calls it, or fail loudly rather than silently using its default.
  //
  // The first resolution is provisional: it is needed *before* the conversation
  // is known, because creating one requires a model. A binding on the resulting
  // conversation is applied below.
  const hint = resolveModelChoice(config, backend.id, { model, auto });
  let modelRef = hint ? await backend.resolveModel(hint) : null;

  const resolved = await resolveConversation(backend, config, {
    conversationId,
    role,
    // No `|| config.workspace` here: a global workspace from config would make
    // every window look like the same workspace, which is the other half of the
    // cross-talk bug. The caller's own cwd is the truth.
    workspace,
    model: modelRef,
    sessionKey,
    state,
    onStateChange,
  });

  // The collision check has to come after resolution: only now is it known which
  // conversation this run will write into. Two windows working in different
  // threads must be allowed to proceed in parallel.
  if (guard) {
    const lease = checkLease({
      dataDir: context.dataDir || defaultDataDir(),
      caller,
      target: backend.id,
      conversationId: resolved.id,
      leaseMs,
    });
    if (!lease.ok) throw new BridgeError(lease.detail, { code: lease.reason, backend: backend.id });
  }

  // A pin that the agent no longer knows was replaced above. Persist the repair,
  // otherwise the same stale id is tried again on the next call. Awaited because
  // the repair now goes through the serialised config write; a failure to persist
  // must not abort an exchange that already has its answer.
  if (resolved.replaced) {
    try {
      await onRepair?.({ backend: backend.id, role, stale: resolved.replaced, conversationId: resolved.id });
    } catch {
      /* best effort: the conversation still works, only the pin is stale */
    }
  }

  // Now that the conversation is known, resolve again with it in hand, using the
  // same function the user's expectations are built on. A second rule here could
  // disagree with it; one function means the documented precedence is the only
  // precedence. An explicit `model` still wins, otherwise a binding applies.
  const finalChoice = resolveModelChoice(config, backend.id, {
    conversationId: resolved.id,
    model,
    auto,
  });
  if (finalChoice && finalChoice !== hint) {
    modelRef = await backend.resolveModel(finalChoice);
  }

  // Count what already exists so wait() can tell new output from history.
  const before = await backend.read({ conversationId: resolved.id });
  const beforeIndex = (before.turns || []).length;

  // Hold the lease across the whole exchange, not just the send: the dangerous
  // window is exactly the time the peer is thinking, because that is when its
  // own turn may end and trigger a call back.
  const release = guard
    ? takeLease({
      dataDir: context.dataDir || defaultDataDir(),
      caller,
      target: backend.id,
      conversationId: resolved.id,
      leaseMs,
    })
    : () => {};

  try {
    await backend.send({
      conversationId: resolved.id,
      text: prompt,
      model: modelRef,
      workspace: workspace || config.workspace,
      timeoutMs,
    });

    // Record the ticket before waiting: if the host kills this call mid-wait, the
    // next call still knows a prompt is outstanding and where its answer starts.
    const tickets = (state.pending || []).filter(p => p.conversationId !== resolved.id);
    tickets.push({
      backend: backend.id,
      conversationId: resolved.id,
      fromIndex: beforeIndex,
      sentAt: new Date().toISOString(),
      promptChars: prompt.length,
      caller,
    });
    onStateChange?.({ ...state, pending: tickets });

    // Callers outside the host's tool budget (hooks, scripts) can wait for minutes;
    // only the MCP path is clamped. `clampWaitMs` respects an explicit ceiling for
    // that case, defaulting to the soft MCP budget when none is given.
    const waitMs = clampWaitMs(timeoutMs, ceilingMs);
    const result = await backend.wait({
      conversationId: resolved.id,
      fromIndex: beforeIndex,
      timeoutMs: waitMs,
    });

    const settled = !result.timedOut;
    onStateChange?.({
      ...state,
      pending: settled
        ? (state.pending || []).filter(p => p.conversationId !== resolved.id)
        : tickets,
      lastExchange: {
        backend: backend.id,
        conversationId: resolved.id,
        caller,
        at: new Date().toISOString(),
        promptChars: prompt.length,
        replyChars: result.reply?.text?.length || 0,
        status: result.status,
      },
    });

    return {
      ...result,
      backend: backend.id,
      caller,
      conversationId: resolved.id,
      conversationCreated: !!resolved.created,
      model: modelRef || null,
      // Explicit marker so a timeout is never mistaken for an empty answer: the
      // prompt was accepted, only the wait was cut short.
      awaitingReply: result.timedOut === true,
    };
  } finally {
    release();
  }
}

/**
 * Redeem a ticket: read a conversation that may still be producing an answer.
 *
 * `fromIndex` comes from the ticket when present. That matters — without it a
 * read would accept an *older* assistant turn as the answer to the prompt that
 * is still running.
 */
export async function redeem({
  config,
  target,
  conversationId,
  role,
  wait = true,
  timeoutMs,
  state = {},
  onStateChange,
  context = {},
  caller = callerIdentity(),
}) {
  const backends = loadBackends(config, context);
  const backend = await resolveTarget(backends, target || config.defaultBackend, { caller });

  const tickets = state.pending || [];
  const id = conversationId
    || conversationFor(config, backend.id, role)
    || tickets[tickets.length - 1]?.conversationId
    || null;

  if (!id) {
    throw new BridgeError(
      'No conversation is selected. Use bridge_conversations to list them or bridge_ask to start one.',
      { code: 'no_conversation' },
    );
  }

  const ticket = tickets.find(p => p.conversationId === id);
  const fromIndex = ticket?.fromIndex || 0;

  if (!wait && !ticket) {
    const read = await backend.read({ conversationId: id });
    return {
      backend: backend.id,
      conversationId: id,
      ...read,
      reply: (read.turns || []).filter(t => t.role === 'assistant').pop() || null,
      status: read.status || 'READ',
      awaitingReply: false,
    };
  }

  const result = await backend.wait({
    conversationId: id,
    fromIndex,
    timeoutMs: clampWaitMs(timeoutMs),
  });

  if (!result.timedOut) {
    onStateChange?.({
      ...state,
      pending: (state.pending || []).filter(p => p.conversationId !== id),
    });
  }

  return {
    ...result,
    backend: backend.id,
    conversationId: id,
    awaitingReply: result.timedOut === true,
  };
}

/**
 * Shape a reply for a tool result: keep the answer and the errors, drop the
 * noise, and never return an unbounded transcript.
 */
export function shapeReply(result, config, { sinceTurns, backendLabel } = {}) {
  const limit = Math.max(1, Number(sinceTurns) || 4);
  const maxChars = config.maxReplyChars || 12000;

  const turns = (result.turns || [])
    .slice(-limit * 2)
    .map(t => ({
      role: t.role,
      text: truncate(t.text, t.role === 'assistant' ? maxChars : 2000),
      model: t.model || undefined,
      at: t.at || undefined,
    }));

  return {
    backend: result.backend || null,
    backendLabel: backendLabel || undefined,
    conversationId: result.conversationId || null,
    conversationCreated: !!result.conversationCreated,
    status: result.status,
    timedOut: !!result.timedOut,
    model: result.model || null,
    reply: result.reply
      ? { text: truncate(result.reply.text, maxChars), model: result.reply.model, at: result.reply.at }
      : null,
    turns,
    tools: (result.tools || []).slice(-20),
    errors: result.errors || [],
  };
}
