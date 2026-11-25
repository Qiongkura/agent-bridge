# Agent Bridge

一个让**两个编码代理互相协作**的桥接层。你在 ZCode 里干活；遇到难题或做完一段，桥接把
问题/总结发给另一个代理（Antigravity、Codex、DeepSeek Harness，或任何支持 ACP 的代理）；
对方读真实代码后回 **分析 / 风险 / 下一步**；ZCode 接回来继续干。

适配器是可插拔的：加一个新代理要么改一行配置（CLI 类），要么写一个约 300 行的适配器文件。
核心层完全不知道 Antigravity 或 Codex 的存在。

> [English](README.en.md)

## 为什么需要它

单个代理有两个硬伤：**没有第二意见**，以及**上下文越长越容易自我强化**。人类团队靠 review
解决这两点，但代理之间没有 review 通道。这个项目补上这条通道——不是让两个模型互相吹捧，
而是给对方一份能直接读代码的独立视角。

## 工作原理

```
ZCode 回合结束 / 工具失败 / 手动命令
   ↓  hook 或 MCP 工具
core/session.mjs（与后端无关：选对话、发送、等待、整形）
   ↓  Backend 契约
┌──────────────┬──────────────┬──────────────┐
│ antigravity  │     acp      │     cli      │
│ 本地 RPC     │ JSON-RPC/stdio│ 子进程/stdout│
└──────────────┴──────────────┴──────────────┘
   ↓
另一个代理读真实文件后回复
   ↓
analysis / risk / next steps  →  接回 ZCode 继续执行
```

三层职责：

- `src/core/` — 契约、注册表、配置、会话编排。**不含任何具体代理的知识。**
- `src/backends/` — 每个代理一个文件，实现 `Backend` 契约。
- `src/mcp/server.mjs` — MCP 工具层，10 个 `bridge_*` 工具。
- `hooks/` — 自动协作：回合结束送审、工具失败求援。

## 支持的后端

| 后端 | 类型 | 能力 | 说明 |
|---|---|---|---|
| **Antigravity** | `antigravity` | 对话列表 ✓ 模型列表 ✓ 真实读文件 ✓ | 直连本地 Connect/gRPC-Web RPC，自动发现端口与 CSRF |
| **任何 ACP 代理** | `acp` | 对话 ✓ 流式 ✓ | Agent Client Protocol，覆盖 DeepSeek Harness、Zed 系代理等 |
| **任何 CLI 代理** | `cli` | 模型（可配）| 一次调用一个进程：Codex、`claude -p`、自研脚本 |
| **新代理** | 新增文件 | — | `src/backends/your.mjs` + 注册表两行 |

`cli` 后端是刻意设计成**零代码扩展点**的：大多数代理都能 `agent --prompt` 或从 stdin 读，
所以接一个陌生代理往往只要在配置里写清命令、参数模板和输出位置。

## 安装

本仓库是一个 ZCode 插件，同时也能被任何支持 MCP 的宿主当普通 MCP server 用。

### 作为 ZCode 插件

```bash
# 1. 把仓库放到任意目录，然后在 ZCode 里添加本地插件市场
#    插件管理 → 添加 ∨ → 添加插件市场 → 选择目录（选到包含本插件的父目录）

# 2. 安装后重启 ZCode（MCP server 与 hooks 在启动时加载）
```

首次运行会自动探测本机装了哪些代理，写出 `config.json`，**自动协作默认关闭**。

### 作为普通 MCP server

```bash
node src/mcp/server.mjs        # stdio JSON-RPC，标准 MCP 协议
```

