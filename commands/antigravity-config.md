---
description: 选择协作代理、对话与模型，或开关自动协作
---

管理协作桥的配置。用户输入：$ARGUMENTS

按用户的意图处理：

**查看现状** — 调用 `bridge_status`，报告配置了哪些代理、哪些在线、当前默认目标、自动协作开关。

**换代理** — `bridge_agents` 列出所有已配置的代理及其在线状态，用户选定后 `bridge_select({target})`。
代理是在配置文件的 `backends` 里定义的（`src/core/config.mjs` 的检测会在首次运行时自动写入）。

**换对话** — 先 `bridge_conversations` 列出对话（带标题、时间、工作区），让用户挑；用户选定后 `bridge_select({conversationId})`。
CLI 类代理每次调用都是新进程，没有对话历史，返回空列表是正常的。

**换模型** — `bridge_models` 列出该代理可用模型与配额，用户选定后 `bridge_select({model})`。
模型按代理分别保存——一个代理的模型名对另一个没有意义。

**新建对话** — `bridge_select({create: true, workspace: "<当前项目绝对路径>"})`。绑定工作区后对方才能读项目文件。

**开关自动协作** — `bridge_auto({onStop: true})` 让每轮结束自动送审并接回下一步；`{onStop: false}` 关闭。
同时提醒用户这会消耗对方配额。`{minEdits: N}` 控制门槛（默认 3 个文件或一次新 commit 才送审）。

如果 `$ARGUMENTS` 为空或意图不明，先展示现状，再问要改哪一项。不要一次问多个问题。
