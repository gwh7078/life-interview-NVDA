import { StoryCompletionContextError } from './errors.js';
import { isStoryGapQuestion, MAX_STORY_GAPS } from '../gaps.js';
import type {
  StoryCompletionContext,
  StoryCompletionContextLoader,
  StoryCompletionStatus,
} from './types.js';

const VALID_STATUSES = new Set<StoryCompletionStatus>(['pending', 'interviewing', 'complete']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const BLOCKED_DIRECTION_PATTERN = /(记不清|想不起来|不记得|没有印象|无法回忆|不愿继续|不想继续|不愿再聊|不想再聊|不愿回答|不想回答)/u;

function extractBlockedDirections(agentMemory: string): string[] {
  const directions = agentMemory
    .split(/[\n。！？；]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && BLOCKED_DIRECTION_PATTERN.test(part))
    .map((part) => part.slice(0, 180));
  return [...new Set(directions)].slice(0, 8);
}

/** Loads prompt-safe context through an owner-scoped port and drops every unapproved field. */
export class StoryCompletionContextBuilder {
  constructor(private readonly loader: StoryCompletionContextLoader) {}

  async build(userId: string, storyId: string): Promise<StoryCompletionContext> {
    const loaded: unknown = await this.loader.loadForUser(userId, storyId);
    if (loaded === null) {
      throw new StoryCompletionContextError('找不到这个故事。', 'STORY_NOT_FOUND');
    }
    if (!isRecord(loaded)) {
      throw new StoryCompletionContextError('Story Completion context is invalid.');
    }

    const { title, agentMemory, stageTitle, currentStatus, previousGaps: rawPreviousGaps, sessionCount, sourceUpdatedAt } = loaded;
    const previousGaps = rawPreviousGaps === undefined ? [] : rawPreviousGaps;
    if (typeof title !== 'string'
      || typeof agentMemory !== 'string'
      || !agentMemory.trim()
      || agentMemory.length > 8000
      || typeof stageTitle !== 'string'
      || typeof currentStatus !== 'string'
      || !VALID_STATUSES.has(currentStatus as StoryCompletionStatus)
      || !Array.isArray(previousGaps)
      || previousGaps.length > MAX_STORY_GAPS
      || previousGaps.some((gap) => !isStoryGapQuestion(gap))
      || (sessionCount !== undefined && (!Number.isInteger(sessionCount) || (sessionCount as number) < 0))
      || (sourceUpdatedAt !== undefined && (typeof sourceUpdatedAt !== 'string' || !sourceUpdatedAt.trim()))) {
      throw new StoryCompletionContextError('Story Completion context is invalid.');
    }

    return {
      title,
      agentMemory: agentMemory.trim(),
      stageTitle,
      currentStatus: currentStatus as StoryCompletionStatus,
      previousGaps: previousGaps.map((gap) => gap.trim()),
      blockedDirections: extractBlockedDirections(agentMemory),
      ...(sessionCount !== undefined ? { sessionCount: sessionCount as number } : {}),
      ...(sourceUpdatedAt !== undefined ? { sourceUpdatedAt: (sourceUpdatedAt as string).trim() } : {}),
    };
  }
}
