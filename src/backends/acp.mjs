// ACP backend — Agent Client Protocol.
//
// ACP (agentclientprotocol.com) is an open JSON-RPC protocol for driving coding
// agents, and it is the cheapest way to support many harnesses at once: any
// agent that ships an ACP server works here without further code. The bridge
// speaks the client half over the child process's stdio.
//
// Only the four methods the automation case needs are implemented —
// initialize, session/new, session/prompt, session/cancel — because the whole
// point of this backend is unattended review, not editor integration.
import { spawn } from 'node:child_process';
import { Backend, BridgeError } from '../core/contract.mjs';
import { childHopEnv } from '../core/lease.mjs';

const PROTOCOL_VERSION = 1;

export class AcpBackend extends Backend {
  static get type() {
    return 'acp';
  }

  static get label() {
    return 'ACP agent';
  }

  constructor(options = {}, context = {}) {
    super(options, context);
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.sessions = new Map(); // conversationId -> { chunks, promptDone, busy }
    this.initialized = false;
    // Sessions only live as long as this process, and the bridge may address a
    // conversation id that was created before a restart. Remembering the last one
    // lets a bare read()/wait() still find something useful.
    this.lastSessionId = null;
    this.stderr = '';
  }

  get label() {
    // An ACP config often runs through a launcher ("node", "npx"), so the bare
    // command is a poor name for the agent. Prefer the configured name, then the
    // backend id, and only fall back to the command as a last resort.
    return this.options.name || this.id || this.options.command || AcpBackend.label;
  }

  // ACP servers are ordinary commands, so "available" means "the command is
  // configured and its binary can be spawned". We do not spawn on every status
  // check; the first real call reports a spawn failure with the real message.
  async available() {
    if (!this.options.command) {
      return { ok: false, detail: 'acp backend needs a `command` in config (e.g. ["deepseek", "acp"])' };
    }
    return { ok: true, detail: `command: ${[this.options.command, ...(this.options.args || [])].join(' ')}` };
  }

  async listModels() {
    // ACP deliberately exposes no model picker; the model is chosen when the
    // server is launched. Surface the configured one so the UI still shows it.
    if (!this.options.model) return [];
    return [{ id: this.options.model, label: this.options.model }];
  }

  async listConversations() {
    // Each ACP session is created by the bridge and forgotten by the agent when
    // the process exits, so there is no history to list.
    return [];
  }

  #ensureProcess() {
    if (this.child && !this.child.killed) return this.child;

    const cmd = this.options.command;
    const args = this.options.args || [];
    if (!cmd) {
      throw new BridgeError('acp backend has no `command` configured', {
        code: 'not_configured',
        backend: this.id,
      });
    }

    this.child = spawn(cmd, args, {
      cwd: this.options.cwd || process.cwd(),
      // Propagate the hop counter so a *nested* bridge invoked by this agent
      // knows it is nested and refuses to forward again. Without this a chain of
      // agents turns into a ring.
      env: { ...childHopEnv(process.env), ...(this.options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.#onData(chunk));

    let stderr = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', d => {
      stderr = (stderr + d).slice(-4000);
    });

    this.child.on('exit', (code, signal) => {
      const err = new BridgeError(
        `ACP server exited (${code ?? signal})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`,
        { code: 'process_exit', backend: this.id },
      );
      for (const [, waiter] of this.pending) waiter.reject(err);
      this.pending.clear();
      this.child = null;
      this.initialized = false;
    });

    return this.child;
  }

  // ACP frames are newline-delimited JSON on stdout. Anything else on stdout is
  // a protocol violation, but we log rather than crash so a noisy server does
  // not take the bridge down.
  #onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.context.log?.(`acp: non-JSON stdout line: ${line.slice(0, 200)}`);
        continue;
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    // A server-initiated request: ACP asks the client to grant permissions.
    // Unattended runs answer automatically, which is what `autoApprove` is for.
    if (msg.method && msg.id !== undefined) {
      this.#onServerRequest(msg);
      return;
    }
    // A notification: session/update carries the streamed assistant text.
    if (msg.method && msg.id === undefined) {
      this.#onNotification(msg);
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new BridgeError(msg.error.message || 'ACP error', { backend: this.id }));
    else waiter.resolve(msg.result);
  }

