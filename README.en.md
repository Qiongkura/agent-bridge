# Agent Bridge

A bridge that lets **two coding agents collaborate**. You work in ZCode; when you hit a hard
problem or finish a chunk of work, the bridge sends the question or a summary to another agent
(Antigravity, Codex, DeepSeek Harness, or any ACP-capable agent); that agent reads the real code
and answers with **analysis / risks / next steps**; ZCode picks it up and keeps going.

Adapters are pluggable: supporting a new agent means either editing a config block (CLI agents) or
writing one ~300-line adapter file. The core layer has no idea Antigravity or Codex exist.

> [中文](README.md)

## Why this exists

A single agent has two hard limits: **no second opinion**, and **self-reinforcement as context
grows**. Human teams solve both with code review, but agents have no review channel between them.
This project builds that channel — not so two models can flatter each other, but so each gets an
independent look at the code.

## How it works

```
ZCode turn ends / tool fails / slash command
   ↓  hook or MCP tool
src/core/session.mjs (backend-agnostic: pick conversation, send, wait, shape)
   ↓  Backend contract
┌──────────────┬──────────────┬──────────────┐
│ antigravity  │     acp      │     cli      │
│ local RPC    │ JSON-RPC/stdio│ child/stdout │
└──────────────┴──────────────┴──────────────┘
   ↓
the other agent reads real files, then answers
   ↓
analysis / risks / next steps  →  back into ZCode to continue
```

- `src/core/` — contract, registry, config, session orchestration. **No agent-specific knowledge.**
- `src/backends/` — one file per agent, implementing the `Backend` contract.
- `src/mcp/server.mjs` — MCP tool layer, ten `bridge_*` tools.
- `hooks/` — automation: review on turn end, help on tool failure.

## Supported backends

| Backend | Type | Capabilities | Notes |
|---|---|---|---|
| **Antigravity** | `antigravity` | conversations ✓ models ✓ reads files ✓ | Direct local Connect/gRPC-Web RPC; discovers port and CSRF token |
| **Any ACP agent** | `acp` | sessions ✓ streaming ✓ | Agent Client Protocol: DeepSeek Harness, Zed-family agents |
| **Any CLI agent** | `cli` | models (configurable) | One process per call: Codex, MiMo-Code, `claude -p`, custom scripts |
| **New agent** | new file | — | `src/backends/your.mjs` + two lines in the registry |

The `cli` backend is deliberately a **zero-code extension point**: most agents can be driven by
`agent --prompt` or by reading stdin, so wiring up an unfamiliar agent is usually just a config
block describing the command, the argument template, and where the answer lands.

### How each agent connects

| Tool | Entry point | Wiring |
|---|---|---|
| Antigravity | desktop app local RPC | `type: "antigravity"`, no config needed |
| Codex | `codex exec` | `type: "cli"` + a `{prompt}` argument template |
| DeepSeek Harness | `demo:acp` script | `type: "acp"` + **your own provider's cordis config** (below) |
| MiMo-Code | `mimo run` | `type: "cli"`; the model lives in its own `mimocode.jsonc` |

**DeepSeek Harness has a trap**: the repo's stock `examples/acp-agent/cordis.yml` hardcodes the
official endpoint (`provider: deepseek-official`). Point it at your own gateway and every turn fails
with `no API key for provider route "deepseek-official"` — the session is created, the conversation
never works. Template: [`examples/dsh-custom-provider.cordis.yml`](examples/dsh-custom-provider.cordis.yml).

**MiMo-Code likewise**: `mimo run` has no `--json` output, so use `output: "text"`, and the model is
not passed by the bridge — edit its own config file.

## Install

This repository is a ZCode plugin, and its MCP server also works in any MCP-capable host.

### As a ZCode plugin

```bash
# 1. Put the repository somewhere, then add a local plugin marketplace in ZCode:
#    Plugins → Add ∨ → Add plugin marketplace → choose the directory containing this plugin
# 2. Restart ZCode (the MCP server and hooks load at startup)
```

First run detects which agents are installed locally, writes `config.json`, and leaves
**automation off**.

### As a plain MCP server

