import type { TranscriptMessage } from '../../db/transcript.js';
import type { StoryCloseoutContext } from './context-builder.js';

export interface CompactPromptReferences {
  messages: Array<Pick<TranscriptMessage, 'message_id' | 'role' | 'text'>>;
  sourceMessageIds: Map<string, string>;
  stageIds: Map<string, string>;
  stageIdAliases: Map<string, string>;
}

export interface BuiltCloseoutPrompt {
  prompt: { system: string; user: string };
  references: CompactPromptReferences;
}

function compactIdentifierMaps(values: string[], prefix: string): { aliases: Map<string, string>; originals: Map<string, string> } {
  const originalIds = new Set(values);
  const aliases = new Set<string>();
  const aliasToOriginal = new Map<string, string>();
  const originalToAlias = new Map<string, string>();
  for (const [index, originalId] of [...new Set(values)].entries()) {
    let alias = `${prefix}${index + 1}`;
    while (originalIds.has(alias) || aliases.has(alias)) alias = `_${alias}`;
    aliases.add(alias);
    aliasToOriginal.set(alias, originalId);
    originalToAlias.set(originalId, alias);
  }
  return { aliases: aliasToOriginal, originals: originalToAlias };
}

function compactPromptReferences(context: StoryCloseoutContext): CompactPromptReferences {
  const messages = compactIdentifierMaps(context.transcript.map((message) => message.message_id), 'm');
  const stageIds = compactIdentifierMaps([
    ...context.lifeStages.map((stage) => stage.stage_id),
    context.currentStageId,
    ...context.otherStories.map((story) => story.stage_id),
  ], 's');
  return {
    messages: context.transcript.map((message) => ({
      message_id: messages.originals.get(message.message_id) ?? message.message_id,
      role: message.role,
      text: message.text,
    })),
    sourceMessageIds: messages.aliases,
    stageIds: stageIds.aliases,
    stageIdAliases: stageIds.originals,
  };
}

function stageAlias(stageId: string, references: CompactPromptReferences): string {
  return references.stageIdAliases.get(stageId) ?? stageId;
}

/** Pure Context-to-Prompt transformation. It has no database or provider dependency. */
export function buildStoryCloseoutPrompt(
  context: StoryCloseoutContext,
  retryFeedback?: Record<string, unknown>,
): BuiltCloseoutPrompt {
  const references = compactPromptReferences(context);
  if (context.mode === 'continue' && context.currentStory) {
    const system = [
      '你是人生采访局的访谈整理器。只整理已经结束的访谈，不继续提问。',
      '严格依据 Transcript 和已有摘要，不添加未提及的事实；保留“大概、可能、好像、记不清”等不确定性。用户明确更正时，以其最新说法为准。',
      'current_story.summary 是面向用户阅读的短摘要：保留旧摘要中未被纠正的核心内容，只吸收与当前故事直接相关的新信息；不要把其他经历混入其中。保持清楚、简洁，不复述 Transcript，目标约 400–800 个中文字符。',
      'current_story.agent_memory 是持久化的长期工作记忆，旧 agent_memory 是本轮更新的基线而不是素材之一。默认完整继承旧 Memory：本轮没有触及的信息不得删除、压缩掉或仅为文风而改写，未变化的旧事实尽量保持原文。只允许五类变化：add 新增；correct 用本轮明确纠正替换旧错误；refine 用本轮更精确信息替换旧模糊信息；merge 合并真正重复的旧表达但必须保留原语义；remove 仅在本轮用户明确否定旧信息或确认其不属于当前 Story 时删除。保留“大概、可能、好像、记不清”等不确定性。用户明确表示某个方向“记不清、想不起来、没有印象、无法回忆、不愿继续或不想再聊”时，这也是长期有效的采访约束，必须清楚写入 Agent Memory，建议归入【已耗尽方向】或等价表述，供后续 Interview / Completion 避免重复追问。不要保存 Q/A。通常目标约 3000 字，尽量不超过 5000 字，绝不能超过 8000 字。',
      'current_story.memory_changes 是仅供系统校验的内部变更记录，不面向用户、不写入最终 Story。每条必须使用 add/correct/refine/merge/remove：previous_text 必须逐字复制被改变的旧 Memory 原文片段（add 时为空）；new_text 必须逐字复制新版 Agent Memory 中对应的新片段（remove 时为空）；add/correct/refine/remove 必须引用本轮 role=user 的 source_message_ids；纯粹去重的 merge 可以不引用新证据。旧 Memory 中任何消失的实质信息都必须被一条 memory_changes 明确解释，否则结果会被拒绝并要求修复。',
      'new_stories 是独立 Story Seed，不要求已经采访完整。只要用户明确讲到一件真实发生、可以独立命名、能够归入某个人生阶段、且与 current_story / other_stories 不是同一核心事件的经历，就应创建 pending Story Seed；至少要有“发生了什么”以及一项具体上下文或细节。仅有“还有很多事”“以后再说”等完全模糊提及才省略。同一人生阶段不等于同一个 Story，跨阶段的新事件也允许归入对应 stage_id。每次最多 5 个。',
      'source_message_ids 只能引用输入 Transcript 中 role=user 且直接支持对应摘要或 Agent Memory 更新的 message_id；不能引用 assistant、编造 ID 或引用其它访谈。对 add/correct/refine，new_text 必须保留引用消息中的具体事实锚点（如人名、地点、时间、事件动作或关键原话），不能拿一条真实但无关的 message_id 给新增事实背书。',
      '不要在 schema 之外输出变更清单、冲突清单、候选线索、评估分数或额外解释；memory_changes 只按 schema 返回。',
    ].join('\n');
    const user = JSON.stringify({
      ...(retryFeedback ? { retry_feedback: retryFeedback } : {}),
      current_stage_id: stageAlias(context.currentStageId, references),
      current_story: {
        title: context.currentStory.title,
        summary: context.currentStory.summary,
        agent_memory: context.currentStory.agent_memory,
      },
      life_stages: context.lifeStages.map((stage) => ({
        ...stage,
        stage_id: stageAlias(stage.stage_id, references),
      })),
      other_stories: context.otherStories.map(({ title, summary, stage_id }) => ({
        title,
        summary,
        stage_id: stageAlias(stage_id, references),
      })),
      transcript: references.messages,
    });
    return { prompt: { system, user }, references };
  }

  const system = [
    '你是人生采访局的访谈整理器。只整理已经结束的访谈，不继续提问。',
    '请根据当前 Transcript，为用户在指定人生阶段创建一个 Story。只写有依据的信息，不添加未提及事实；保留“大概、可能、好像、记不清”等不确定性。用户明确更正时，以其最新说法为准。',
    '如果输入包含 target_story_title，这是用户提供的标题，输出时必须原样使用；否则拟定一个清楚、克制且能准确概括经历的标题。summary 是面向用户阅读的短摘要，保持故事骨架而不是复述 Transcript。agent_memory 是面向后续 Interview Agent 的长期工作记忆，应使用半结构化自然语言记录已知事实、人物关系、事件过程、重要细节、感受/动机、后续影响、纠正和不确定内容，不保存 Q/A；通常目标约 3000 字，绝不能超过 8000 字。',
    'source_message_ids 只能引用输入 Transcript 中 role=user 且直接支持 Story 标题、摘要或 Agent Memory 的 message_id；不能引用 assistant、编造 ID 或引用其它访谈。',
    '只输出 schema 要求的 Story，不拆分或创建其它经历。不要复述 Transcript、输出变更清单、候选线索或额外解释。',
  ].join('\n');
  const user = JSON.stringify({
    ...(retryFeedback ? { retry_feedback: retryFeedback } : {}),
    target_stage_id: stageAlias(context.currentStageId, references),
    ...(context.targetStoryTitle ? { target_story_title: context.targetStoryTitle } : {}),
    other_stories: context.otherStories.map(({ title, summary, stage_id }) => ({
      title,
      summary,
      stage_id: stageAlias(stage_id, references),
    })),
    transcript: references.messages,
  });
  return { prompt: { system, user }, references };
}

