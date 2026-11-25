// CLI backend — one-shot command-line agents.
//
// Many harnesses can be driven as `agent --prompt "..."` and print the answer on
// stdout. That shape needs no protocol at all, so this backend covers Codex,
// and any future agent by config alone — no code. Two knobs matter:
//
//   command   argv template; {prompt} is replaced with the prompt text
//   output    'text' (whole stdout is the answer) or 'json' (a JSON object with
//             the answer at `path`, e.g. codex's --output-last-message file)
//
// Prompt delivery has to avoid the shell entirely: agents receive untrusted
// text, and a template interpolated into a shell string is an injection vector.
// The prompt is written to stdin when `stdin: true`, otherwise appended as a
// single argv element.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';

import { Backend, BridgeError } from '../core/contract.mjs';
import { childHopEnv } from '../core/lease.mjs';

export class CliBackend extends Backend {
  static get type() {
    return 'cli';
  }

  static get label() {
    return 'CLI agent';
  }

  constructor(options = {}, context = {}) {
    super(options, context);
    this.counter = 0;
  }

  get label() {
    // The command is often a launcher ("node", "npx"), so prefer the configured
    // name and then the backend id; the bare command is the last resort.
    return this.options.name || this.id || this.options.command || CliBackend.label;
  }

  async available() {
    if (!this.options.command) {
      return { ok: false, detail: 'cli backend needs a `command` in config' };
    }
    return { ok: true, detail: `${this.options.command} ${(this.options.args || []).join(' ')}`.trim() };
  }

  async listModels() {
    if (!this.options.model) return [];
    const configured = Array.isArray(this.options.model) ? this.options.model : [this.options.model];
    return configured.map(m => (typeof m === 'string' ? { id: m, label: m } : m));
  }

  async listConversations() {
    // A one-shot CLI has no conversation list; each send is its own process.
    return [];
  }

  async start({ workspace } = {}) {
    this.counter += 1;
    return {
      backend: this.id,
      id: `cli-${Date.now().toString(36)}-${this.counter}`,
      workspaces: workspace ? [workspace] : [],
    };
  }

