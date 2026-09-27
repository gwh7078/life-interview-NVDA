import {
  storyCloseoutOutputSchema,
  storyCreationCloseoutOutputSchema,
} from '../closeout-schema.js';
import { CloseoutWorkflowError } from './errors.js';
import type { StoryCloseoutContext } from './context-builder.js';
import { restoreCloseoutReferences, type CompactPromptReferences } from './prompt-builder.js';
import type { ValidatedNewStory, ValidatedStoryCloseoutOutput } from './types.js';

type MemoryChange = {
  type: 'add' | 'correct' | 'refine' | 'merge' | 'remove';
  previous_text: string;
  new_text: string;
  source_message_ids: string[];
};

function normalizedText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function normalizedMemoryText(value: string): string {
  return normalizedText(value.replace(/^\s*【[^】]{1,40}】\s*/u, ''));
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

function citedUserText(ids: string[], context: StoryCloseoutContext): string {
  const requested = new Set(ids);
  return context.transcript
    .filter((message) => message.role === 'user' && requested.has(message.message_id))
    .map((message) => message.text)
    .join('\n');
}

function hasMeaningfulEvidenceOverlap(snippet: string, sourceIds: string[], context: StoryCloseoutContext): boolean {
  const target = normalizedMemoryText(snippet);
  const evidence = normalizedText(citedUserText(sourceIds, context));
  if (!target || !evidence) return false;
  const width = Math.min(4, target.length);
  for (let index = 0; index <= target.length - width; index += 1) {
    if (evidence.includes(target.slice(index, index + width))) return true;
  }
  return false;
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

function memoryUnits(memory: string): string[] {
  const units: string[] = [];
  for (const rawLine of memory.split(/\n+/u)) {
    const line = rawLine.replace(/^\s*【[^】]{1,40}】\s*/u, '').trim();
    if (!line) continue;
    const parts = line.match(/[^。！？；]+[。！？；]?/gu) ?? [line];
    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (normalizedMemoryText(part).length >= 6) units.push(part);
    }
  }
  return [...new Set(units)];
}

function containsMemoryText(container: string, snippet: string): boolean {
  const normalizedSnippet = normalizedMemoryText(snippet);
  return normalizedSnippet.length > 0 && normalizedMemoryText(container).includes(normalizedSnippet);
}

function bigrams(value: string): Set<string> {
  const normalized = normalizedMemoryText(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  const values = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    values.add(normalized.slice(index, index + 2));
  }
  return values;
}

function retainedBigramRatio(previousText: string, newText: string): number {
  const previous = bigrams(previousText);
  if (previous.size === 0) return 1;
  const next = bigrams(newText);
  let retained = 0;
  for (const item of previous) if (next.has(item)) retained += 1;
  return retained / previous.size;
}

function invalidMemoryChange(index: number, reason: string): never {
  throw new CloseoutWorkflowError('Agent Memory 变更记录无效。', 'INVALID_MEMORY_CHANGE', 422, {
    path: `current_story.memory_changes[${index}]`,
    reason,
  });
}

function validateMemoryChanges(
  changes: MemoryChange[],
  oldMemory: string,
  newMemory: string,
  overallSourceIds: string[],
  context: StoryCloseoutContext,
): void {
  if (normalizedMemoryText(oldMemory) !== normalizedMemoryText(newMemory) && changes.length === 0) {
    throw new CloseoutWorkflowError('Agent Memory 已变化但缺少内部变更记录。', 'INVALID_MEMORY_CHANGE', 422, {
      path: 'current_story.memory_changes',
      reason: 'audit_record_required_for_memory_change',
    });
  }
  const overallSources = new Set(overallSourceIds);
  for (const [index, change] of changes.entries()) {
    validateSourceIds(change.source_message_ids, context);
    if (change.source_message_ids.some((id) => !overallSources.has(id))) {
      invalidMemoryChange(index, 'change_source_not_in_current_story_sources');
    }

    const previousText = change.previous_text.trim();
    const newText = change.new_text.trim();
    const evidenceRequired = change.type === 'add'
      || change.type === 'correct'
      || change.type === 'refine'
      || change.type === 'remove';
    if (evidenceRequired && change.source_message_ids.length === 0) {
      invalidMemoryChange(index, 'current_user_evidence_required');
    }
    if ((change.type === 'add' || change.type === 'correct' || change.type === 'refine')
      && !hasMeaningfulEvidenceOverlap(newText, change.source_message_ids, context)) {
      invalidMemoryChange(index, 'new_text_not_grounded_in_cited_messages');
    }

    if (change.type === 'add') {
      if (previousText) invalidMemoryChange(index, 'add_previous_text_must_be_empty');
      if (!newText || !containsMemoryText(newMemory, newText)) {
        invalidMemoryChange(index, 'add_new_text_must_exist_in_new_memory');
      }
      continue;
    }

    if (!previousText || !containsMemoryText(oldMemory, previousText)) {
      invalidMemoryChange(index, 'previous_text_must_quote_old_memory');
    }

    if (change.type === 'remove') {
      if (newText) invalidMemoryChange(index, 'remove_new_text_must_be_empty');
      if (containsMemoryText(newMemory, previousText)) {
        invalidMemoryChange(index, 'removed_text_still_present');
      }
      continue;
    }

    if (!newText || !containsMemoryText(newMemory, newText)) {
      invalidMemoryChange(index, 'new_text_must_quote_new_memory');
    }
    if (change.type === 'merge' && retainedBigramRatio(previousText, newText) < 0.55) {
      invalidMemoryChange(index, 'merge_does_not_preserve_enough_original_meaning');
    }
  }

  const oldUnits = memoryUnits(oldMemory);
  const unexplainedLosses = oldUnits.filter((unit) => {
    if (containsMemoryText(newMemory, unit)) return false;
    const normalizedUnit = normalizedMemoryText(unit);
    return !changes.some((change) => change.type !== 'add'
      && normalizedMemoryText(change.previous_text).includes(normalizedUnit));
  });
  if (unexplainedLosses.length > 0) {
    throw new CloseoutWorkflowError('新版 Agent Memory 丢失了旧 Memory 中未被解释的信息。', 'MEMORY_INFORMATION_LOSS', 422, {
      path: 'current_story.agent_memory',
      missingCount: unexplainedLosses.length,
    });
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
    validateMemoryChanges(
      restored.current_story.memory_changes as MemoryChange[],
      context.currentStory.agent_memory,
      restored.current_story.agent_memory,
      restored.current_story.source_message_ids,
      context,
    );
    for (const story of restored.new_stories) validateSourceIds(story.source_message_ids, context);
    if ((restored.current_story.summary.trim() !== context.currentStory.summary.trim()
        || restored.current_story.agent_memory.trim() !== context.currentStory.agent_memory.trim())
      && restored.current_story.source_message_ids.length === 0) {
      throw new CloseoutWorkflowError('更新后的故事摘要或 Agent Memory 缺少本次用户消息来源。', 'SOURCE_MESSAGE_IDS_REQUIRED', 422);
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