```bash
node src/mcp/server.mjs        # stdio JSON-RPC, standard MCP
```

See [Configuration](#configuration).

## Commands

| Command | What it does |
|---|---|
| `/antigravity-ask <question>` | Send a question, then continue from the answer |
| `/antigravity-review [focus]` | Submit this turn's work for review, fix real risks, continue |
| `/antigravity-config` | Status, switch agent, conversation, model, automation |

(The command names keep a historical prefix; they are no longer Antigravity-only.)

## MCP tools

| Tool | Purpose |
|---|---|
| `bridge_status` | Which agents are configured/online, current routing, last exchange |
| `bridge_agents` | Per-agent capabilities: type, online, model, conversation count |
| `bridge_models` | Available models (with quota) for one agent |
| `bridge_conversations` | Conversation list (title, time, workspace) |
| `bridge_select` | Set default agent / conversation / model; `create:true` starts one bound to a workspace |
| `bridge_ask` | Ask and wait (returns a ticket on timeout) |
| `bridge_review` | Send a completion summary and request review |
| `bridge_fetch` | Collect a reply; keeps waiting if a prompt is still outstanding |
| `bridge_auto` | Automation switches and thresholds |
| `bridge_ping` | Minimal connectivity test |

Every tool accepts `target` (a backend id from config). Omit it for the default, or pass `"auto"`
for the first available agent.

## Configuration

Location: `$ZCODE_PLUGIN_DATA/config.json` (falls back to `~/.bridge/config.json` standalone;
override with `BRIDGE_DATA_DIR`). Created on first run.

```jsonc
{
  "version": 2,
  "defaultBackend": "antigravity",     // who to talk to by default
  "autoBackend": null,                 // automation may target a different agent
  "selections": {                      // stored per backend; a conversation id never crosses agents
    "antigravity": {
      "conversationId": "e7de37d6-…",
      "model": "MODEL_PLACEHOLDER_M403",
      "autoModel": "MODEL_PLACEHOLDER_M534"
    }
  },
  "roles": {                           // pin by purpose
    "review": { "backend": "antigravity", "conversationId": "…" }
  },
  "workspace": "I:\\projects\\my-app",
  "auto": {
    "onStop": false,                   // review every turn end
    "onError": false,                  // ask for help on tool failure
    "continueAfterReview": true,       // keep working after a review; false = store only
    "reviewOnStop": true,              // ask for a review rather than a status brief
    "minEdits": 3,                     // threshold: ≥3 files or a new commit
    "minResponseChars": 80,            // skip trivial messages (CJK weighted 2×)
    "timeoutMs": 180000,
    "errorTimeoutMs": 90000,
    "errorCooldownMs": 120000,
    "role": "review"
  },
  "backends": {
    "antigravity": { "type": "antigravity", "enabled": true },

    "codex": {
      "type": "cli",
      "enabled": false,
      "command": "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\…\\codex.exe",
      "args": ["exec", "--skip-git-repo-check", "-s", "read-only", "{prompt}"],
      "timeoutMs": 300000
    },

    "deepseek": {
      "type": "acp",
      "enabled": false,
      "command": "node",
      "args": ["--import", "tsx", "…/acp-demo/src/bin.ts"],
      "cwd": "…/deepseek-harness",
      "autoApprove": true
    }
  }
}
```

### Backend fields

**`antigravity`** — no fields required. Optional `baseUrl` / `csrfToken` (or the environment
variables `BRIDGE_ANTIGRAVITY_URL` / `BRIDGE_ANTIGRAVITY_CSRF`) to pin a port.

**`acp`**

| Field | Meaning |
|---|---|
| `command` | Executable that starts the ACP server |
| `args` | Argument array |
| `cwd` | Working directory |
| `env` | Extra environment variables |
| `autoApprove` | Auto-approve `session/request_permission` (required for unattended use) |
| `model` | Display only; ACP picks its model at launch |

**`cli`**

| Field | Meaning |
|---|---|
| `command` | Executable |
| `args` | Argument template; `{prompt}` is substituted |
| `stdin` | Write the prompt to stdin (**recommended** — avoids shell injection) |
| `modelArg` | Model flag template, e.g. `["--model", "{model}"]` |
| `output` | `text` (whole stdout is the answer) or `json` (JSONL event stream) |
| `jsonPath` | Field path holding the answer for `output:"json"`, e.g. `answer` |
| `outputFile` | Path template when the answer is written to a file (Codex `--output-last-message`) |
| `timeoutMs` | Process timeout |

### Ready-made config blocks

**Codex** (`codex exec`; writing the answer to a file is more robust):

```json
"codex": {
  "type": "cli",
  "command": "C:/Users/you/AppData/Local/OpenAI/Codex/bin/<hash>/codex.exe",
  "args": ["exec", "--skip-git-repo-check", "-s", "read-only"],
  "stdin": true,
  "modelArg": ["-m", "{model}"],
  "outputFile": "{cwd}/.codex-answer.txt",
  "timeoutMs": 300000
}
```

**MiMo-Code** (`mimo run`; no JSON output, model comes from its own `mimocode.jsonc`):

```json
"mimo": {
  "type": "cli",
  "command": "mimo",
  "args": ["run", "--dangerously-skip-permissions"],
  "stdin": true,
  "output": "text",
  "timeoutMs": 300000
}
```

`--dangerously-skip-permissions` keeps it from prompting in unattended use — which also lets it edit
files. To use it as a read-only reviewer, tighten permissions in MiMo's own config.

**DeepSeek Harness** (ACP; must point at your own provider config):

```json
"deepseek": {
  "type": "acp",
  "command": "node",
  "args": ["--import", "tsx", "packages/examples/acp-demo/src/bin.ts",
           "--config", "examples/acp-agent/cordis.local.yml"],
  "cwd": "G:/deepseek-harness",
  "env": { "MY_GATEWAY_KEY": "<the key>" },
  "autoApprove": true
}
```

The `env` block is not optional: the ACP entry point only loads `.env` from its own cwd, so a key in
the desktop app's credential store is invisible to it. Template:
[`examples/dsh-custom-provider.cordis.yml`](examples/dsh-custom-provider.cordis.yml).

## Choosing a model

Any of these forms works; a wrong name fails immediately and lists the available ones:

```
claude-sonnet-5-5-low        Claude Sonnet 5.5 (Low)
gemini-4-neon-high           Gemini 4 Neon (High)
gemini 3.8 flash low         Gemini 3.8 Flash (Low)
MODEL_PLACEHOLDER_M403       enum
```

Selections are **stored per backend**: one agent's model name means nothing to another.

## Choosing a conversation

```
bridge_conversations                     # see what exists
bridge_select({conversationId})          # pick one
bridge_select({create:true, workspace})  # start one bound to a workspace
```

Binding a workspace is what lets the other agent read that directory. With nothing selected, the
bridge reuses the newest conversation already bound to the current project.

If a pinned conversation was garbage-collected by the agent, the bridge **replaces it with a usable
one and writes the repair back** instead of failing forever with `trajectory not found`.

## Keeping automation affordable

Automation is off by default because it adds a real call to every turn.

Even when enabled, a turn is only forwarded when it clears a threshold:

- a **new git commit** appeared during the turn
- the turn edited **≥3 distinct files** (a file edited twice counts once)
- the message explicitly says **`[[review]]`**

Turns below the threshold are skipped silently and logged as `skip: small change`.
Tune with `bridge_auto({minEdits: 5})`; `minEdits: 0` restores "every turn".

Prompts ask for a **block of work** rather than incremental nits. When there is genuinely nothing
to say, the reviewer answers a single line `NO_ACTION: <reason>`; the bridge records it and stays
silent instead of burning a turn on "no comment".

## The 30-second tool limit

The host hardcodes `MCP_TOOL_TIMEOUT_MS = 30000`: any MCP tool call running longer is killed and
its result is lost. A plugin cannot change it, so `bridge_ask` / `bridge_review` use a **soft wait**:

- wait at most **22 seconds** (override with `BRIDGE_WAIT_MS`)
- if the answer is not in, return `{awaitingReply: true, conversationId}` — **do not resend**
- collect it with `bridge_fetch`, which remembers the ticket's starting index so an older assistant
  turn is never mistaken for the new answer

Hooks have their own budget and are not bound by this, so an automatic review may wait the full
`auto.timeoutMs`.

## Security boundaries

- **All traffic stays local.** Antigravity is `127.0.0.1` anyway; ACP and CLI are child-process
  stdio.
- **Prompts never pass through a shell.** The `cli` backend writes to stdin or passes the text as a
  single argv element; `{prompt}` is a string substitution, never shell-parsed.
- **Hooks never block.** Every error path exits 0 with no output = "nothing to add".
- **Automation is opt-in**, with layered loop protection: immediate exit on `stop_hook_active`,
  per-turn fingerprint dedupe, short-message skip, cooldown, and silent exit when no agent is
  reachable.
- **No UI driving, no screenshots.** Everything goes through each agent's own programmatic
  interface.

## Adding an agent

**Try the `cli` config first** — it covers most cases without code:

```json
"myagent": {
  "type": "cli",
  "command": "myagent",
  "args": ["run", "--json"],
  "stdin": true,
  "output": "json",
  "jsonPath": "result.text"
}
```

Write a backend when you need streaming, conversation lists, or protocol-level control:

```js
// src/backends/myagent.mjs
import { Backend, BridgeError } from '../core/contract.mjs';

export class MyAgentBackend extends Backend {
  static get type() { return 'myagent'; }
  static get label() { return 'My Agent'; }

  async available() { /* probe */ return { ok: true }; }
  async listModels() { return []; }
  async listConversations() { return []; }
  async start({ workspace }) { /* → {id, workspaces} */ }
  async send({ conversationId, text }) { /* must not wait */ }
  async read({ conversationId }) { /* → {turns, errors, status} */ }
  async wait({ conversationId, fromIndex, timeoutMs }) { /* → {reply, turns, …} */ }
}
```

Then register it in `src/core/registry.mjs` — two lines. **The core needs no changes.**

The authoritative contract (field meanings, `fromIndex` semantics, optional methods) lives in the
comments of [`src/core/contract.mjs`](src/core/contract.mjs).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Antigravity is not running` | Desktop app not started, or too old to write a discovery file |
| `missing CSRF token` | The bridge re-reads the discovery file; if it persists, restart Antigravity |
| `plan model not specified` | The conversation was created outside the bridge; use `bridge_select({create:true})` |
| `unknown model "..."` | The error lists valid options; or check `bridge_models` |
| `unknown backend "..."` | That id is not in `backends`; check `bridge_agents` |
| ACP fails immediately | Run `command` + `args` by hand to see whether the launch command itself works |
| Automation does not fire | Check `automation.onStop` in `bridge_status`; also check the threshold and message length |

Logs: `$ZCODE_PLUGIN_DATA/hook.log`
Config: `$ZCODE_PLUGIN_DATA/config.json`

## Self-test

```bash
node scripts/smoke-test.mjs                     # read-only: status, agents, models, conversations
node scripts/smoke-test.mjs ask "question"      # real prompt
node scripts/smoke-test.mjs ask "question" codex # against a specific backend
node scripts/smoke-test.mjs full                # new conversation + prompt
node scripts/smoke-test.mjs review              # real review request
```

Point `BRIDGE_DATA_DIR` at a scratch directory to leave your real config alone:

```bash
BRIDGE_DATA_DIR=/tmp/bridge-test node scripts/smoke-test.mjs
```

## Layout

```
src/
  core/
    contract.mjs    the Backend contract (single source of truth)
    registry.mjs    backend registry and instance pool
    config.mjs      detection, migration, read/write
    session.mjs     orchestration, soft wait, tickets
    brief.mjs       prompt construction
  backends/
    antigravity.mjs local RPC
    acp.mjs         Agent Client Protocol
    cli.mjs         one-shot CLI process
  mcp/
    server.mjs      ten MCP tools
hooks/
  _shared.mjs       shared hook plumbing (log, state, loop guards)
  stop-bridge.mjs   review on turn end
  error-bridge.mjs  help on tool failure
commands/           /antigravity-ask and friends
skills/             auto-trigger skill description
scripts/smoke-test.mjs
```

## License

MIT. See [LICENSE](LICENSE).
