#!/usr/bin/env node
// Stop hook: when a turn ends, optionally forward a brief to another agent,
// wait for its analysis, and hand that analysis back as the reason to keep
// going.
//
// The contract (verified against ZCode's hook runner):
//   stdin  -> {session_id, cwd, last_assistant_message, stop_hook_active, ...}
//   stdout -> {decision: "block", reason, ...} keeps the turn alive with `reason`
//             added as context; {} or no output lets the turn end normally.
//
// Guard rails matter more than features here: a Stop hook that always blocks
// would spin forever, so we bail on `stop_hook_active`, on a missing opt-in, on
// a too-short message, and on any error. Every one of those exits 0 with no
// output, which the host reads as "nothing to add".
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildAutoPrompt } from '../src/core/brief.mjs';
import { converse } from '../src/core/session.mjs';
import {
  CONTEXT, configuration, state, commitState, autoBackend, backendLabel, log, quiet,
  readInput, readToolTrail, hash, repairPin, releaseBackends,
} from './_shared.mjs';

async function main() {
  const input = await readInput();
  if (!input) return quiet();

  // Already inside a hook-driven continuation: stop, or the turn never ends.
  if (input.stop_hook_active) {
    log('stop_hook_active -> skip');
    return quiet();
  }

  const config = configuration();
  if (config.auto.onStop !== true) return quiet();

  const last = String(input.last_assistant_message || '').trim();
  // Greetings and short acknowledgements are not worth a round trip. Weigh the
  // text instead of counting raw characters: one CJK codepoint carries about as
  // much as two Latin ones, so a 65-character Chinese paragraph is substantial
  // while a 65-character English "ok, done, moving on" is not.
  const weight = messageWeight(last);
  if (weight < config.auto.minResponseChars) {
    log(`skip: short message (weight ${weight}/${config.auto.minResponseChars})`);
    return quiet();
  }

  const cwd = input.cwd || config.workspace || process.cwd();
  const sessionKey = input.session_id || 'unknown';
  const current = state();

  // Only forward a given turn once, even if the hook is retried.
  const fingerprint = `${sessionKey}:${hash(last)}`;
  if (current.lastForwarded?.[sessionKey] === fingerprint) {
    log('skip: duplicate turn');
    return quiet();
  }

  // The transcript file the host writes is cumulative, so only records after the
  // last genuine user message belong to this turn.
  const toolTrail = readToolTrail(input.transcript_path);

  // ---------------------------------------------------------- is it big?
  // Reviewing every turn is what made this bridge a progress tax: a variable
  // rename would come back as three paragraphs. A turn is worth a round trip
  // only when it lands something structural. Three independent signals, any one
  // qualifies:
  //
  //   A. a new git commit appeared during this turn (a milestone by definition)
  //   B. this turn edited enough files (default 3) to be more than a touch-up
  //   C. the message asks for it explicitly with [[review]]
  //
  // Config knob: auto.minEdits. Set it to 0 to review everything again.
  const editCount = countFileEdits(input.transcript_path);
  const head = headSha(cwd);
  const prevHead = current.lastSeenCommit?.[sessionKey] || null;
  const newCommit = Boolean(head && prevHead && head !== prevHead);
  const forced = /\[\[\s*(review|agy|antigravity)\s*\]\]/i.test(last);
  const minEdits = Number(config.auto.minEdits ?? 3);

  if (!(forced || newCommit || editCount >= minEdits)) {
    log(`skip: small change (edits=${editCount}/${minEdits}, newCommit=${newCommit})`);
    rememberHead(sessionKey, head, prevHead);
    return quiet();
  }
  if (newCommit) log(`big change: new commit ${prevHead.slice(0, 8)} -> ${head.slice(0, 8)}`);
  else if (forced) log('big change: explicit [[review]] marker');
  else log(`big change: ${editCount} file edits`);

  const backend = await autoBackend(config);
  if (!backend) {
    log('no backend available');
    return quiet();
  }

  const prompt = buildAutoPrompt({
    lastMessage: last,
    cwd,
    review: config.auto.reviewOnStop,
    sessionTitle: input.session_title || '',
    toolTrail,
    peer: backendLabel(backend),
    requester: 'ZCode',
  });

  let result;
  try {
    // The hook runs outside the host's 30s tool budget, so it may legitimately
    // wait minutes here. A failure still must not break the turn.
    result = await converse({
      config,
      target: backend.id,
      prompt,
      role: config.auto.role,
      model: config.autoModel || config.model,
      workspace: cwd,
      timeoutMs: config.auto.timeoutMs,
      // A hook is not bound by the host's 30s tool budget, so it may legitimately
      // wait minutes for a real review.
      ceilingMs: config.auto.timeoutMs,
      context: CONTEXT,
      state: current,
      onStateChange: (next) => commitState(next),
      onRepair: repairPin,
    });
  } catch (err) {
    log(`converse failed: ${err.message}`);
    return quiet();
  }

  commitState({
    ...state(),
    lastForwarded: { ...(current.lastForwarded || {}), [sessionKey]: fingerprint },
    // Advance the commit watermark on the success path too. Leaving it behind
    // means the *same* commit keeps satisfying `head !== prevHead` forever, so
    // every later turn would be "a new commit happened" and the gate collapses
    // back into review-every-turn — the exact behaviour this filter exists to
    // stop.
    ...(head ? { lastSeenCommit: { ...(current.lastSeenCommit || {}), [sessionKey]: head } } : {}),
  });

  const text = result.reply?.text;
  if (!text) {
    log(`no reply (status ${result.status}${result.timedOut ? ', timed out' : ''})`);
    return quiet();
  }

  log(`forwarded ok (${text.length} chars)`);

  commitState({
    ...state(),
    lastReview: {
      backend: backend.id,
      conversationId: result.conversationId,
      at: new Date().toISOString(),
      text,
    },
  });

  // The prompt tells the reviewer to answer exactly `NO_ACTION: <reason>` when
  // there is nothing worth saying. Waking the turn for that would burn a whole
  // extra turn on "the reviewer had no comment", which is the opposite of the
  // point. Record it and stay silent.
  if (/^\s*NO_ACTION\b/i.test(text)) {
    log('reply NO_ACTION -> quiet');
    return quiet();
  }

  // Continuation is the default because the whole point is "hand me the next
  // step and keep going". Turn it off to use the bridge as a passive second
  // opinion instead: the review is stored and readable via bridge_fetch.
  if (config.auto.continueAfterReview === false) {
    log('continueAfterReview=false -> stored only');
    return quiet();
  }

  // decision:"block" is the documented way to keep a stopped turn alive: the
  // reason is injected and the agent continues. systemMessage keeps it visible
  // in the transcript so the user can see who said what.
  process.stdout.write(`${JSON.stringify({
    decision: 'block',
    reason: [
      `${backendLabel(backend)} 审查了刚才的工作，以下是它的分析与下一步。请据此继续执行；`,
      '如果它的建议与当前任务无关或明显错误，说明原因后忽略。',
      '',
      text,
    ].join('\n'),
    systemMessage:
      `已通过桥接取得 ${backendLabel(backend)} 的审查意见（对话 ${String(result.conversationId).slice(0, 8)}）。`,
  })}\n`);
}

