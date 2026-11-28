// Antigravity backend.
//
// Antigravity runs a Go language server that serves a Connect-style JSON RPC on
// 127.0.0.1 and writes a discovery file per instance. We speak that RPC
// directly: no screen scraping, no UI automation, and the agent's own
// transcript is readable, which is what makes review replies trustworthy.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Backend, BridgeError, normalizeName, toFileUri } from '../core/contract.mjs';

const RPC = 'exa.language_server_pb.LanguageServerService';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function geminiDir() {
  if (process.env.ZCODE_AGY_GEMINI_DIR) return process.env.ZCODE_AGY_GEMINI_DIR;
  return join(homedir(), '.gemini');
}

export function daemonDir() {
  return join(geminiDir(), 'antigravity', 'daemon');
}

/**
 * Decide whether the turn being waited on has finished.
 *
 * Extracted from `wait()` so the one rule that matters can be tested: text
 * arriving mid-turn is not an answer. The original condition was
 * `last && (!busy || sawBusy)`, which is true forever once the first poll saw
 * RUNNING — so a conversation that emitted any interim text (a tool-call
 * preamble, a "let me look at that") was cut off and the fragment was returned
 * as the reply.
 *
 * Two ways to be finished:
 *   * an assistant turn exists and the agent is no longer busy — the answer;
 *   * the agent is idle, there is no assistant turn, but the turn errored —
 *     waiting longer cannot help, so surface the error instead of burning the
 *     whole timeout.
 *
 * Everything else keeps polling. In particular `busy === true` with text in
 * hand is not done.
 */
export function turnSettled({ busy, fresh, status }) {
  const last = (fresh?.turns || []).filter(t => t.role === 'assistant').pop();
  if (last && !busy) {
    return { done: true, reply: last, status: status || 'IDLE' };
  }
  if (!busy && (fresh?.errors || []).length && (fresh?.turns || []).length && !last) {
    return { done: true, reply: null, status: status || 'ERROR' };
  }
  return { done: false };
}

