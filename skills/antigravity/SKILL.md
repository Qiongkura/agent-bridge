---
name: antigravity
description: 与另一个编码代理协作（Antigravity、Codex、任意 ACP 或 CLI 代理）。当需要第二个智能体做代码审查、难题诊断、方案评估，或希望把 ZCode 的完成总结交给它分析并把下一步接回来继续做时使用。也用于选择协作代理、对话与模型、开关自动协作。
---

# 与协作代理协作

协作代理是另一个本机编码智能体，能直接读同一份代码。它适合做审查、找出被忽略的风险、给出下一步；不负责替你执行改动。

它可以是 Antigravity、Codex，或任何在配置里接上的 ACP / CLI 代理。**先确认要跟谁说话**，再发内容。

## 先确认可用

调用 `bridge_status`：它返回配置了哪些代理、哪些在线、当前默认目标。

- 某个代理 `online: false` — 那个客户端没开或命令不能跑，让它先起来
- `available: []` — 一个都没配上，看 `bridge_agents` 的 `detail` 说明

## 三个入口

| 场景 | 调用 |
|---|---|
| 遇到不确定的问题 | `bridge_ask({prompt})` |
| 做完了，要它审查 | `bridge_review({summary, request})` |
| 想先发后取 / 看它的最新回复 | `bridge_fetch({conversationId})` |

三个都接受 `target`（配置里的 backend id）。省略就用默认目标，`"auto"` 表示第一个可用的。

`bridge_review` 的 `summary` 要写全：做了什么、改了哪些文件、怎么验证的、还有什么没解决。对方看不到 ZCode 的对话历史，总结里没写的它一概不知道。它回的格式固定为 **分析 / 风险 / 下一步**。

## 选代理、对话和模型

`bridge_agents` 看有哪些代理，`bridge_conversations` 看某个代理有哪些对话，`bridge_models` 看某个代理有哪些模型。然后用 `bridge_select` 定下来：

- `bridge_select({target: "codex"})` — 换默认代理
- `bridge_select({conversationId: "…", model: "…"})` — 指定对话与模型
- `bridge_select({role: "review", model: "…"})` — 只给审查用途设模型
- `bridge_select({create: true, workspace: "I:\\projects"})` — 新建一个绑定该目录的对话

不指定的话，桥接会挑一个已绑定当前工作区的对话，都没有才新建。

模型可以写 id、显示名或枚举名；写错了会立刻报错并列出可用项。**模型是按代理分别保存的**——一个代理的模型名对另一个没有意义。

## 自动协作

`bridge_auto({onStop: true})` 之后，ZCode 每轮结束会把这一轮的总结发给协作代理，并把它的分析作为继续执行的理由接回当前回合——这就是"做完自动送审、拿到下一步接着干"。

`bridge_auto({onError: true})` 额外在工具失败时求援，冷却 2 分钟。

不是每轮都值得送审：默认门槛是"改了 3 个文件"或"出现新 commit"，或者消息里写 `[[review]]` 强制。用 `bridge_auto({minEdits: N})` 调，`0` 表示每轮都送。

开销提醒：`onStop` 会给每个回合都加一次调用。长期开着时选快模型，先用 `bridge_models` 看配额。不确定就先不开，用手动命令。

## 怎么用它的回答

建议是输入，不是命令。它看不到你刚跑的命令输出，也可能对项目约定有错误假设。

- 采纳前先核对它引用的文件和行号是否真的存在
- 它的"风险"段落里如果提到你没验证过的路径，去验证
- 与当前任务无关或明显错误的建议，说明理由后忽略，不要盲从

## 超时与票据

每次工具调用受宿主约 30 秒上限约束。对方没答完时 `bridge_ask` 会返回 `awaitingReply: true` 和 `conversationId`——**这说明已经发送并受理了，不要重发**，用 `bridge_fetch({conversationId})` 取回。

## 出错时

- `Antigravity is not running` → 桌面应用没启动
- `missing CSRF token` → 桥接会自动重读发现文件；持续失败就重启 Antigravity
- `plan model not specified` → 该对话是在桥接外创建的，用 `bridge_select({create: true})` 新建
- 模型报未知 → `bridge_models` 看准确写法
- `unknown backend "…"` → 该 id 没在配置的 `backends` 里，用 `bridge_agents` 看实际有哪些

配置与日志在插件数据目录（`$ZCODE_PLUGIN_DATA`）：`config.json`、`state.json`、`hook.log`。