配置示例见 [配置](#配置)。

## 命令

| 命令 | 作用 |
|---|---|
| `/antigravity-ask <问题>` | 把问题发给协作代理，拿回分析后继续做 |
| `/antigravity-review [重点]` | 把本轮工作总结送审，按风险修正后继续 |
| `/antigravity-config` | 看状态、换代理、换对话、换模型、开关自动协作 |

（命令名沿用历史前缀，功能已不限于 Antigravity。）

## MCP 工具

| 工具 | 作用 |
|---|---|
| `bridge_status` | 配了哪些代理、哪些在线、当前路由、最近一次协作 |
| `bridge_agents` | 每个代理的能力：类型、在线、模型、对话数 |
| `bridge_models` | 某代理的可用模型（含配额） |
| `bridge_conversations` | 某代理的对话列表（标题、时间、工作区） |
| `bridge_select` | 设定默认代理/对话/模型；`create:true` 新建并绑定工作区 |
| `bridge_ask` | 提问并等待（超时返回票据） |
| `bridge_review` | 发送完成总结并请求审查 |
| `bridge_fetch` | 取回回复；有未答完的提问时自动接着等 |
| `bridge_auto` | 自动协作开关与门槛 |
| `bridge_ping` | 最小连通性测试 |

所有工具都接受 `target`（配置里的 backend id）。省略用默认目标，`"auto"` 表示第一个可用的。

## 配置

位置：`$ZCODE_PLUGIN_DATA/config.json`（独立运行时回落到 `~/.bridge/config.json`，
可用 `BRIDGE_DATA_DIR` 覆盖）。首次运行自动生成。

```jsonc
{
  "version": 2,
  "defaultBackend": "antigravity",     // 默认跟谁说话
  "autoBackend": null,                 // 自动协作单独指定（可选）
  "selections": {                      // 按代理分别保存，对话 id 不跨代理共用
    "antigravity": {
      "conversationId": "e7de37d6-…",
      "model": "MODEL_PLACEHOLDER_M403",
      "autoModel": "MODEL_PLACEHOLDER_M534"
    }
  },
  "roles": {                           // 按用途固定
    "review": { "backend": "antigravity", "conversationId": "…" }
  },
  "workspace": "I:\\projects\\my-app",
  "auto": {
    "onStop": false,                   // 每轮结束自动送审
    "onError": false,                  // 工具失败自动求援
    "continueAfterReview": true,       // 收到审查后继续执行；false = 只保存
    "reviewOnStop": true,              // 自动发送时要求审查而非简报
    "minEdits": 3,                     // 门槛：≥3 个文件或新 commit
    "minResponseChars": 80,            // 过短的消息不值得送审（CJK 按 2 倍计权）
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

### 后端配置字段

**`antigravity`** — 无需字段。可选：`baseUrl` / `csrfToken`（或环境变量
`BRIDGE_ANTIGRAVITY_URL` / `BRIDGE_ANTIGRAVITY_CSRF`）用于强制指定端口。

**`acp`**

| 字段 | 说明 |
|---|---|
| `command` | 启动 ACP server 的可执行文件 |
| `args` | 参数数组 |
| `cwd` | 工作目录 |
| `env` | 追加的环境变量 |
| `autoApprove` | 自动批准 `session/request_permission`（无人值守必须为 true）|
| `model` | 仅作展示；ACP 的模型在启动时确定 |

**`cli`**

| 字段 | 说明 |
|---|---|
| `command` | 可执行文件 |
| `args` | 参数模板；`{prompt}` 会被替换 |
| `stdin` | `true` 时把提示词写进 stdin（**推荐**，避免 shell 注入）|
| `modelArg` | 模型参数模板，如 `["--model", "{model}"]` |
| `output` | `text`（整个 stdout 是答案）或 `json`（JSONL 事件流）|
| `jsonPath` | `output:"json"` 时答案所在的字段路径，如 `answer` |
| `outputFile` | 答案写在该文件里时的路径模板（Codex 的 `--output-last-message`）|
| `timeoutMs` | 进程超时 |

## 选模型

模型名可以写任意一种，写错会立刻列出可用项：

```
claude-sonnet-5-5-low        Claude Sonnet 5.5 (Low)
gemini-4-neon-high           Gemini 4 Neon (High)
gemini 3.8 flash low         Gemini 3.8 Flash (Low)
MODEL_PLACEHOLDER_M403       枚举名
```

模型是**按代理分别保存**的：一个代理的模型名对另一个没有意义。

## 选对话

```
bridge_conversations                     # 先看有哪些
bridge_select({conversationId})          # 定下来
bridge_select({create:true, workspace})  # 新建并绑定工作区
```

绑定工作区后对方才能读该目录下的文件。不指定时，桥接会优先复用已经绑定当前项目的最新对话。

固定的对话如果被代理自己回收了（会话过期、被清理），桥接**会自动换一个可用的并写回配置**，
不会一直报 `trajectory not found`。

## 自动协作的开销控制

自动协作默认**关闭**，因为它会为每个回合增加一次真实调用。

开启后也不是每轮都送审——一轮满足任一条件才触发：

- 这一轮产生了**新的 git commit**
- 改动了 **≥3 个不同文件**（同一文件改多次算一个）
- 消息里显式写了 **`[[review]]`**

低于门槛的轮次静默跳过，日志记 `skip: small change`。
门槛可调：`bridge_auto({minEdits: 5})`，`minEdits: 0` 恢复"每轮都送"。

提示词要求对方给**整块计划**而不是逐条微调；若确实无话可说，只回一行
`NO_ACTION: <理由>`，桥接记录后保持沉默，不会为"没有意见"白烧一个回合。

## 关于 30 秒工具上限

宿主写死 `MCP_TOOL_TIMEOUT_MS = 30000`：任何 MCP 工具调用超过 30 秒都会被杀掉，返回结果全丢。
这个值插件改不了，所以 `bridge_ask` / `bridge_review` 用**软等待**：

- 最多等 **22 秒**（`BRIDGE_WAIT_MS` 可覆盖）
- 没答完就返回 `{awaitingReply: true, conversationId}` 票据，**不要重发**
- 再用 `bridge_fetch` 取回；它会记住票据里的起始位置，不会把旧回复当成新答案

hooks 不受这个限制（独立预算），所以自动送审可以等满 `auto.timeoutMs`。

## 安全边界

- **所有流量留在本机。** Antigravity 走后，本来就是 `127.0.0.1`；ACP 与 CLI 是子进程 stdio。
- **提示词从不经过 shell。** `cli` 后端把文本写进 stdin 或作为单个 argv 元素；参数模板里
  的 `{prompt}` 是字符串替换，不经过任何 shell 解析。
- **hooks 永不阻塞。** 每条错误路径都 `exit 0` 且无输出＝"没有补充"。
- **自动协作默认关闭**，且有多重防循环：`stop_hook_active` 立即退出、同轮指纹去重、
  过短消息跳过、冷却、代理不可用时静默退出。
- **不驱动 UI、不截图。** 通过各代理自己的程序接口。

## 扩展一个新代理

**先试 `cli` 配置** —— 覆盖大部分情况，不用写代码：

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

需要流式、对话列表或协议级控制时，写一个后端：

```js
// src/backends/myagent.mjs
import { Backend, BridgeError } from '../core/contract.mjs';

export class MyAgentBackend extends Backend {
  static get type() { return 'myagent'; }
  static get label() { return 'My Agent'; }

  async available() { /* 探测是否可用 */ return { ok: true }; }
  async listModels() { return []; }
  async listConversations() { return []; }
  async start({ workspace }) { /* 返回 {id, workspaces} */ }
  async send({ conversationId, text }) { /* 不等待 */ }
  async read({ conversationId }) { /* {turns, errors, status} */ }
  async wait({ conversationId, fromIndex, timeoutMs }) { /* 返回 {reply, turns, ...} */ }
}
```

然后在 `src/core/registry.mjs` 里注册两行。**core 不需要任何改动。**

`Backend` 的完整契约（字段含义、`fromIndex` 语义、可选方法）见
[`src/core/contract.mjs`](src/core/contract.mjs) 的注释——那里是唯一的权威定义。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `Antigravity is not running` | 桌面应用没启动，或版本过旧没写发现文件 |
| `missing CSRF token` | 桥接会自动重读发现文件；持续失败就重启 Antigravity |
| `plan model not specified` | 对话是桥接外建的；用 `bridge_select({create:true})` 新建 |
| `unknown model "..."` | 报错里列了可用项；或用 `bridge_models` 查 |
| `unknown backend "..."` | 该 id 不在配置的 `backends` 里；用 `bridge_agents` 看实际有哪些 |
| ACP 调用立刻失败 | 手动跑一遍 `command` + `args`，看是不是启动命令本身有问题 |
| 自动协作不触发 | `bridge_status` 看 `automation.onStop`；检查门槛与消息长度 |

日志：`$ZCODE_PLUGIN_DATA/hook.log`
配置：`$ZCODE_PLUGIN_DATA/config.json`

## 自测

```bash
node scripts/smoke-test.mjs                     # 只读：状态、代理、模型、对话
node scripts/smoke-test.mjs ask "问题"           # 真实提问
node scripts/smoke-test.mjs ask "问题" codex     # 指定后端
node scripts/smoke-test.mjs full                # 新建对话 + 提问
node scripts/smoke-test.mjs review              # 真实送审
```

用 `BRIDGE_DATA_DIR` 指向临时目录，就不会动到真实配置：

```bash
BRIDGE_DATA_DIR=/tmp/bridge-test node scripts/smoke-test.mjs
```

## 目录结构

```
src/
  core/
    contract.mjs    Backend 契约（唯一的权威定义）
    registry.mjs    后端注册与实例池
    config.mjs      配置探测、迁移、读写
    session.mjs     会话编排、软等待、票据
    brief.mjs       提示词构造
  backends/
    antigravity.mjs 本地 RPC
    acp.mjs         Agent Client Protocol
    cli.mjs         一次性 CLI 进程
  mcp/
    server.mjs      10 个 MCP 工具
hooks/
  _shared.mjs       hook 公共逻辑（日志、状态、防循环）
  stop-bridge.mjs   回合结束送审
  error-bridge.mjs  工具失败求援
commands/           /antigravity-ask 等
skills/             自动触发的技能描述
scripts/smoke-test.mjs
```

## License

MIT。见 [LICENSE](LICENSE)。
