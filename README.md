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
| **任何 CLI 代理** | `cli` | 模型（可配）| 一次调用一个进程：Codex、MiMo-Code、ZCode、`claude -p`、自研脚本 |
| **新代理** | 新增文件 | — | `src/backends/your.mjs` + 注册表两行 |

`cli` 后端是刻意设计成**零代码扩展点**的：大多数代理都能 `agent --prompt` 或从 stdin 读，
所以接一个陌生代理往往只要在配置里写清命令、参数模板和输出位置。

### 各代理怎么接

| 工具 | 入口 | 接法 |
|---|---|---|
| Antigravity | 桌面应用本地 RPC | `type: "antigravity"`，无需配置 |
| ZCode | `zcode -p`（无头单次）| `type: "cli"`，**自动探测**（见下）|
| Codex | `codex exec` | `type: "cli"` + `{prompt}` 参数模板 |
| DeepSeek Harness | `demo:acp` 脚本 | `type: "acp"` + **自己 provider 的 cordis 配置**（见下）|
| MiMo-Code | `mimo run` | `type: "cli"`，模型在它自己的 `mimocode.jsonc` 里配 |

**ZCode 会自动注册为对等方**，不占默认目标：探测到安装目录里的
`resources/glm/zcode.cjs` 就写入一个 `zcode` 后端（`--prompt` + `--json` + `--mode plan`，
只读）。这样别的代理也能反过来问你。用自己的路径覆盖：`ZCODE_CLI_PATH=<…/zcode.cjs>`。

**DeepSeek Harness 有个坑**：仓库自带的 `examples/acp-agent/cordis.yml` 硬编码官方直连
（`provider: deepseek-official`），用你自己的网关会在每轮报
`no API key for provider route "deepseek-official"`——会话能建，对话必失败。
模板见 [`examples/dsh-custom-provider.cordis.yml`](examples/dsh-custom-provider.cordis.yml)。

**MiMo-Code 同理**：`mimo run` 没有 `--json` 输出，所以用 `output: "text"`；
模型不由桥接传参，改它自己的配置文件。

## 任意两个代理互通

桥接不只是"ZCode 问别人"。两个机制合起来，任意两个代理都能互相调用：

1. **`bin/bridge.mjs` 是一个独立 CLI。** 任何能跑 shell 命令的代理——Codex、MiMo、
   cron、git hook——都能用它，不需要 MCP。
2. **每个后端都会被自动探测成对等方。** ZCode 自己也是其中一个。

```bash
bridge ask "这个设计站得住吗？" --target codex --caller zcode
bridge review --file NOTES.md --target zcode --caller codex
bridge status --json
```

`--caller` 是发起方身份（也可用 `BRIDGE_CALLER`）。它有两个作用：路由时**排除自己**
（代理问自己没有第二意见），以及把双向的同一对代理归到同一把锁上。

`--target` 除了 backend id，还接受 `auto`（第一个可用的其他代理）和 `random`
（在多个可用代理里随机——三个以上代理时这是真正拿到多样性的办法）。

### 为什么必须有防循环

两个能互相调用的代理一定会互相调用到天荒地老：A 一轮结束请 B 审查，B 结束又请 A 审查。
所以有三层防护，最关键的是第一层：

| 机制 | 覆盖场景 | 说明 |
|---|---|---|
| **租约文件** `leases.json` | 常驻进程 | 发送期间持有这对代理的租约，同时第二轮被拒。5 分钟后自动过期 |
| `BRIDGE_HOP` 环境变量 | 子进程 | 后端 spawn 子进程时 +1；嵌套的桥接拒绝再转发 |
| 自身排除 | 所有路径 | `auto`/`autoBackend` 永不返回发起方自己 |

**为什么不能只靠环境变量**：一个常驻进程（MCP server、编辑器的语言服务器）在启动时继承
环境，然后活好几天。父进程早就退出了，它设的环境变量对常驻进程来说是隐形的——所以
纯 env 方案会静默失效。租约文件是跨进程的，这才是有效的那一层。

租约是**限速**不是锁：它只阻止同一对代理同时跑两轮，不阻止先后两轮。被拒绝时错误信息
会说明还剩几秒，且方向对称——A→B 和 B→A 共用一把锁，否则一个双人乒乓就是两个互不
相干的"无辜"配对。

### 反向通道怎么建立

CLI 类代理（Codex / MiMo / ZCode）靠子进程里的 `bridge` 命令反向调用，不需要配置。
ACP 类代理没有 shell，只能通过协议给它的工具集说话——所以要把桥接**作为 MCP server
交给它**：

```json
"deepseek": {
  "type": "acp",
  "reverseBridge": true,
  "...": "其余同前"
}
```

`reverseBridge: true` 时，`session/new` 会带上一个 stdio MCP server 条目，对方随即拥有
`bridge_*` 工具，可以再问第三个代理。默认关闭：它扩大了对方能做的事，且每次调用都算你的
额度。