  #onNotification(msg) {
    if (msg.method !== 'session/update') return;
    const { sessionId, update } = msg.params || {};
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (update?.sessionUpdate === 'agent_message_chunk') {
      const text = update.content?.text;
      if (typeof text === 'string') session.chunks.push(text);
    }
  }

  #onServerRequest(msg) {
    if (msg.method !== 'session/request_permission') {
      this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unsupported method' } });
      return;
    }
    // Permission options come as a list; pick the allow option when
    // autoApprove is on (the default for a review backend), otherwise reject.
    const options = msg.params?.options || [];
    const allow = options.find(o => /allow|proceed|approve/i.test(`${o.optionId} ${o.name || ''}`));
    const chosen = this.options.autoApprove === false ? null : (allow || options[0] || null);
    this.#write({
      jsonrpc: '2.0',
      id: msg.id,
      result: chosen
        ? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
        : { outcome: { outcome: 'cancelled' } },
    });
  }

  #write(obj) {
    const child = this.#ensureProcess();
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  #request(method, params, timeoutMs = 60000) {
    const child = this.#ensureProcess();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`ACP ${method} timed out after ${timeoutMs}ms`, {
          code: 'timeout',
          backend: this.id,
        }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async #ensureInitialized() {
    if (this.initialized) return;
    this.#ensureProcess();
    await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        // The bridge only consumes committed assistant text, so it asks for
        // nothing beyond the baseline: no fs, no terminal, no MCP.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, 30000);
    this.initialized = true;
  }

  async start({ workspace } = {}) {
    await this.#ensureInitialized();
    const cwd = workspace || this.options.cwd || process.cwd();
    const result = await this.#request('session/new', {
      cwd,
      mcpServers: [],
    }, 60000);
    const sessionId = result?.sessionId;
    if (!sessionId) throw new BridgeError('ACP session/new returned no sessionId', { backend: this.id });
    this.sessions.set(sessionId, { chunks: [], promptDone: null, busy: false });
    return { backend: this.id, id: sessionId, workspaces: [cwd] };
  }

  async send({ conversationId, text }) {
    await this.#ensureInitialized();
    let session = this.sessions.get(conversationId);
    if (!session) {
      // A conversation id that this process does not know about (e.g. the
      // bridge restarted) cannot be resumed over baseline ACP; open a new
      // session rather than failing the whole turn.
      const created = await this.start({});
      session = this.sessions.get(created.id);
      conversationId = created.id;
    }
    session.chunks = [];
    session.busy = true;
    session.promptError = null;
    session.promptDone = this.#request('session/prompt', {
      sessionId: conversationId,
      prompt: [{ type: 'text', text }],
    }, this.options.timeoutMs || 600000)
      .then(r => {
        session.stopReason = r?.stopReason || 'end_turn';
      })
      .catch(err => {
        session.promptError = err;
      })
      .finally(() => {
        session.busy = false;
      });
    this.lastSessionId = conversationId;
  }

  async read({ conversationId } = {}) {
    const id = conversationId || this.lastSessionId;
    const session = this.sessions.get(id);
    if (!session) return { turns: [], errors: [], status: 'UNKNOWN' };
    const turns = [];
    if (session.chunks.length) {
      turns.push({ role: 'assistant', text: session.chunks.join(''), at: new Date().toISOString() });
    }
    return {
      turns,
      errors: session.promptError ? [{ message: session.promptError.message }] : [],
      status: session.busy ? 'RUNNING' : 'IDLE',
    };
  }

  // ACP's session/prompt resolves only when the agent goes idle, so "wait" is
  // just that promise plus a timeout guard. This is why ACP is a better backend
  // than polling: the agent tells us when it is done.
  async wait({ conversationId, timeoutMs = 300000 } = {}) {
    const id = conversationId || this.lastSessionId;
    const session = this.sessions.get(id);
    if (!session) {
      return { reply: null, turns: [], errors: [{ message: 'unknown ACP session' }], status: 'UNKNOWN' };
    }

    const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), timeoutMs));
    const outcome = await Promise.race([session.promptDone || Promise.resolve(), timeout]);

    if (outcome === 'timeout') {
      return {
        reply: null,
        turns: [],
        errors: [],
        status: 'TIMEOUT',
        timedOut: true,
      };
    }

    const text = session.chunks.join('');
    const turns = text ? [{ role: 'assistant', text, at: new Date().toISOString() }] : [];
    return {
      reply: turns[0] || null,
      turns,
      errors: session.promptError ? [{ message: session.promptError.message }] : [],
      status: session.stopReason || 'IDLE',
    };
  }

  async describe() {
    const check = await this.available();
    return {
      type: this.constructor.type,
      id: this.id,
      connected: check.ok,
      detail: check.detail,
      running: !!this.child && !this.child.killed,
      sessions: this.sessions.size,
    };
  }

  // Kill the agent process when the bridge shuts down.
  dispose() {
    try {
      this.child?.kill();
    } catch {}
    this.child = null;
  }
}
