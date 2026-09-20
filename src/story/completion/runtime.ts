import { CloseoutModelError } from '../../interview/llm-provider.js';
import { StoryRepository } from '../../repositories/domain-repositories.js';
import { OpenAICompatibleTextModelProvider, type TextModelProvider } from '../../providers/text-model-provider.js';
import {
  StoryCompletionContextBuilder,
  StoryCompletionContextError,
  StoryCompletionModelError,
  StoryCompletionProcessor,
  StoryCompletionService,
} from './index.js';
import {
  StoryCompletionPersistenceError,
  StoryCompletionPersistenceRepository,
} from './persistence.js';

export interface StoryCompletionRuntimeConfig {
  provider?: string;
  apiKey: string;
  baseUrl?: string;
  apiFormat?: 'chat-completions' | 'chat-json-schema' | 'responses';
  model?: string;
  timeoutMs?: number;
}

export function createStoryCompletionService(
  databasePath: string | undefined,
  config: StoryCompletionRuntimeConfig,
  textModelProvider: TextModelProvider = new OpenAICompatibleTextModelProvider(),
): StoryCompletionService {
  const stories = new StoryRepository(databasePath);
  const completionPersistence = new StoryCompletionPersistenceRepository(databasePath);
  const contextBuilder = new StoryCompletionContextBuilder({
    loadForUser(userId, storyId) {
      const detail = stories.getDetailForUser(userId, storyId);
      if (!detail) return null;
      const stats = stories.getCompletionDataForUser(userId, storyId);
      if (!stats) return null;
      return {
        title: detail.title,
        agentMemory: stats.agentMemory || detail.summary,
        stageTitle: detail.stageTitle,
        currentStatus: detail.status,
        previousGaps: detail.gaps,
        sessionCount: stats.interviewSessionCount,
        sourceUpdatedAt: detail.updatedAt,
      };
    },
  });
  const processor = new StoryCompletionProcessor({
    async complete(request) {
      try {
        const result = await textModelProvider.complete(request.prompt, {
          apiKey: config.apiKey,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          ...(config.apiFormat ? { apiFormat: config.apiFormat } : {}),
          ...(config.model ? { model: config.model } : {}),
          ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
          structuredOutput: { name: request.schema.name, schema: request.schema.jsonSchema },
        });
        return result.output;
      } catch (error) {
        if (error instanceof CloseoutModelError) {
          throw new StoryCompletionModelError(error.message, error.code, error.retryable);
        }
        throw error;
      }
    },
  });
  const writer = {
    updateCompletionForUser(
      userId: string,
      storyId: string,
      output: Parameters<StoryCompletionPersistenceRepository['updateCompletionForUser']>[2],
      expectedUpdatedAt?: string,
    ) {
      try {
        const result = completionPersistence.updateCompletionForUser(userId, storyId, output, expectedUpdatedAt);
        if (!result) throw new StoryCompletionContextError('找不到这个故事。', 'STORY_NOT_FOUND');
        return result;
      } catch (error) {
        if (error instanceof StoryCompletionPersistenceError && error.code === 'STORY_CHANGED_DURING_COMPLETION') {
          throw new StoryCompletionContextError(error.message, error.code);
        }
        throw error;
      }
    },
  };
  return new StoryCompletionService(contextBuilder, processor, writer);
}