两件事容易错：

- **`env` 在 ACP 里是数组 `[{name, value}]`**，不是其他配置格式用的对象。写错时多数
  代理会静默地用空环境启动，于是 `BRIDGE_CALLER` 丢失、回调用无法归因，防循环跟着失效。
- **`command` 用绝对路径**（`process.execPath` + server 脚本绝对路径）。对端的工作目录
  不是你的仓库目录。

### 让宿主自动配好反向通道

```bash
bridge setup --host all --dry-run    # 先看会改什么
bridge setup --host all              # 写入（每份配置留一个 .bridge-backup）
```

支持 ZCode / Codex / Claude Code，各自用自己的格式（Codex 是 TOML 的
`[mcp_servers.X]` + `[mcp_servers.X.env]` 子表）。三条安全规则：

- 文件不存在时**只打印**该粘贴的块，不创建（猜格式比不写更糟）
- 已有不同内容时不动，除非 `--overwrite`
- Codex 里已有同名表时**拒绝**改写——在 TOML 里按文本查找表的结尾，误删相邻配置是很容易的

每次真正写入都会留下 `<file>.bridge-backup`。

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

ZCode 里的斜杠命令：

| 命令 | 作用 |
|---|---|
| `/antigravity-ask <问题>` | 把问题发给协作代理，拿回分析后继续做 |
| `/antigravity-review [重点]` | 把本轮工作总结送审，按风险修正后继续 |
| `/antigravity-config` | 看状态、换代理、换对话、换模型、开关自动协作 |

（命令名沿用历史前缀，功能已不限于 Antigravity。）

独立 CLI（任何代理都能调）：

| 命令 | 作用 |
|---|---|
| `bridge status [--json]` | 配置、在线状态、当前租约、最近一次协作 |
| `bridge agents [--json]` | 每个代理的类型/在线/模型数，并标出哪个是发起方自己 |
| `bridge ask <问题>` | 提问并等待；`--target` 指定对方 |
| `bridge review [总结]` \| `--file <path>` | 送审 |
| `bridge fetch` | 取回上一轮的回答，不重新发送 |
| `bridge select` | 固定对话/模型（`--create` 新建）|
| `bridge leases [--clear]` | 看/清防循环租约 |

退出码：`0` 已回答、`3` 已受理待 `fetch`、`2` 用法或运行错误。调用方可以据此分支。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `bridge_status` | 配了哪些代理、哪些在线、当前路由、最近一次协作 |
| `bridge_agents` | 每个代理的能力：类型、在线、模型、对话数 |
| `bridge_models` | 某代理的可用模型（含配额） |
| `bridge_conversations` | 某代理的对话列表（标题、时间、工作区） |
| `bridge_select` | 设定默认代理/对话/模型；带 `conversationId` 时模型只绑该对话；`create:true` 新建并绑定工作区 |
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
  "maxHops": 1,                        // 最多允许转发几跳（1 = 发起方问一次，对方不得再转）
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
| `reverseBridge` | `true` 时把桥接自己作为 MCP server 交给对方，**让 ACP 代理也能反向调用**（见下）|
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

### 现成的配置片段

**ZCode**（自动探测；手写时是这样）：

```json
"zcode": {
  "type": "cli",
  "name": "ZCode",
  "command": "C:/Program Files/nodejs/node.exe",
  "args": ["I:/zcode/resources/glm/zcode.cjs", "--prompt", "{prompt}", "--json", "--mode", "plan"],
  "output": "json",
  "jsonPath": "response",
  "timeoutMs": 300000
}
```

`--json` 打印的是**一个美化过的 JSON 对象**（不是 JSONL），答复在 `response` 字段。
`--mode plan` 让它只读；想让它能改文件就换成 `edit`。

**Codex**（`codex exec`，答案同时写文件更可靠）：

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

**MiMo-Code**（`mimo run`，无 JSON 输出，模型改它自己的 `mimocode.jsonc`）：

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

`--dangerously-skip-permissions` 让它在无人值守时不弹确认；这会允许对方直接改文件，
只想让它做只读审查的话，去 MiMo 自己的配置里收紧权限。

**DeepSeek Harness**（ACP，必须换成你自己的 provider 配置）：

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

`env` 不能省：ACP 入口只读自己 cwd 下的 `.env`，桌面端凭据库里的 key 它看不到。
`cordis.local.yml` 的模板见 [`examples/dsh-custom-provider.cordis.yml`](examples/dsh-custom-provider.cordis.yml)。

## 选模型

模型名可以写任意一种，写错会立刻列出可用项：

```
claude-sonnet-5-5-low        Claude Sonnet 5.5 (Low)
gemini-4-neon-high           Gemini 4 Neon (High)
gemini 3.8 flash low         Gemini 3.8 Flash (Low)
MODEL_PLACEHOLDER_M403       枚举名
```

模型是**按代理分别保存**的：一个代理的模型名对另一个没有意义。

