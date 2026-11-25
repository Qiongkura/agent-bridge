// Prompt construction for the bridge.
//
// The other agent starts cold: it has no idea what this session did unless we
// say so. Every brief therefore carries the same scaffolding — who is asking,
// where the code is, what shape the answer should take. The peer's name is a
// parameter, not a constant, because the same brief goes to any backend.
//
// Keep this file free of transport concerns; it only builds strings.

export const OUTPUT_RULES = `回答要求：
- 直接给结论，不要复述我发来的内容，不要客套。
- 用中文回答。
- 需要读代码时直接读，不要先问我要更多信息。

**颗粒度（最容易做错的地方，务必遵守）：**
你给出的是"接下来一整块工作"，不是逐步微调。一次回复要覆盖未来若干步：先做什么、
再做什么、什么条件下收手，让发起方能够连续执行很久而不必回来问。把同类问题合并成一批给出，
不要一次只提一个小改动然后等下一轮。

**不要在琐碎改动上表态。** 变量改名、格式调整、单行修补、写一段文档、补一条注释这类事，
除非确有事实错误，否则不要评论、不要给建议、不要要求确认。

**只在真有问题时才展开。** 仅当当前方向会造成返工、数据失效或口径不实时才提出；否则默认放行，
把篇幅留给后续计划。

正常回复用三段结构：**分析**（问题根因或改动质量）、**风险**（可能出错的地方，没有就写
"未发现明显风险"）、**下一步**（覆盖未来若干步的计划，指明改哪个文件或跑什么命令）。

如果这一轮确实没有任何值得说的（改动太小、或完全正确且无需后续），整条回复只写一行：
\`NO_ACTION: <不超过 20 字的理由>\`
这种情况下不要写三段结构，不要客套。`;

function roleLine(peer) {
  return `你是 ${peer}，正在与另一个编码智能体协作。对方负责在本机执行改动，你负责分析、审查与给出下一步。`;
}

function workspaceLine(cwd) {
  if (!cwd) return '';
  return `代码位置：${cwd}（可直接读取该目录下的文件）`;
}

export function buildBrief({ request, cwd, kind = 'question', peer = '协作方', requester = '发起方' }) {
  const header = kind === 'question'
    ? `${requester} 在执行任务时遇到需要判断的地方，向你请教。`
    : `${requester} 需要你的分析。`;

  return [
    roleLine(peer),
    '',
    header,
    workspaceLine(cwd),
    '',
    `${requester} 的描述：`,
    '"""',
    String(request || '').trim(),
    '"""',
    '',
    OUTPUT_RULES,
  ].filter(l => l !== undefined && l !== null).join('\n');
}

export function buildSummaryPrompt({ summary, request, cwd, peer = '协作方', requester = '发起方' }) {
  const focus = request && request.trim()
    ? `本次希望重点审查：${request.trim()}`
    : '请对该阶段做整体审查。';

  return [
    roleLine(peer),
    '',
    `${requester} 刚刚完成一个阶段的工作，把总结交给你审查。`,
    workspaceLine(cwd),
    '',
    `${requester} 的完成总结：`,
    '"""',
    String(summary || '').trim(),
    '"""',
    '',
    focus,
    '',
    '请判断这段工作是否可以继续推进：若可以，给出下一步；若不可，指出必须先修的问题。',
    '',
    OUTPUT_RULES,
  ].join('\n');
}

// The Stop hook has only the last assistant message, not the whole turn, so the
// automatic forward has to be short and self-describing.
export function buildAutoPrompt({
  lastMessage,
  cwd,
  review = false,
  sessionTitle,
  toolTrail,
  peer = '协作方',
  requester = '发起方',
}) {
  const trail = Array.isArray(toolTrail) && toolTrail.length
    ? `本轮主要工具调用：\n${toolTrail.map(t => `- ${t}`).join('\n')}`
    : '';

  return [
    roleLine(peer),
    '',
    `${requester} 刚结束一轮工作，自动向你同步。`,
    workspaceLine(cwd),
    sessionTitle ? `会话主题：${sessionTitle}` : '',
    '',
    `${requester} 在最后一轮的原话：`,
    '"""',
    String(lastMessage || '').trim(),
    '"""',
    trail,
    '',
    review
      ? '请审查这一轮工作的正确性，并给出下一步。'
      : '请判断当前状态，指出下一步该做什么。',
    '',
    OUTPUT_RULES,
  ].filter(Boolean).join('\n');
}

// The error hook sends a tool failure. It is phrased as a question because the
// useful answer is "why did this fail and what should be tried instead", not a
// review of work that never happened.
export function buildErrorPrompt({ tool, error, cwd, recent, peer = '协作方', requester = '发起方' }) {
  return [
    roleLine(peer),
    '',
    `${requester} 的工具调用失败了，需要你的判断。`,
    workspaceLine(cwd),
    '',
    `失败的工具：${tool || '(unknown)'}`,
    '错误信息：',
    '"""',
    String(error || '').trim(),
    '"""',
    recent ? `最近的上下文：\n${recent}` : '',
    '',
    '请判断根本原因，并给出可以直接执行的替代做法。如果这只是环境或配置问题，'
      + '说明需要用户做哪一件事。',
    '',
    OUTPUT_RULES,
  ].filter(Boolean).join('\n');
}
