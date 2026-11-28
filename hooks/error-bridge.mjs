#!/usr/bin/env node
// PostToolUseFailure hook: when a tool fails, optionally ask the peer agent what
// to do and inject the answer as context.
//
// Unlike the Stop hook this one must never block and never take long: the host
// is mid-turn and the user is waiting. So we send, wait a short bounded time,
// and inject whatever came back as additionalContext. Failures stay silent.
import { buildErrorPrompt } from '../src/core/brief.mjs';
import { converse } from '../src/core/session.mjs';
import {
  CALLER, CONTEXT, configuration, state, commitState, autoBackend, backendLabel, log, quiet, readInput, repairPin, releaseBackends,
} from './_shared.mjs';

async function main() {
  const input = await readInput();
  if (!input) return quiet();

  const config = configuration();
  if (config.auto.onError !== true) return quiet();

  const toolName = input.tool_name || 'unknown';
  const errorText = String(input.error || input.error_details || '').trim();

  // Repeated failures on the same tool would spam the peer and the context.
  const current = state();
  const lastAt = Date.parse(current.lastErrorHelpAt || '') || 0;
  if (Date.now() - lastAt < config.auto.errorCooldownMs) {
    log('cooldown active');
    return quiet();
  }

  const cwd = input.cwd || process.cwd();
  const sessionKey = input.session_id || null;
  const backend = await autoBackend(config);
  if (!backend) {
    log('no backend available');
    return quiet();
  }

  const prompt = buildErrorPrompt({
    tool: toolName,
    error: errorText.slice(0, 4000) || '(没有错误输出)',
    cwd,
    recent: `工具参数：${JSON.stringify(input.tool_input || {}).slice(0, 2000)}`,
    peer: backendLabel(backend),
    requester: CALLER,
  });

  let result;
  try {
    result = await converse({
      config,
      target: backend.id,
      prompt,
      role: config.auto.role,
      // Automation, explicitly, so `autoModel` is chosen rather than the
      // interactive model. A model bound to this window's conversation still
      // outranks both.
      auto: true,
      workspace: cwd,
      sessionKey,
      // Short leash: the user is waiting on the failed tool call, so we take the
      // first answer that arrives inside this window.
      timeoutMs: config.auto.errorTimeoutMs,
      ceilingMs: config.auto.errorTimeoutMs,
      context: CONTEXT,
      state: current,
      caller: CALLER,
      onStateChange: (next) => commitState(next),
      onRepair: repairPin,
    });
  } catch (err) {
    log(`converse failed: ${err.message}`);
    return quiet();
  }

  // Stamp the cooldown even when no answer arrived: the point is to stop a
  // failing tool from triggering a request per failure.
  commitState({ ...state(), lastErrorHelpAt: new Date().toISOString() });

  const text = result.reply?.text;
  if (!text) {
    log(`no reply (${result.status}${result.timedOut ? ', timed out' : ''})`);
    return quiet();
  }

  log(`helped on ${toolName}`);
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: [
        `${backendLabel(backend)} 对刚才 \`${toolName}\` 失败的分析与建议：`,
        '',
        text,
      ].join('\n'),
    },
  })}\n`);
}

main()
  .catch((err) => {
    log(`fatal: ${err?.stack || err}`);
  })
  // Always release child processes, even on the success path where main()
  // simply returns after writing its context. Without this an ACP agent keeps
  // the event loop alive and the hook hangs until the host kills it.
  .finally(() => {
    releaseBackends();
    // A hook must always end. Once the decision is written there is nothing left
    // to wait for, and a lingering handle would hold the host's turn open.
    process.exit(0);
  });