### 一个对话用一个模型

默认模型对该代理的**所有**对话生效。要给某个对话单独指定——比如某条送审对话要用更强的模型——
把 `conversationId` 和 `model` 一起传给 `bridge_select`：

```
bridge_select({conversationId: "e7de37d6-…", model: "gemini 4 neon medium"})
```

这样模型只绑在那一个对话上，**全局默认不动**，其他窗口的对话不受影响。
返回值里的 `effectiveModel` 就是该对话实际会用的模型，可以直接确认是否生效。

取值优先级（越靠前越优先）：

| 优先级 | 来源 |
|---|---|
| 1 | 本次调用显式传的 `model` |
| 2 | 绑定在该对话上的模型 |
| 3 | 自动协作时用 `autoModel`，否则用 `model` |

显式参数排在绑定之前：绑定是**那个对话**的长期默认，参数是**这一次**的决定，更具体的那个赢。
反过来的顺序也没有必要——Stop hook 与 error hook 根本不传 `model`，它们永远会落到绑定上；
让绑定优先只会让"在这个已绑定的对话上临时换一次模型"被静默忽略。

传空字符串解除绑定，之后回落到全局默认：

```
bridge_select({conversationId: "e7de37d6-…", model: ""})
```

`bridge_select({create:true, model:"…"})` 新建对话时会把模型绑到新对话上，
同样不改全局默认。要改全局默认，就不要传 `conversationId`。

写入 `config.json` 时每次都重新读盘再改，并在进程内串行化。多个窗口同时改配置时，
后写的不会把先写的覆盖回旧值——这是 `state.json` 当初那个 bug 的同源问题。

## 选对话

```
bridge_conversations                     # 先看有哪些
bridge_select({conversationId})          # 固定下来
bridge_select({create:true, workspace})  # 新建并绑定工作区
```

### 每个会话有自己的对话

不指定对话时，桥接按下面的顺序决定用哪个，**越靠前越优先**：

1. 显式传了 `conversationId` —— 用它
2. 当前 ZCode 会话自己的映射（按 `session_id`）—— 用它
3. 当前工作目录的映射 —— **仅当调用方没有会话身份时**（脚本、命令行）
4. 配置里的固定对话 —— **仅当前两个都没有时**

都没有就新建一个，并且只记到 `state.json`，**不写进 `config.json`**。

这一条很关键：`config.json` 是所有窗口共用的一份。自动选中的对话一旦写进去，
下一轮所有窗口都会读到它 —— 两个不相干的项目被塞进同一个对话，内容互相串台。
所以自动映射只落在 `state.json` 的 `sessionConversations` / `workspaceConversations` 里，
按会话和工作目录分别记录。`config.json` 里的固定对话只代表用户**手动**指定过的东西。

同一个项目开两个窗口也是两条独立对话：`session_id` 优先于工作目录映射，
否则“同一个项目”就会把两个窗口重新合并成一条。不同对话可以并行，
但同一对话里并发两轮会被拒绝（会互相插话）；反向调用（A→B 时 B 又调 A）也会被拒绝。

绑定的对话如果被代理自己回收了（会话过期、被清理），桥接会**新建一个**并只在 `state.json`
里更新该会话的映射，不会一直报 `trajectory not found`，也不会把别的对话猜给你。

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
npm test                                        # 41 个单元/协议测试，无需任何代理在线
```

```bash
node scripts/smoke-test.mjs                     # 只读：状态、代理、模型、对话
node scripts/smoke-test.mjs ask "问题"           # 真实提问
node scripts/smoke-test.mjs ask "问题" codex     # 指定后端
node scripts/smoke-test.mjs full                # 新建对话 + 提问
node scripts/smoke-test.mjs review              # 真实送审
```

`npm test` 覆盖的是那些**出错时不会响**的地方：租约的方向对称性与过期、hop 计数、
`{prompt}` 占位符的四种走法、目标解析的自排除、以及 ACP 的 `mcpServers` 是否按 schema
发出（用一个真的子进程跑真 JSON-RPC，而不是 mock 对象）。

用 `BRIDGE_DATA_DIR` 指向临时目录，就不会动到真实配置：

```bash
BRIDGE_DATA_DIR=/tmp/bridge-test node scripts/smoke-test.mjs
```

## 目录结构

```
src/
  core/
    contract.mjs    Backend 契约（唯一的权威定义）
    registry.mjs    后端注册、实例池、目标解析（自排除）
    config.mjs      配置探测、迁移、读写
    session.mjs     会话编排、软等待、票据、caller 身份
    lease.mjs       防循环：租约文件 + hop 计数
    brief.mjs       提示词构造
  backends/
    antigravity.mjs 本地 RPC
    acp.mjs         Agent Client Protocol
    cli.mjs         一次性 CLI 进程
  mcp/
    server.mjs      10 个 MCP 工具
bin/
  bridge.mjs        独立 CLI（任何代理可调用）
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
