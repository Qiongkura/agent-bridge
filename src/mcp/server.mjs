// MCP server for the agent bridge.
//
// The tools are deliberately about *collaboration*, not about any one agent:
// pick a target, ask it something, hand it a completion summary, collect the
// answer. Which agent answers is a routing decision made in config, so the same
// tool set works after swapping Antigravity for Codex, an ACP harness, or
// anything else that gets a backend.
//
// Every waiting path is bounded by the host's ~30s tool budget and returns a
// ticket when the answer is late; see ../core/session.mjs for why.
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { loadConfig, updateConfig, defaultDataDir, loadState, saveState, saveStateMerged } from '../core/config.mjs';
import { loadBackends, describeAll, backendTypes, disposeBackends, resolveTarget } from '../core/registry.mjs';
import { BridgeError } from '../core/contract.mjs';
import { converse, redeem, shapeReply, callerIdentity, normalizePath, SOFT_WAIT_MS, WAIT_TIMEOUT_DESCRIPTION } from '../core/session.mjs';
import { buildBrief, buildSummaryPrompt } from '../core/brief.mjs';
import { activeLeases } from '../core/lease.mjs';

const DATA_DIR = defaultDataDir();
// The pool keeps backend instances alive across tool calls: an ACP agent lives
// in a child process and remembers its session there, so a fresh instance per
// call would lose every conversation.
const CONTEXT = {
  dataDir: DATA_DIR,
  log: (m) => process.stderr.write(`[bridge] ${m}\n`),
  pool: new Map(),
};

// Who this server speaks for. It defaults to the host's name but can be
// overridden when a non-ZCode host launches the same MCP server — the tools
// describe the caller in their prompts and use it to avoid self-targeting.
const CALLER = callerIdentity();

// ---------------------------------------------------------------- state

// Read the config from disk on every call rather than caching it.
//
// Several MCP server processes serve several ZCode windows, and each one used to
// keep the config it read at startup and write back the whole object. Any edit
// made in one window was invisible to the others, and the next write from a
// window holding an older snapshot silently restored its stale values — the same
// lost-update bug state.json had.
//
// Loaded once here only to report first-run detection: creating the file is a
// side effect worth telling the user about, and doing it during `initialize`
// means the first tool call does not pay for detection.
const firstRun = loadConfig({ dataDir: DATA_DIR });
if (firstRun.created) {
  CONTEXT.log(
    `wrote a first-run config to ${firstRun.path} `
    + `(detected: ${Object.keys(firstRun.config.backends).join(', ') || 'nothing'})`,
  );
}

function getConfig() {
  return loadConfig({ dataDir: DATA_DIR }).config;
}

// Safe to call at any time: reports where the config lives, not what was loaded
// at startup. A stale variable here crashed `bridge_status` — the first tool
// anyone reaches for — after the startup cache was removed.
function configPath() {
  return join(DATA_DIR, 'config.json');
}

// Re-read, apply the patch, write. `patch` may be a function for the cases where
// the new value depends on the current one.
async function setConfig(patch) {
  return updateConfig(
    fresh => (typeof patch === 'function' ? patch(fresh) : patch),
    { dataDir: DATA_DIR },
  );
}

function getState() {
  return loadState({ dataDir: DATA_DIR });
}

function setState(next) {
  // Merge rather than overwrite: a tool call can block for most of a minute, and
  // writing its pre-call snapshot back would discard a conversation mapping
  // another window created while it waited.
  return saveStateMerged(next, { dataDir: DATA_DIR });
}

// ---------------------------------------------------------------- transport

const tools = [];
function tool(name, description, schema, handler) {
  tools.push({ name, description, inputSchema: schema, handler });
}

const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const num = (description) => ({ type: 'number', description });

const TARGET_DESCRIPTION =
  '目标代理：配置里的 backend id（例如 antigravity / codex / deepseek）。省略则用默认目标，'
  + '"auto" 表示第一个可用的。';

// ---------------------------------------------------------------- tools

