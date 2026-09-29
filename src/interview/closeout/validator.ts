import {
  storyCloseoutOutputSchema,
  storyCreationCloseoutOutputSchema,
} from '../closeout-schema.js';
import { CloseoutWorkflowError } from './errors.js';
import type { StoryCloseoutContext } from './context-builder.js';
import { restoreCloseoutReferences, type CompactPromptReferences } from './prompt-builder.js';
import type { ValidatedNewStory, ValidatedStoryCloseoutOutput } from './types.js';

function normalizedText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function schemaFailure(error: { issues: Array<{ path: PropertyKey[]; code: string }> }): CloseoutWorkflowError {
  const issues = error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map((part) => typeof part === 'number' ? `[${part}]` : String(part)).join('.').slice(0, 160),
    code: issue.code,
  }));
  return new CloseoutWorkflowError('模型输出未通过精简结果结构校验。', 'CLOSEOUT_OUTPUT_INVALID', 422, {
    issues,
    issueCount: error.issues.length,
  });
}

function validateYears(outputText: string, context: StoryCloseoutContext): void {
  const userText = context.transcript.filter((message) => message.role === 'user').map((message) => message.text);
  const inputText = [context.currentStory?.summary ?? '', context.currentStory?.agent_memory ?? '', ...userText].join('\n');
  const inputNumbers = new Set(inputText.match(/(?:19|20)\d{2}/g) ?? []);
  const inventedYear = (outputText.match(/(?:19|20)\d{2}/g) ?? []).find((year) => !inputNumbers.has(year));
  if (inventedYear) {
    throw new CloseoutWorkflowError('整理结果包含输入中没有的年份。', 'UNSUPPORTED_YEAR', 422, { year: inventedYear });
  }

  const approximateYearPattern = /(?:大约|约|大概|可能|也许|好像|应该|差不多)\s*((?:19|20)\d{2})/g;
  const approximateYears = new Set<string>();
  for (const text of userText) {
    for (const match of text.matchAll(approximateYearPattern)) {
      if (match[1]) approximateYears.add(match[1]);
    }
  }
  for (const year of approximateYears) {
    if (outputText.includes(year) && !/(大约|约|大概|可能|也许|好像|应该|差不多)/.test(outputText)) {
      throw new CloseoutWorkflowError('访谈中的近似年份在整理结果中被表述为确定年份。', 'UNCERTAINTY_NOT_PRESERVED', 422, { year });
    }
  }
}

function validateSourceIds(ids: string[], context: StoryCloseoutContext): void {
  const userMessageIds = new Set(context.transcript
    .filter((message) => message.role === 'user')
    .map((message) => message.message_id));
  if (new Set(ids).size !== ids.length || ids.some((id) => !userMessageIds.has(id))) {
    throw new CloseoutWorkflowError('整理结果引用了非本次访谈用户消息或重复来源。', 'INVALID_SOURCE_MESSAGE_IDS', 422, {
      reason: 'not_current_user_message',
    });
  }
}

function validateUniqueTitles(titles: string[], otherTitles: string[]): void {
  const existing = new Set(otherTitles.map(normalizedText));
  const seen = new Set<string>();
  for (const title of titles) {
    const normalized = normalizedText(title);
    if (!normalized || existing.has(normalized) || seen.has(normalized)) {
      throw new CloseoutWorkflowError('新故事标题与已有故事重复。', 'DUPLICATE_STORY', 422, { path: 'new_stories.title' });
    }
    seen.add(normalized);
  }
}

/** Schema and evidence checks are independent from model transport and persistence. */
export class StoryCloseoutValidator {
  validate(
    candidate: unknown,
    context: StoryCloseoutContext,
    references: CompactPromptReferences,
  ): ValidatedStoryCloseoutOutput {
    if (context.mode === 'create') {
      const parsed = storyCreationCloseoutOutputSchema.safeParse(candidate);
      if (!parsed.success) throw schemaFailure(parsed.error);
      const restored = restoreCloseoutReferences(parsed.data, context, references) as typeof parsed.data;
      const title = context.targetStoryTitle ?? restored.story.title;
      const sourceMessageIds = restored.story.source_message_ids;
      validateSourceIds(sourceMessageIds, context);
      if (sourceMessageIds.length === 0) {
        throw new CloseoutWorkflowError('新建故事缺少本次用户消息来源。', 'SOURCE_MESSAGE_IDS_REQUIRED', 422);
      }
      validateYears([title, restored.story.summary, restored.story.agent_memory].join('\n'), context);
      validateUniqueTitles([title], context.otherStories.map((story) => story.title));
      return {
        mode: 'create',
        stage_id: context.currentStageId,
        story: {
          title,
          summary: restored.story.summary,
          agent_memory: restored.story.agent_memory,
          source_message_ids: sourceMessageIds,
        },
      };
    }

    if (!context.currentStory) throw new CloseoutWorkflowError('找不到当前 Story。', 'STORY_NOT_FOUND', 409);
    const parsed = storyCloseoutOutputSchema.safeParse(candidate);
    if (!parsed.success) throw schemaFailure(parsed.error);
    const restored = restoreCloseoutReferences(parsed.data, context, references) as typeof parsed.data;
    const outputText = [
      restored.current_story.summary,
      restored.current_story.agent_memory,
      ...restored.new_stories.flatMap((story) => [story.title, story.summary]),
    ].join('\n');
    validateYears(outputText, context);

    validateSourceIds(restored.current_story.source_message_ids, context);
    for (const story of restored.new_stories) validateSourceIds(story.source_message_ids, context);
    if (restored.current_story.summary.trim() !== context.currentStory.summary.trim()
      && restored.current_story.source_message_ids.length === 0) {
      throw new CloseoutWorkflowError('更新后的故事摘要缺少本次用户消息来源。', 'SOURCE_MESSAGE_IDS_REQUIRED', 422);
    }
    const stageIds = new Set(context.lifeStages.map((stage) => stage.stage_id));
    const invalidStage = restored.new_stories.find((story) => !stageIds.has(story.stage_id));
    if (invalidStage) {
      throw new CloseoutWorkflowError('新故事选择的人生阶段不属于用户档案。', 'INVALID_STORY_STAGE', 422, { path: 'new_stories.stage_id' });
    }
    validateUniqueTitles(
      restored.new_stories.map((story) => story.title),
      [context.currentStory.title, ...context.otherStories.map((story) => story.title)],
    );
    return {
      mode: 'continue',
      current_story: {
        summary: restored.current_story.summary,
        agent_memory: restored.current_story.agent_memory,
        source_message_ids: restored.current_story.source_message_ids,
      },
      new_stories: restored.new_stories as ValidatedNewStory[],
    };
  }
}