// Rough measure of how much a message says. Latin text counts per character;
// CJK counts double, because a hundred Chinese characters is a full report while
// a hundred Latin ones is one sentence.
function messageWeight(text) {
  let weight = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    // CJK Unified Ideographs, Hiragana/Katakana, Hangul, and fullwidth forms.
    const cjk = (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af);
    weight += cjk ? 2 : 1;
  }
  return weight;
}

// How many distinct files this *turn* actually touched, not the whole session.
//
// The transcript is a cumulative JSONL (the live one can be tens of MB), so
// counting every edit in the file would mean: once the session has touched 3
// files, every later turn looks like "3 files edited" forever. Only records
// after the last genuine user message belong to this turn. A file with no user
// message at all is treated as single-turn and scanned whole, which is the old
// behaviour and is correct for that shape.
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/i;

function isRealUserRecord(rec) {
  const role = rec?.message?.role || rec?.role;
  if (role !== 'user') return false;
  const content = rec?.message?.content || rec?.content || [];
  // A `tool_result` also arrives with role=user; it is still the same turn.
  if (Array.isArray(content)) {
    const hasToolResult = content.some(i => i?.type === 'tool_result');
    if (hasToolResult) return false;
    return content.some(i => i?.type === 'text' && String(i.text || '').trim());
  }
  return typeof content === 'string' && content.trim().length > 0;
}

function countFileEdits(transcriptPath) {
  if (!transcriptPath) return 0;
  try {
    if (!existsSync(transcriptPath)) return 0;
    const lines = readFileSync(transcriptPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);

    // Parse once, reuse for both the boundary search and the edit scan.
    const recs = [];
    for (const line of lines) {
      try { recs.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }

    let start = 0;
    for (let i = recs.length - 1; i >= 0; i -= 1) {
      if (isRealUserRecord(recs[i])) { start = i + 1; break; }
    }

    const paths = new Set();
    for (let i = start; i < recs.length; i += 1) {
      const content = recs[i]?.message?.content || recs[i]?.content || [];
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (item?.type !== 'tool_use') continue;
        if (!WRITE_TOOLS.test(String(item.name || ''))) continue;
        const p = item.input?.file_path || item.input?.path || item.input?.notebook_path;
        if (p) paths.add(String(p));
      }
    }
    return paths.size;
  } catch {
    return 0;
  }
}

// The current HEAD of the workspace, or null when it is not a git repo. A new
// commit appearing between two turns is the clearest "something landed" signal.
function headSha(cwd) {
  if (!cwd) return null;
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Record the HEAD we saw so the *next* turn can tell whether a commit landed.
// When there is no previous HEAD (first turn in a repo), adopt the current one
// silently: counting the whole history as "new" would fire on turn one.
function rememberHead(sessionKey, head, prevHead) {
  if (!head || prevHead) return;
  const current = state();
  commitState({
    ...current,
    lastSeenCommit: { ...(current.lastSeenCommit || {}), [sessionKey]: head },
  });
}

main()
  .catch((err) => {
    log(`fatal: ${err?.stack || err}`);
  })
  // Always release child processes, even on the success path where main()
  // simply returns after writing its decision. Without this an ACP agent keeps
  // the event loop alive and the hook hangs until the host kills it.
  .finally(() => {
    releaseBackends();
    // A hook must always end. Once the decision is written there is nothing left
    // to wait for, and a lingering handle would hold the host's turn open.
    process.exit(0);
  });
