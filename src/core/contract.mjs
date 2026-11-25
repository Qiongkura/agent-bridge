// The contract every backend implements.
//
// A backend is one coding agent the bridge can talk to. The bridge itself never
// learns how a given agent works: it only calls these methods. Adding a new
// agent means adding one file here — the MCP tools, hooks and config stay
// untouched.
//
// Nothing in this file may import a specific backend. Keep it that way: the
// whole point is that core has no knowledge of Antigravity, Codex, ACP, or
// anything else.

export class BridgeError extends Error {
  constructor(message, { code = 'bridge_error', backend = null, cause = null } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.backend = backend;
    if (cause) this.cause = cause;
  }
}

/**
 * A conversation handle, as the bridge stores it.
 * Only `backend` and `id` are required; the rest is whatever the backend finds
 * useful to remember about it.
 *
 * @typedef {object} ConversationRef
 * @property {string} backend   backend id that owns this conversation
 * @property {string} id        backend-specific conversation id
 * @property {string} [title]
 * @property {string[]} [workspaces]
 */

/**
 * One turn in a conversation, normalized across backends.
 *
 * @typedef {object} Turn
 * @property {'user'|'assistant'} role
 * @property {string} text
 * @property {string} [at]      ISO timestamp when known
 * @property {string} [model]
 */

/**
 * What a wait returns.
 *
 * @typedef {object} Reply
 * @property {Turn|null} reply   the last assistant turn, if any
 * @property {Turn[]} turns      turns produced since the given index
 * @property {{message:string,at?:string}[]} errors
 * @property {string} status     backend-specific status string; 'TIMEOUT' when the wait expired
 * @property {boolean} [timedOut]
 * @property {string} [conversationId]
 * @property {boolean} [conversationCreated]
 */

/**
 * Base class. Every backend extends this and implements the methods below.
 *
 * The bridge calls `available()` before anything else; a backend that is not
 * available should explain why in one sentence a user can act on (which app is
 * not running, which command is missing) rather than throwing a stack trace.
 */
export class Backend {
  /**
   * @param {object} options   the backend's entry from config, already merged
   * @param {object} context   { dataDir, log }
   */
  constructor(options = {}, context = {}) {
    this.options = options;
    this.context = context;
    this.id = options.id || this.constructor.type;
  }

  /** Stable type name, matching the `type` field in config. */
  static get type() {
    throw new Error('backend must define static type');
  }

  /** Human label used in tool output. */
  static get label() {
    return this.type;
  }

  /**
   * Is this backend usable right now?
   * @returns {Promise<{ok: boolean, detail?: string}>}
   */
  async available() {
    return { ok: true };
  }

  /**
   * Models the user can pick.
   * @returns {Promise<Array<{id: string, label: string, [key: string]: unknown}>>}
   */
  async listModels() {
    return [];
  }

  /**
   * Turn a user-typed model reference ("claude sonnet low", a display label, an
   * id) into whatever this backend actually accepts.
   *
   * The default is *permissive*: it matches against listModels when it can and
   * otherwise passes the reference through unchanged. That is right for CLIs,
   * where the model string is forwarded to a provider the bridge knows nothing
   * about. Backends that can validate should override this and throw — a typo
   * must fail in front of the user, not inside an automatic hook.
   *
   * @returns {Promise<string|null>}
   */
  async resolveModel(ref) {
    if (!ref) return null;
    let models = [];
    try {
      models = await this.listModels();
    } catch {
      models = [];
    }
    if (!models.length) return String(ref);

    const want = normalizeName(ref);
    const hit = models.find(m => m.id === ref)
      || models.find(m => normalizeName(m.label) === want)
      || models.find(m => normalizeName(m.label).includes(want))
      || models.find(m => want.includes(normalizeName(m.label)));
    return hit ? (hit.id || String(ref)) : String(ref);
  }

  /**
   * Conversations the user already has in this agent.
   * Return an empty array when the agent has no notion of named conversations;
   * the bridge then treats each `send` as a fresh one.
   * @returns {Promise<ConversationRef[]>}
   */
  async listConversations() {
    return [];
  }

  /**
   * Create a conversation, optionally rooted at a workspace directory.
   * Backends that have no conversation concept may return a synthetic id.
   * @returns {Promise<ConversationRef>}
   */
  async start() {
    throw new BridgeError('backend does not implement start()', { backend: this.id });
  }

  /**
   * Send a prompt. Must not wait for the answer.
   * @returns {Promise<void>}
   */
  async send() {
    throw new BridgeError('backend does not implement send()', { backend: this.id });
  }

  /**
   * Read the conversation without waiting.
   * @returns {Promise<{turns: Turn[], errors: object[], status: string}>}
   */
  async read() {
    return { turns: [], errors: [], status: 'UNKNOWN' };
  }

  /**
   * Wait until the answer to a prompt arrives.
   * `fromIndex` is how many turns existed before the prompt was sent, so the
   * backend can tell new output from history.
   * @returns {Promise<Reply>}
   */
  async wait() {
    throw new BridgeError('backend does not implement wait()', { backend: this.id });
  }

  /**
   * Optional: describe the backend for status output.
   */
  async describe() {
    return { type: this.constructor.type, id: this.id };
  }

  /**
   * Optional: release anything this backend holds — child processes, sockets,
   * keep-alive connections.
   *
   * The registry calls this before a long-lived process exits. Skipping it is not
   * merely untidy on Windows: a live keep-alive socket during process teardown
   * trips a libuv assertion (`UV_HANDLE_CLOSING`) and turns a clean exit
   * into a crash message on a command that already succeeded.
   */
  dispose() {}
}

// Trim a transcript to something a reader can act on, without pretending the
// omitted part did not exist.
export function truncate(text, max) {
  const s = String(text ?? '');
  if (!max || s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated, ${s.length} chars total)`;
}

// Most agent CLIs want a plain directory; file:// URIs are the exception
// (Antigravity's RPC). Keep the conversion in one place so backends agree.
export function toFileUri(path) {
  const normalized = String(path).replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash).replace(/%3A/gi, ':')}`;
}

export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, ' ')
    .replace(/[.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