tool(
  'bridge_status',
  '检查桥接状态：配置了哪些代理、每个是否可用、当前路由目标、最近一次协作。排查问题先调它。',
  { type: 'object', properties: {}, additionalProperties: false },
  async () => {
    const config = getConfig();
    const state = getState();
    const backends = loadBackends(config, CONTEXT);
    const agents = await describeAll(backends);
    const available = agents.filter(a => a.connected).map(a => a.id);

    return {
      path: configPath(),
      caller: CALLER,
      defaultBackend: config.defaultBackend || (available[0] || null),
      available,
      agents,
      automation: {
        onStop: config.auto.onStop,
        onError: config.auto.onError,
        continueAfterReview: config.auto.continueAfterReview,
        reviewOnStop: config.auto.reviewOnStop,
        minEdits: config.auto.minEdits,
        backend: config.autoBackend || config.defaultBackend,
      },
      selected: config.selections,
      roles: config.roles,
      // Which model each thread is bound to. Without this, "why is this
      // conversation using a different model" cannot be answered from status.
      conversationModels: config.conversationModels || {},
      // A held lease means a collaboration is in flight; seeing one stuck here
      // is the fastest way to diagnose "why does every call say busy".
      leases: activeLeases({ dataDir: DATA_DIR }),
      lastExchange: state.lastExchange,
      pending: state.pending,
      knownBackendTypes: backendTypes(),
    };
  },
);

tool(
  'bridge_agents',
  '列出所有已配置的代理及其能力：类型、是否在线、模型、对话数。用于决定把任务交给谁。',
  { type: 'object', properties: {}, additionalProperties: false },
  async () => {
    const config = getConfig();
    const backends = loadBackends(config, CONTEXT);
    const out = [];
    for (const [id, backend] of backends) {
      const entry = config.backends[id] || {};
      const check = await backend.available();
      let conversations = 0;
      try {
        conversations = (await backend.listConversations()).length;
      } catch {
        conversations = 0;
      }
      out.push({
        id,
        type: backend.constructor.type,
        label: backendLabel(backend),
        online: check.ok,
        detail: check.detail,
        model: entry.model || null,
        conversations,
      });
    }
    return { defaultBackend: config.defaultBackend, agents: out };
  },
);

tool(
  'bridge_models',
  '列出某个代理当前可选的模型，以及桥接配置里的默认模型。用于挑选模型。',
  {
    type: 'object',
    properties: { target: str(TARGET_DESCRIPTION) },
    additionalProperties: false,
  },
  async ({ target } = {}) => {
    const config = getConfig();
    const backends = loadBackends(config, CONTEXT);
    const id = target || config.defaultBackend || [...backends.keys()][0];
    const backend = backends.get(id);
    if (!backend) {
      return { target: id || null, error: `unknown backend "${id}"`, configured: [...backends.keys()] };
    }
    const models = await backend.listModels();
    const selection = config.selections?.[id] || {};
    return {
      target: id,
      selectedModel: selection.model || null,
      selectedAutoModel: selection.autoModel || null,
      models,
      hint: models.length
        ? '把模型名或显示名传给 bridge_select 的 model 参数。'
        : '该代理不提供模型列表（由命令或配置固定）。',
    };
  },
);

tool(
  'bridge_conversations',
  '列出某个代理的对话（标题、最后修改时间、绑定的工作区），用于选择要在哪个对话里协作。'
  + 'CLI 类代理每次调用都是新进程，没有对话历史，返回空列表是正常的。',
  {
    type: 'object',
    properties: {
      target: str(TARGET_DESCRIPTION),
      limit: num('最多返回多少条，默认 25'),
    },
    additionalProperties: false,
  },
  async ({ target, limit } = {}) => {
    const config = getConfig();
    const backends = loadBackends(config, CONTEXT);
    const id = target || config.defaultBackend || [...backends.keys()][0];
    const backend = backends.get(id);
    if (!backend) {
      return { target: id || null, error: `unknown backend "${id}"`, configured: [...backends.keys()] };
    }

    const conversations = await backend.listConversations();
    const n = Number(limit) > 0 ? Number(limit) : 25;
    return {
      target: id,
      selected: config.selections?.[id]?.conversationId || null,
      byRole: config.roles,
      conversations: conversations.slice(0, n),
      total: conversations.length,
    };
  },
);

