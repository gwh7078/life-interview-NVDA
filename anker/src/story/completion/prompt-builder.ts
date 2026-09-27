import type { StoryCompletionContext, StoryCompletionPrompt } from './types.js';

/** Builds a prompt from an explicit allowlist; identifiers and any extra runtime fields are omitted. */
export function buildStoryCompletionPrompt(context: StoryCompletionContext): StoryCompletionPrompt {
  const promptContext = {
    title: context.title,
    agentMemory: context.agentMemory,
    stageTitle: context.stageTitle,
    currentStatus: context.currentStatus,
    previousGaps: context.previousGaps ?? [],
    blockedDirections: context.blockedDirections ?? [],
    ...(context.sessionCount !== undefined ? { sessionCount: context.sessionCount } : {}),
  };

  return {
    system: [
      '你负责判断一个 Story 当前是否已经有足够资料写成一篇结构完整、可独立阅读、且不编造事实的文章，并指出最重要的补充方向。',
      '只返回符合给定 JSON Schema 的对象：status 与 gaps。不要输出 reason、confidence、score、percentage、topic、priority、suggested_question、suggested_direction、analysis 或 reasoning。',
      'status 只能是 pending、interviewing 或 complete。只有当前资料足以在不编造事实的情况下写成完整文章时才使用 complete。',
      '如果 currentStatus 已经是 complete，status 必须继续返回 complete；后续 gaps 只表示“如果还想继续丰富，可以补充什么”，不能据此取消已开放的成稿资格。',
      'gaps 只保留对理解整个 Story 或明显提升成稿质量真正重要的 0 到 3 个下一轮采访问题。每条必须是可以直接问用户的单一、自然问题，以问号结尾，最多 80 个字符。',
      '一个 gap 只问一个方向；不要把“为什么、过程、影响”等多个问题塞进同一条，也不要输出“缺少……”“信息不足……”“需要补充……”这类诊断说明。',
      'Agent Memory 代表当前 Story 已知事实、已经覆盖的主题、明确纠正和仍不确定的信息。previousGaps 是上一轮仍待补充的候选问题：必须逐条结合当前 Agent Memory 重新评估，已经回答、已经充分覆盖、已被纠正、价值已降低或用户明确无法继续回答的方向应删除；仍重要的可以保留或改写为更自然的单一问题；只有确有新的关键缺口时才新增，总数仍不超过 3 条。',
      'blockedDirections 是系统从 Agent Memory 中提取的明确“记不清、想不起来、没有印象、无法回忆、不愿继续或不想再聊”等方向，属于强约束。不得生成与其语义相同或仅换一种说法的 gap；不要通过改写问题绕过该约束。',
      'gaps 是下一轮可优先提问的候选问题，不是必须逐项完成的清单。不要改写 Agent Memory，不要生成文章。',
    ].join('\n'),
    user: `请评估以下 Story 当前资料：\n${JSON.stringify(promptContext)}`,
  };
}