  // A one-shot CLI answers inside a single spawn, so send() runs the whole thing
  // and the answer is available immediately afterwards from wait().
  async send({ conversationId, text, workspace, model } = {}) {
    const opts = this.options;
    // Keep the template intact until we know where the prompt goes: an earlier
    // version stripped {prompt} here, which made the "does any arg carry the
    // placeholder?" test always false and silently switched every templated
    // backend to stdin — so `--prompt {prompt}` was passed as `--prompt ""`.
    const template = [...(opts.args || [])];
    const args = [...template];

    // Model selection: a template lets a backend express how its CLI takes it.
    if (model) {
      const tpl = opts.modelArg;
      if (Array.isArray(tpl)) args.push(...tpl.map(a => a.replace(/\{model\}/g, model)));
      else if (typeof tpl === 'string') args.push(tpl.replace(/\{model\}/g, model));
    } else if (opts.defaultArgs) {
      args.push(...opts.defaultArgs);
    }

    const cwd = workspace || opts.cwd || process.cwd();
    const carriesPrompt = template.some(a => a.includes('{prompt}'));
    const useStdin = opts.stdin === true || !carriesPrompt;
    if (!useStdin) {
      // Substitute in place so flags keep their order: the prompt must stay the
      // value of whatever flag precedes it.
      for (let i = 0; i < args.length; i += 1) {
        if (args[i].includes('{prompt}')) args[i] = args[i].replace(/\{prompt\}/g, text);
      }
    }

    const startedAt = Date.now();
    const result = await this.#spawnOnce({
      cmd: opts.command,
      args,
      cwd,
      // Hop propagation: a CLI agent may itself run `bridge ask`; the counter
      // tells that nested bridge to stop instead of forwarding again.
      env: { ...childHopEnv(process.env), ...(opts.env || {}) },
      input: useStdin ? text : null,
      timeoutMs: opts.timeoutMs || 600000,
    });

    const answer = this.#extractAnswer(result, opts);
    this.lastResult = {
      conversationId,
      answer,
      stderr: result.stderr,
      exitCode: result.code,
      at: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
  }

  #spawnOnce({ cmd, args, cwd, env, input, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch {}
        reject(new BridgeError(`${cmd} timed out after ${timeoutMs}ms`, { code: 'timeout', backend: this.id }));
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => { stdout = (stdout + d).slice(-2_000_000); });
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); });

      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new BridgeError(`cannot run ${cmd}: ${err.message}`, { code: 'spawn_failed', backend: this.id }));
      });

      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });

      if (input != null) {
        child.stdin.write(input);
      }
      child.stdin.end();
    });
  }

  // Where the answer lives depends on how the CLI is invoked. `outputFile` is
  // checked first because JSON event streams are noisy but the file is exact.
  #extractAnswer(result, opts) {
    if (opts.outputFile) {
      const path = opts.outputFile.replace(/\{cwd\}/g, opts.cwd || process.cwd());
      if (existsSync(path)) {
        try {
          const text = readFileSync(path, 'utf8').trim();
          if (opts.cleanupOutputFile !== false) {
            try { unlinkSync(path); } catch {}
          }
          return text;
        } catch {}
      }
    }

    if (opts.output === 'json' || opts.jsonPath) {
      const path = opts.jsonPath || 'answer';
      const parsed = parseJsonEvents(result.stdout, path);
      if (parsed != null) return parsed;
    }

    if (result.code !== 0 && !result.stdout.trim()) {
      throw new BridgeError(
        `${opts.command} exited with ${result.code}${result.stderr ? `: ${result.stderr.trim().split('\n').pop()}` : ''}`,
        { code: 'nonzero_exit', backend: this.id },
      );
    }
    return result.stdout.trim();
  }

  async read({ conversationId } = {}) {
    const res = this.lastResult;
    if (!res || (conversationId && res.conversationId !== conversationId)) {
      return { turns: [], errors: [], status: 'UNKNOWN' };
    }
    return {
      turns: res.answer ? [{ role: 'assistant', text: res.answer, at: res.at }] : [],
      errors: res.exitCode ? [{ message: `${this.options.command} exited with ${res.exitCode}` }] : [],
      status: 'READ',
    };
  }

  // The work already finished inside send(), so wait() only formats it.
  async wait({ conversationId, timeoutMs } = {}) {
    const res = this.lastResult;
    if (!res || (conversationId && res.conversationId !== conversationId)) {
      return {
        reply: null,
        turns: [],
        errors: [{ message: 'no completed CLI run for this conversation' }],
        status: 'UNKNOWN',
      };
    }
    const turns = res.answer ? [{ role: 'assistant', text: res.answer, at: res.at }] : [];
    return {
      reply: turns[0] || null,
      turns,
      errors: res.exitCode ? [{ message: `exit code ${res.exitCode}: ${String(res.stderr).trim().split('\n').pop() || ''}` }] : [],
      status: 'IDLE',
    };
  }

  async describe() {
    const check = await this.available();
    return {
      type: this.constructor.type,
      id: this.id,
      connected: check.ok,
      detail: check.detail,
      output: this.options.output || 'text',
    };
  }
}

// Two output shapes exist in the wild, and a backend must not care which one it
// got:
//
//   * a JSONL event stream (Codex, most `--json` flags): the answer sits in the
//     last event that has the requested path
//   * one pretty-printed object on stdout (ZCode's `--json`): valid JSON, but
//     spread over many lines, so a line-by-line parse finds nothing
//
// Trying the whole payload first covers the second case, and the line walk
// covers the first. Getting this wrong is silent: stdout is non-empty, so the
// backend would return the raw JSON blob as if it were the agent's prose.
function parseJsonEvents(stdout, path) {
  const text = String(stdout).trim();
  if (!text) return null;

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const value = readPath(JSON.parse(text), path);
      if (typeof value === 'string' && value.trim()) return value.trim();
    } catch {
      // Not a single JSON document; fall through to the event stream.
    }
  }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let best = null;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const value = readPath(obj, path);
    if (typeof value === 'string' && value.trim()) best = value.trim();
  }
  return best;
}

function readPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}