tool(
  'bridge_select',
  '选择协作目标：设定默认代理、默认对话、默认模型，或按用途（review / ask / debug）分别固定。'
  + '之后发送的内容都会走这些选择。'
  + '要只给某一个对话单独指定模型，把 conversationId 和 model 一起传——全局默认不会动。',
  {
    type: 'object',
    properties: {
      target: str('默认代理 id（配置里的 backend 名字）。省略则不改'),
      conversationId: str('对话 ID。与 model 一起传时模型只作用于那个对话；'
        + '传空字符串 model 解除该对话的绑定。create:true 时不传表示新建'),
      role: str('用途标签，例如 review / ask / debug。省略则设为全局默认'),
      model: str('模型：可写 id、显示名或枚举。配合 conversationId 时只作用于那个对话；'
        + '配合 conversationId 传空字符串表示解除该对话的绑定'),
      autoModel: str('自动协作（Stop hook）时使用的模型；省略则沿用 model'),
      workspace: str('工作区绝对路径；新建对话时绑定它，让代理能读项目文件'),
      create: bool('为 true 时强制新建对话'),
    },
    additionalProperties: false,
  },
  async ({ target, conversationId, role, model, autoModel, workspace, create } = {}) => {
    const config = getConfig();
    const backends = loadBackends(config, CONTEXT);
    const backendId = target || config.defaultBackend || [...backends.keys()][0];
    const backend = backends.get(backendId);
    if (!backend) {
      throw new Error(
        `unknown backend "${backendId}". Configured: ${[...backends.keys()].join(', ') || '(none)'}`,
      );
    }

    // `model !== undefined` rather than truthiness: an empty string is the
    // documented way to *remove* a binding, and a truthiness test would silently
    // treat it as "not provided" and leave the old model in place forever.
    const clearingBinding = conversationId !== undefined && conversationId !== '' && model === '';
    let resolvedModel = null;
    if (model) {
      // A typo must fail here, in front of the user, not at 2am inside a hook.
      resolvedModel = await backend.resolveModel(model);
    }
    const resolvedAutoModel = autoModel ? await backend.resolveModel(autoModel) : null;

    // Creating has to happen before the write, because the new conversation's id
    // is only known afterwards. A model passed with `create` belongs to that new
    // conversation and must not touch the global default — that would move every
    // other window to it.
    let created = null;
    if (create) {
      created = await backend.start({
        workspace: workspace || config.workspace,
        model: resolvedModel || config.selections?.[backendId]?.model,
      });
    }
    const targetConversation = created ? created.id : conversationId;

    // One write, computed against the freshest config on disk. `updateConfig`
    // re-reads immediately before writing, so a window that edited the config a
    // second ago is not rolled back by this one.
    const next = await setConfig((fresh) => {
      const patch = {};
      if (workspace !== undefined) patch.workspace = workspace || null;
      if (target) patch.defaultBackend = target;

      const selection = { ...(fresh.selections?.[backendId] || {}) };
      const bindingMap = { ...((fresh.conversationModels || {})[backendId] || {}) };
      const writeBindings = () => {
        const all = { ...(fresh.conversationModels || {}), [backendId]: bindingMap };
        // Drop the backend entry rather than leaving `{ backend: {} }` behind: an
        // empty map is indistinguishable from a stale one when read back.
        if (!Object.keys(bindingMap).length) delete all[backendId];
        patch.conversationModels = all;
      };

      if (resolvedAutoModel) selection.autoModel = resolvedAutoModel;

      if (resolvedModel) {
        if (targetConversation) {
          bindingMap[targetConversation] = resolvedModel;
          writeBindings();
        } else {
          // Only a bare `model` with nothing to bind it to is a global default.
          selection.model = resolvedModel;
        }
      }
      if (clearingBinding && conversationId in bindingMap) {
        delete bindingMap[conversationId];
        writeBindings();
      }

      if (created) {
        selection.conversationId = created.id;
        if (role) patch.roles = { ...fresh.roles, [role]: { backend: backendId, conversationId: created.id } };
      } else if (conversationId !== undefined && conversationId !== '') {
        if (role) patch.roles = { ...fresh.roles, [role]: { backend: backendId, conversationId } };
        else selection.conversationId = conversationId;
      }

      patch.selections = { ...fresh.selections, [backendId]: selection };
      return patch;
    });

    const effectiveModel = targetConversation
      ? (next.conversationModels?.[backendId]?.[targetConversation]
        || next.selections?.[backendId]?.model
        || null)
      : (next.selections?.[backendId]?.model || null);

    if (created) {
      return {
        backend: backendId,
        conversationId: created.id,
        created: true,
        model: effectiveModel,
        modelBoundToConversation: Boolean(next.conversationModels?.[backendId]?.[created.id]),
        workspaces: created.workspaces || [],
        selections: next.selections,
        conversationModels: next.conversationModels || {},
        effectiveModel,
      };
    }

    return {
      defaultBackend: next.defaultBackend,
      selections: next.selections,
      roles: next.roles,
      workspace: next.workspace,
      conversationModels: next.conversationModels || {},
      // Say which model this thread will actually use. A binding that silently
      // failed to take effect is otherwise only visible at the next send.
      effectiveModel,
    };
  },
);

