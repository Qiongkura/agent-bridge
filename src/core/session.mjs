// Session orchestration, backend-agnostic.
//
// Everything that used to be Antigravity-specific lives here in a generic form:
// pick a conversation, send, wait, shape the result. The MCP layer and the hooks
// both call this, so behaviour cannot drift between the manual and automatic
// paths.
import { BridgeError, truncate } from './contract.mjs';
import { loadBackends, resolveTarget } from './registry.mjs';
import { conversationFor, selectionFor, defaultDataDir } from './config.mjs';
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
 * Order: explicit id, the role's pinned conversation (if it belongs to this
 * backend), the backend's own sticky conversation, the newest conversation
 * already rooted at the workspace, then a new one. That last step is what makes
 * a fresh install useful without configuration.
 *
 * A pinned id is *discarded* when the backend no longer knows it — agents
 * garbage-collect old threads, and a stale pin would otherwise make every later
 * call fail with "trajectory not found". Reusing the current pin only helps if
 * it still exists.
 */
async function resolveConversation(backend, config, { conversationId, role, workspace, model }) {
  if (conversationId) return { id: conversationId, created: false };

  const existing = await backend.listConversations();
  const known = new Set(existing.map(c => String(c.id)));

  const pinned = conversationFor(config, backend.id, role);
  if (pinned && (known.size === 0 || known.has(String(pinned)))) {
    return { id: pinned, created: false };
  }

  if (existing.length) {
    const wanted = workspace ? normalizePath(workspace) : null;
    const match = wanted
      ? existing.find(c => (c.workspaces || []).some(w => normalizePath(String(w)).includes(wanted)))
      : null;
    const chosen = match || existing[0];
    return {
      id: chosen.id,
      created: false,
      reused: true,
      title: chosen.title,
      // Tell the caller the pin was stale so it can be repaired.
      replaced: pinned || null,
    };
  }

  const created = await backend.start({ workspace, model });
  return { id: created.id, created: true, replaced: pinned || null };
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
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
  // How long this caller is allowed to block. Omitted means "the MCP soft
  // budget"; hooks pass their own, much larger, limit.
  ceilingMs,
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

    const dataDir = context.dataDir || defaultDataDir();
    const lease = checkLease({ dataDir, caller, target: backend.id, leaseMs });
    if (!lease.ok) throw new BridgeError(lease.detail, { code: lease.reason, backend: backend.id });
  }

  // Model names are backend-specific: Antigravity wants an enum, Codex wants a
  // provider id. So the per-backend selection wins, and the backend itself is
  // the authority on what a given name means — "claude sonnet low" must resolve
  // to whatever that agent calls it, or fail loudly.
  const selection = selectionFor(config, backend.id);
  let modelRef = model || selection.model || null;
  if (modelRef) modelRef = await backend.resolveModel(modelRef);

  const resolved = await resolveConversation(backend, config, {
    conversationId,
    role,
    workspace: workspace || config.workspace,
    model: modelRef,
  });

  // A pin that the agent no longer knows was replaced above. Persist the repair,
  // otherwise the same stale id is tried again on the next call.
  if (resolved.replaced) {
    onRepair?.({ backend: backend.id, role, stale: resolved.replaced, conversationId: resolved.id });
  }

  // Count what already exists so wait() can tell new output from history.
  const before = await backend.read({ conversationId: resolved.id });
  const beforeIndex = (before.turns || []).length;

  // Hold the lease across the whole exchange, not just the send: the dangerous
  // window is exactly the time the peer is thinking, because that is when its
  // own turn may end and trigger a call back.
  const release = guard
    ? takeLease({ dataDir: context.dataDir || defaultDataDir(), caller, target: backend.id, leaseMs })
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