export function restoreCloseoutReferences(
  output: unknown,
  context: StoryCloseoutContext,
  references: CompactPromptReferences,
): unknown {
  const restoreMessageIds = (messageIds: string[]): string[] => messageIds.map((messageId) =>
    references.sourceMessageIds.get(messageId) ?? messageId);
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const value = output as Record<string, unknown>;
  if (context.mode === 'create') {
    if (!value.story || typeof value.story !== 'object' || Array.isArray(value.story)) return output;
    const story = value.story as Record<string, unknown>;
    return {
      story: { ...story, source_message_ids: Array.isArray(story.source_message_ids) ? restoreMessageIds(story.source_message_ids.filter((id): id is string => typeof id === 'string')) : story.source_message_ids },
    };
  }
  const currentStory = value.current_story && typeof value.current_story === 'object' && !Array.isArray(value.current_story)
    ? value.current_story as Record<string, unknown>
    : {};
  const newStories = Array.isArray(value.new_stories) ? value.new_stories : [];
  return {
    current_story: {
      ...currentStory,
      source_message_ids: Array.isArray(currentStory.source_message_ids)
        ? restoreMessageIds(currentStory.source_message_ids.filter((id): id is string => typeof id === 'string'))
        : currentStory.source_message_ids,
      memory_changes: Array.isArray(currentStory.memory_changes)
        ? currentStory.memory_changes.map((rawChange) => {
            if (!rawChange || typeof rawChange !== 'object' || Array.isArray(rawChange)) return rawChange;
            const change = rawChange as Record<string, unknown>;
            return {
              ...change,
              source_message_ids: Array.isArray(change.source_message_ids)
                ? restoreMessageIds(change.source_message_ids.filter((id): id is string => typeof id === 'string'))
                : change.source_message_ids,
            };
          })
        : currentStory.memory_changes,
    },
    new_stories: newStories.map((rawStory) => {
      if (!rawStory || typeof rawStory !== 'object' || Array.isArray(rawStory)) return rawStory;
      const story = rawStory as Record<string, unknown>;
      const stageId = typeof story.stage_id === 'string' ? story.stage_id : undefined;
      return {
        ...story,
        ...(stageId ? { stage_id: references.stageIds.get(stageId) ?? stageId } : {}),
        source_message_ids: Array.isArray(story.source_message_ids)
          ? restoreMessageIds(story.source_message_ids.filter((id): id is string => typeof id === 'string'))
          : story.source_message_ids,
      };
    }),
  };
}