tool(
  'bridge_ask',
  '把问题或任务发给另一个代理，并等待它回复。用于遇到难题时请它分析，或让第二意见评估方案。'
  + '默认用 review/ask 角色固定的对话。',
  {
    type: 'object',
    properties: {
      prompt: str('要发送的问题描述'),
      target: str(TARGET_DESCRIPTION),
      conversationId: str('指定对话 ID，省略则用当前默认'),
      role: str('用途标签，例如 review / ask / debug'),
      model: str('本次使用的模型，省略则用默认'),
      timeoutMs: num(WAIT_TIMEOUT_DESCRIPTION),
      includeContext: bool('保留参数：附加本机环境与工作区信息'),
      // Without this a tool call has no idea which project it belongs to, so the
      // bridge could only key conversations on a global setting — which is what
      // made every window share one thread.
      cwd: str('本会话的工作区绝对路径；用于把本会话绑定到独立的对方对话'),
      sessionKey: str('本会话的稳定标识（如 ZCode 的 session_id）；不同会话不会共用对话'),
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async ({ prompt, target, conversationId, role, model, timeoutMs, includeContext, cwd, sessionKey } = {}) => {
    const config = getConfig();
    const backend = await pickBackend(loadBackends(config, CONTEXT), target || config.defaultBackend);
    const workspace = cwd || config.workspace || process.cwd();
    const text = includeContext === false
      ? prompt
      : buildBrief({
        request: prompt,
        cwd: workspace,
        kind: 'question',
        peer: backendLabel(backend),
        requester: CALLER,
      });

    const result = await converse({
      config,
      target: target || config.defaultBackend,
      prompt: text,
      role,
      conversationId,
      model,
      workspace,
      sessionKey,
      timeoutMs,
      context: CONTEXT,
      state: getState(),
      caller: CALLER,
      onStateChange: (next) => setState(next),
      onRepair: repairPin,
    });
    return describeForCaller(result, config, { backend: backendLabel(backend) });
  },
);

tool(
  'bridge_review',
  '把一段完成总结发给另一个代理请求审查，并取回分析与下一步建议。'
  + '"做完工作后请人复核"的标准入口。',
  {
    type: 'object',
    properties: {
      summary: str('完成情况总结：做了什么、改了哪些文件、验证方式、仍存的问题'),
      request: str('希望它重点审查什么；省略则做整体审查'),
      target: str(TARGET_DESCRIPTION),
      conversationId: str('指定对话 ID'),
      role: str('默认使用 review 角色对话'),
      model: str('本次使用的模型'),
      timeoutMs: num(WAIT_TIMEOUT_DESCRIPTION),
      cwd: str('工作区路径，用于告知对方去哪里看代码，并绑定本会话的对方对话'),
      sessionKey: str('本会话的稳定标识；不同会话不会共用对话'),
    },
    required: ['summary'],
    additionalProperties: false,
  },
  async ({ summary, request, target, conversationId, role = 'review', model, timeoutMs, cwd, sessionKey } = {}) => {
    const config = getConfig();
    const backend = await pickBackend(loadBackends(config, CONTEXT), target || config.defaultBackend);
    const workspace = cwd || config.workspace || process.cwd();
    const prompt = buildSummaryPrompt({
      summary,
      request,
      cwd: workspace,
      peer: backendLabel(backend),
      requester: CALLER,
    });

    const result = await converse({
      config,
      target: target || config.defaultBackend,
      prompt,
      role,
      conversationId,
      model,
      workspace,
      sessionKey,
      timeoutMs,
      context: CONTEXT,
      state: getState(),
      caller: CALLER,
      onStateChange: (next) => setState(next),
      onRepair: repairPin,
    });
    return describeForCaller(result, config, { backend: backendLabel(backend) });
  },
);

tool(
  'bridge_fetch',
  '读取某个对话的最新回复，不发送新内容。适合先发后取，或查看自动协作的结果。'
  + '若上一轮 ask/review 超时返回了票据，直接调用它即可取回，不要重发。',
  {
    type: 'object',
    properties: {
      target: str(TARGET_DESCRIPTION),
      conversationId: str('对话 ID，省略则按 role → 最后一张待取票据 → 当前默认的顺序解析'),
      role: str('用途标签，例如 review；用于找回该角色对应的对话'),
      sinceTurns: num('只取最后 N 轮，默认 4'),
      wait: bool('为 true 时强制等待其空闲（最多等 timeoutMs）'),
      timeoutMs: num(WAIT_TIMEOUT_DESCRIPTION),
      cwd: str('本会话的工作区；用于找到本会话自己的对话，而不是别的窗口的'),
      sessionKey: str('本会话的稳定标识；优先于 cwd'),
    },
    additionalProperties: false,
  },
  async ({ target, conversationId, role, sinceTurns, wait, timeoutMs, cwd, sessionKey } = {}) => {
    const config = getConfig();
    const state = getState();
    const pending = state.pending || [];

    const effectiveTarget = target || pending[pending.length - 1]?.backend || config.defaultBackend;

    // A ticket may belong to a review-thread conversation that is not the global
    // default, so try role and the newest pending ticket before falling back.
    // Otherwise a bare fetch() silently polls the wrong thread.
    //
    // The conversation this session was given comes first: "newest pending
    // ticket" is a global guess, and with two windows open it returns the other
    // window's thread.
    const rolePin = role ? config.roles?.[role] : null;
    const mine = sessionKey
      ? state.sessionConversations?.[effectiveTarget]?.[sessionKey]
      : (cwd
        ? state.workspaceConversations?.[effectiveTarget]?.[normalizePath(cwd)]
        : null);

    const id = conversationId
      || mine
      || (rolePin && (!rolePin.backend || rolePin.backend === effectiveTarget)
        ? rolePin.conversationId
        : null)
      || pending[pending.length - 1]?.conversationId
      || config.selections?.[effectiveTarget]?.conversationId;

    // A pending ticket names the backend that owns the thread; without it a
    // multi-backend install would poll whichever backend happens to be default.
    const ticket = pending.find(p => p.conversationId === id);

    const result = await redeem({
      config,
      target: ticket?.backend || effectiveTarget,
      conversationId: id,
      role,
      wait: wait || Boolean(ticket),
      timeoutMs,
      context: CONTEXT,
      state,
      caller: CALLER,
      onStateChange: (next) => setState(next),
      onRepair: repairPin,
    });
    return describeForCaller(result, config, { sinceTurns });
  },
);

tool(
  'bridge_auto',
  '开关自动协作：每轮结束时自动把总结发给另一个代理；可选择让它把下一步接回 ZCode 继续做，'
  + '或只保存审查意见等你自己取。',
  {
    type: 'object',
    properties: {
      onStop: bool('每轮结束自动发送（会消耗对方配额）'),
      onError: bool('ZCode 遇到工具失败时自动求援'),
      reviewOnStop: bool('自动发送时要求审查，而不只是简报'),
      continueAfterReview: bool(
        '收到审查后让 ZCode 继续执行（默认 true）。设为 false 则只保存，用 bridge_fetch 查看',
      ),
      minEdits: num(
        '一轮至少改动多少个文件才送审，默认 3；设为 0 表示每轮都送。'
        + '新 commit 或消息里写 [[review]] 会跳过这个门槛',
      ),
      target: str('自动协作使用的代理 id；省略则用默认目标'),
      model: str('自动协作使用的模型'),
      role: str('自动协作使用的对话用途标签'),
    },
    additionalProperties: false,
  },
  async ({ onStop, onError, reviewOnStop, continueAfterReview, minEdits, target, model, role } = {}) => {
    const config = getConfig();

    // An automatic model is validated against the agent that automation actually
    // uses, not the interactive default: they may be different agents.
    let resolvedAutoModel = null;
    if (model) {
      const backendId = target || config.autoBackend || config.defaultBackend;
      const backend = loadBackends(config, CONTEXT).get(backendId);
      if (!backend) throw new Error(`unknown backend "${backendId}" for autoModel "${model}"`);
      resolvedAutoModel = await backend.resolveModel(model);
    }

    // Computed against the freshest config inside the write. Building `auto` from
    // the snapshot read above would restore every other flag as it was then,
    // undoing a change another window made meanwhile.
    const next = await setConfig((fresh) => {
      const auto = { ...fresh.auto };
      if (onStop !== undefined) auto.onStop = !!onStop;
      if (onError !== undefined) auto.onError = !!onError;
      if (reviewOnStop !== undefined) auto.reviewOnStop = !!reviewOnStop;
      if (continueAfterReview !== undefined) auto.continueAfterReview = !!continueAfterReview;
      if (minEdits !== undefined) auto.minEdits = Math.max(0, Number(minEdits) || 0);
      if (role !== undefined) auto.role = role || 'review';

      const patch = { auto };
      if (target !== undefined) patch.autoBackend = target || null;

      if (resolvedAutoModel) {
        const backendId = target || fresh.autoBackend || fresh.defaultBackend;
        const selection = { ...(fresh.selections?.[backendId] || {}) };
        selection.autoModel = resolvedAutoModel;
        patch.selections = { ...fresh.selections, [backendId]: selection };
      }
      return patch;
    });
    const gate = next.auto.minEdits === 0 ? '每轮' : `${next.auto.minEdits} 个文件或新 commit`;
    const autoBackendId = next.autoBackend || next.defaultBackend;
    return {
      onStop: next.auto.onStop,
      onError: next.auto.onError,
      reviewOnStop: next.auto.reviewOnStop,
      continueAfterReview: next.auto.continueAfterReview,
      minEdits: next.auto.minEdits,
      backend: autoBackendId,
      model: next.selections?.[autoBackendId]?.autoModel || next.selections?.[autoBackendId]?.model || null,
      role: next.auto.role,
      note: next.auto.onStop
        ? (next.auto.continueAfterReview
          ? `已开启（门槛：${gate}）。每轮结束会把总结发出去，收到分析后自动继续执行。`
          : `已开启（门槛：${gate}）。每轮结束会把总结发出去并保存审查意见；不会自动续跑，用 bridge_fetch 查看。`)
        : '已关闭自动协作。仍可随时用 bridge_ask / bridge_review 手动协作。',
    };
  },
);

tool(
  'bridge_ping',
  '最小连通性测试：向目标代理发一句问候并等待回复，用来确认整条链路可用。',
  {
    type: 'object',
    properties: {
      target: str(TARGET_DESCRIPTION),
      model: str('测试用模型，建议选快模型'),
      timeoutMs: num('等待上限，默认 22000（受宿主 30 秒工具上限夹紧）'),
    },
    additionalProperties: false,
  },
  async ({ target, model, timeoutMs } = {}) => {
    const config = getConfig();
    const result = await converse({
      config,
      target: target || config.defaultBackend,
      prompt: '这是多代理桥接插件的连通性测试。请只回复一行：BRIDGE_OK 加上你当前的模型名。',
      model: model || null,
      timeoutMs: timeoutMs || SOFT_WAIT_MS,
      context: CONTEXT,
      state: getState(),
      onStateChange: (next) => setState(next),
      onRepair: repairPin,
    });
    return describeForCaller(result, config, { sinceTurns: 2 });
  },
);

// ---------------------------------------------------------------- helpers

// A pinned conversation the agent has forgotten must not be retried forever.
// Recording the replacement keeps later calls working without a config edit.
async function repairPin({ backend, role, stale, conversationId }) {
  // Every check happens inside the write, against the config on disk now. Testing
  // the snapshot taken before the exchange would miss a newer repair and write
  // the old pin back — undoing it.
  await setConfig((fresh) => {
    const patch = {};
    if (role && fresh.roles?.[role]?.conversationId === stale) {
      patch.roles = { ...fresh.roles, [role]: { backend, conversationId } };
    }
    const selection = { ...(fresh.selections?.[backend] || {}) };
    if (selection.conversationId === stale) {
      selection.conversationId = conversationId;
      patch.selections = { ...fresh.selections, [backend]: selection };
    }
    return patch;
  });
}

// Resolve a target for a tool call, with the caller's own identity excluded.
// Using the real resolver (rather than "first backend in the map") means the
// tools honour "auto" and "random" and refuse to address the agent that asked.
async function pickBackend(backends, id) {
  if (!backends.size) {
    throw new BridgeError(
      '还没有配置任何代理。编辑配置文件的 backends 一节，或先安装一个受支持的客户端。',
      { code: 'no_backends' },
    );
  }
  return resolveTarget(backends, id, { caller: CALLER });
}

function backendLabel(backend) {
  const label = backend?.label;
  return typeof label === 'string' ? label : (backend?.id || '协作方');
}

// Wrap the core's reply shape with what the caller needs to act on it.
function describeForCaller(result, config, { sinceTurns, backend } = {}) {
  const shaped = shapeReply(result, config, { sinceTurns, backendLabel: backend });
  if (!result.awaitingReply) return shaped;

  return {
    ...shaped,
    awaitingReply: true,
    hint: '已发送并受理，但对方还没答完（本机 MCP 工具调用上限 30 秒）。不要重发——用 bridge_fetch 取回结果。',
  };
}

// ---------------------------------------------------------------- JSON-RPC

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Tool handlers are async and can run for minutes. Keep the process alive until
// every in-flight call has answered, otherwise a client that closes stdin after
// writing (pipes, tests) would cut the reply off.
let inFlight = 0;
let stdinClosed = false;
function maybeExit() {
  // Never call process.exit here: stdout is a pipe and writes are async, so
  // exiting would truncate the very reply we just produced. Closing the reader
  // and letting the loop drain is what ends the process.
  if (stdinClosed && inFlight === 0) {
    rl.close();
    process.stdin.pause();
    // Release child processes last: an ACP agent would otherwise keep the event
    // loop alive and the server would never exit after the host disconnects.
    disposeBackends(CONTEXT);
  }
}
rl.on('close', () => {
  stdinClosed = true;
  maybeExit();
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-bridge', version: '2.1.0' },
      instructions:
        '用这些工具让另一个代理参与协作：bridge_ask 提问，bridge_review 请它审查完成总结，'
        + 'bridge_fetch 取回回复，bridge_auto 开关每轮自动协作。先 bridge_status 确认哪个代理在线，'
        + '再用 bridge_select 选定目标与模型。',
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') {
    respond(id, {
      tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const found = tools.find(t => t.name === name);
    if (!found) {
      respondError(id, -32602, `未知工具: ${name}`);
      return;
    }
    inFlight += 1;
    try {
      const args = params?.arguments || {};
      const out = await found.handler(args);
      respond(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        isError: false,
      });
    } catch (err) {
      respond(id, {
        content: [{ type: 'text', text: `调用失败: ${err.message}` }],
        isError: true,
      });
    } finally {
      inFlight -= 1;
      maybeExit();
    }
    return;
  }
  if (method === 'ping') {
    respond(id, {});
    return;
  }
  if (id !== undefined) respondError(id, -32601, `未知方法: ${method}`);
});

// A broken pipe just means the host closed the session; exit quietly, but kill
// the agent children first so none of them are left orphaned.
const shutdown = () => {
  disposeBackends(CONTEXT);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  process.stderr.write(`bridge uncaught: ${err?.stack || err}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`bridge unhandled: ${err?.stack || err}\n`);
});