// One hub file per running window/version. Only the newest that still answers
// belongs to the instance the user is driving, so probe newest-first.
function discover() {
  const dir = daemonDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/^hub_\d+\.json$/.test(name)) continue;
    const file = join(dir, name);
    let info;
    try {
      info = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!info?.httpPort) continue;
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {}
    out.push({
      port: Number(info.httpPort),
      csrfToken: info.csrfToken || '',
      pid: Number(info.pid) || 0,
      version: info.lsVersion || '',
      mtime,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export class AntigravityBackend extends Backend {
  static get type() {
    return 'antigravity';
  }

  static get label() {
    return 'Antigravity';
  }

  constructor(options = {}, context = {}) {
    super(options, context);
    this.base = null;
    this.csrfToken = '';
    this.version = null;
  }

  async available() {
    try {
      await this.#ensureConnected();
      return { ok: true, detail: `port ${this.port}, v${this.version}` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }

  get port() {
    return this.base ? Number(new URL(this.base).port) : null;
  }

  // Connect once, then reuse. A dead port is re-discovered: the desktop app can
  // restart while the bridge process lives on.
  async #ensureConnected() {
    if (this.base) {
      try {
        await this.#rpc('GetAvailableModels', {});
        return this;
      } catch {
        this.base = null;
      }
    }

    const forced = process.env.BRIDGE_ANTIGRAVITY_URL || this.options.baseUrl;
    if (forced) {
      this.base = String(forced).replace(/\/$/, '');
      this.csrfToken = process.env.BRIDGE_ANTIGRAVITY_CSRF || this.options.csrfToken || '';
      await this.#ensureToken();
      await this.#rpc('GetAvailableModels', {});
      return this;
    }

    const candidates = discover();
    if (!candidates.length) {
      throw new BridgeError(
        'Antigravity is not running. Start the Antigravity desktop app, then retry. '
          + `(looked for hub_*.json in ${daemonDir()})`,
        { code: 'not_running', backend: this.id },
      );
    }

    const failures = [];
    for (const cand of candidates) {
      this.base = `http://127.0.0.1:${cand.port}`;
      this.csrfToken = cand.csrfToken;
      this.version = cand.version;
      try {
        await this.#rpc('GetAvailableModels', {});
        return this;
      } catch (err) {
        // A rejected token means the daemon is alive but we read a stale file.
        if (String(err.message).includes('missing CSRF token')) {
          try {
            await this.#ensureToken();
            await this.#rpc('GetAvailableModels', {});
            return this;
          } catch (err2) {
            failures.push(`port ${cand.port}: ${err2.message}`);
            continue;
          }
        }
        failures.push(`port ${cand.port}: ${err.message}`);
      }
    }
    this.base = null;
    throw new BridgeError(
      `Antigravity is running but no port answered.\n${failures.join('\n')}`,
      { code: 'no_port', backend: this.id },
    );
  }

  async #ensureToken() {
    if (this.csrfToken) return;
    try {
      const res = await fetch(`${this.base}/${RPC}/GetVersion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
        body: '{}',
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      const hit = text.match(/"csrfToken"\s*:\s*"([^"]+)"/);
      if (hit) this.csrfToken = hit[1];
    } catch {}
  }

  async #rpc(method, body = {}, opts = {}) {
    const headers = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' };
    if (this.csrfToken) headers['x-codeium-csrf-token'] = this.csrfToken;
    const res = await fetch(`${this.base}/${RPC}/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs || 30000),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new BridgeError(`${method}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`, {
        backend: this.id,
      });
    }
    if (!res.ok || (data?.code && data.code !== 'OK')) {
      throw new BridgeError(`${method} failed: ${data?.message || data?.code || `HTTP ${res.status}`}`, {
        backend: this.id,
      });
    }
    return data;
  }

  async listModels() {
    await this.#ensureConnected();
    const data = await this.#rpc('GetCascadeModelConfigData', {});
    return (data?.clientModelConfigs || []).map(c => {
      const moa = c.modelOrAlias || {};
      const quota = c.quotaInfo || {};
      return {
        id: moa.model || '',
        label: c.label || moa.model || '',
        supportsImages: !!c.supportsImages,
        quotaRemaining: typeof quota.remainingFraction === 'number' ? quota.remainingFraction : null,
      };
    });
  }

  // Antigravity exposes its model list, so an unknown name is a mistake worth
  // reporting. Silently passing it through would come back as an opaque server
  // error ("invalid value for enum field requestedModel").
  async resolveModel(ref) {
    if (!ref) return null;
    return resolveAntigravityModel(await this.listModels(), ref);
  }

  async listConversations() {
    await this.#ensureConnected();
    const data = await this.#rpc('GetAllCascadeTrajectories', {});
    const summaries = data?.trajectorySummaries || {};
    return Object.entries(summaries)
      .map(([id, s]) => ({
        backend: this.id,
        id,
        title: s.summary || s.title || '',
        at: s.lastModifiedTime || '',
        lastModifiedMs: Date.parse(s.lastModifiedTime || '') || 0,
        workspaces: (s.workspaces || []).map(w => w.workspaceFolderAbsoluteUri).filter(Boolean),
      }))
      .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  }

  // StartCascade creates the conversation but does not run the prompt; the
  // model also has to be supplied on the first send, or the server refuses to
  // build an executor.
  async start({ workspace, model } = {}) {
    await this.#ensureConnected();
    const body = {
      source: 'CORTEX_TRAJECTORY_SOURCE_AGENT_API',
      trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    };
    if (workspace) body.workspaceUris = [toFileUri(workspace)];
    if (model) body.requestedModel = model;
    const data = await this.#rpc('StartCascade', body, { timeoutMs: 30000 });
    if (!data?.cascadeId) throw new BridgeError('StartCascade returned no cascadeId', { backend: this.id });
    return { backend: this.id, id: data.cascadeId, workspaces: workspace ? [toFileUri(workspace)] : [] };
  }

  async send({ conversationId, text, model, timeoutMs } = {}) {
    await this.#ensureConnected();
    const body = { cascadeId: conversationId, messageText: text, items: [{ text }] };
    if (model) body.cascadeConfig = { plannerConfig: { planModel: model } };
    await this.#rpc('SendUserCascadeMessage', body, { timeoutMs: timeoutMs || 60000 });
  }

  #normalize(steps) {
    const turns = [];
    const errors = [];
    const tools = [];
    (steps || []).forEach((step, index) => {
      const type = step.type || '';
      const usage = step.metadata?.modelUsage || {};
      if (type === 'CORTEX_STEP_TYPE_USER_INPUT') {
        const text = step.userInput?.userResponse
          || (step.userInput?.items || []).map(i => i.text).filter(Boolean).join('\n');
        if (text) turns.push({ role: 'user', text, at: step.metadata?.createdAt || '', stepIndex: index });
      } else if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
        const p = step.plannerResponse || {};
        const text = p.modifiedResponse || p.response || '';
        if (text) {
          turns.push({
            role: 'assistant',
            text,
            at: step.metadata?.createdAt || '',
            model: usage.model || '',
            stepIndex: index,
          });
        }
      } else if (type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
        const err = step.errorMessage?.error || {};
        errors.push({
          at: step.metadata?.createdAt || '',
          message: err.shortError || err.userErrorMessage || err.modelErrorMessage || 'unknown error',
          stepIndex: index,
        });
      } else if (/RUN_COMMAND|VIEW_FILE|CODE_SEARCH|GREP_SEARCH|LIST_DIRECTORY|WRITE|EDIT|MCP_TOOL/.test(type)) {
        tools.push({
          tool: type.replace('CORTEX_STEP_TYPE_', '').toLowerCase(),
          at: step.metadata?.createdAt || '',
          stepIndex: index,
        });
      }
    });
    return { turns, errors, tools };
  }

  // `fromIndex` counts turns, but errors and tool calls are not turns. Without a
  // common origin a long-lived conversation keeps reporting errors from weeks
  // ago as if they belonged to the prompt just sent. Mapping the turn boundary
  // back to a step index gives all three lists the same starting point.
  #sinceFrom(normalized, fromIndex) {
    const { turns, errors, tools } = normalized;
    const startStep = fromIndex > 0 && turns[fromIndex - 1]
      ? turns[fromIndex - 1].stepIndex + 1
      : 0;
    const fresh = turns.slice(fromIndex);
    return {
      turns: fresh,
      errors: errors.filter(e => (e.stepIndex ?? 0) >= startStep),
      tools: tools.filter(t => (t.stepIndex ?? 0) >= startStep),
    };
  }

  async read({ conversationId } = {}) {
    await this.#ensureConnected();
    const data = await this.#rpc('GetCascadeTrajectorySteps', { cascadeId: conversationId });
    const { turns, errors, tools } = this.#normalize(data?.steps);
    return { turns, errors, tools, status: 'READ' };
  }

  async wait({ conversationId, fromIndex = 0, timeoutMs = 300000, pollMs = 2500 } = {}) {
    await this.#ensureConnected();
    const deadline = Date.now() + timeoutMs;
    await sleep(Math.min(1500, pollMs));

    while (Date.now() < deadline) {
      const status = await this.#rpc('GetCascadeTrajectory', { cascadeId: conversationId });
      const busy = status?.status === 'CASCADE_RUN_STATUS_RUNNING' || status?.status === 'CASCADE_RUN_STATUS_BUSY';

      const stepsData = await this.#rpc('GetCascadeTrajectorySteps', { cascadeId: conversationId });
      const fresh = this.#sinceFrom(this.#normalize(stepsData?.steps), fromIndex);
      const verdict = turnSettled({ busy, fresh, status: status?.status });
      if (verdict.done) {
        return verdict.reply
          ? { reply: verdict.reply, ...fresh, status: verdict.status }
          : { reply: null, ...fresh, status: verdict.status };
      }
      await sleep(pollMs);
    }

    const stepsData = await this.#rpc('GetCascadeTrajectorySteps', { cascadeId: conversationId });
    const fresh = this.#sinceFrom(this.#normalize(stepsData?.steps), fromIndex);
    return {
      reply: fresh.turns.filter(t => t.role === 'assistant').pop() || null,
      ...fresh,
      status: 'TIMEOUT',
      timedOut: true,
    };
  }

  async describe() {
    try {
      await this.#ensureConnected();
      return { type: this.constructor.type, id: this.id, connected: true, port: this.port, version: this.version };
    } catch (err) {
      return { type: this.constructor.type, id: this.id, connected: false, detail: err.message };
    }
  }

  // The RPCs go through the global fetch, whose connection pool keeps sockets
  // open. Left alone they are still live while the process tears down, which on
  // Windows trips a libuv assertion after the work has already succeeded.
  //
  // Node exposes the pool as a global symbol rather than a documented API, so
  // this is best-effort by design: if the shape ever changes, disposal is simply
  // a no-op and the process still exits.
  async dispose() {
    try {
      const sym = Symbol.for('undici.globalDispatcher.1');
      const dispatcher = globalThis[sym];
      if (dispatcher && typeof dispatcher.close === 'function') {
        await dispatcher.close();
      }
    } catch {
      /* best effort */
    }
  }
}

// Resolve a user-typed model reference against the live model list.
// Accepts the enum, a display label, or a loose form like "claude sonnet 5.5 low".
export function resolveAntigravityModel(models, ref) {
  if (!ref) return null;
  const want = String(ref).trim();
  const norm = normalizeName(want);
  const hit = models.find(m => m.id === want)
    || models.find(m => normalizeName(m.label) === norm)
    || models.find(m => normalizeName(m.label).includes(norm))
    || models.find(m => norm.includes(normalizeName(m.label)));
  if (!hit) {
    const known = models.map(m => `${m.id} (${m.label})`).join(', ');
    throw new BridgeError(`unknown model "${ref}". Available: ${known}`, {
      code: 'unknown_model',
    });
  }
  return hit.id;
}
