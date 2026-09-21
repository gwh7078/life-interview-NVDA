import {
  LifeStageRepository,
  MemoirDocumentRepository,
  ProfileRepository,
  StoryRepository,
} from '../../repositories/domain-repositories.js';
import { OpenAICompatibleTextModelProvider, type TextModelProvider } from '../../providers/text-model-provider.js';
import { StoryGenerationError, StoryGenerationService } from './index.js';
import { loadStoryCreationEvidenceMessages } from './source-evidence.js';
import type {
  StoryGenerationContextModelPort,
  StoryGenerationDataPort,
  StoryGenerationModelPort,
  StoryGenerationTranscriptMessage,
} from './types.js';

export const DEFAULT_STORY_GENERATION_MAX_OUTPUT_TOKENS = 8_192;

export interface StoryGenerationRuntimeConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  apiFormat?: 'chat-completions' | 'chat-json-schema' | 'responses';
  model?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

function mergeTranscriptEvidence(
  directMessages: StoryGenerationTranscriptMessage[],
  creationEvidence: StoryGenerationTranscriptMessage[],
): StoryGenerationTranscriptMessage[] {
  const unique = new Map<string, StoryGenerationTranscriptMessage>();
  for (const message of [...directMessages, ...creationEvidence]) {
    if (!unique.has(message.messageId)) unique.set(message.messageId, message);
  }
  return [...unique.values()].sort((left, right) => (
    left.timestamp.localeCompare(right.timestamp)
    || left.sessionId.localeCompare(right.sessionId)
    || left.messageId.localeCompare(right.messageId)
  ));
}

export function createStoryGenerationService(
  databasePath: string | undefined,
  config: StoryGenerationRuntimeConfig,
  textModelProvider: TextModelProvider = new OpenAICompatibleTextModelProvider(),
  contextModel?: StoryGenerationContextModelPort,
): StoryGenerationService {
  const stories = new StoryRepository(databasePath);
  const profiles = new ProfileRepository(databasePath);
  const stages = new LifeStageRepository(databasePath);
  const documents = new MemoirDocumentRepository(databasePath);

  const data: StoryGenerationDataPort = {
    async findStoryForUser(ownerId, storyId) {
      const story = stories.findByIdForUser(ownerId, storyId);
      return story ? {
        storyId: story.storyId,
        ownerId: story.userId,
        stageId: story.stageId,
        title: story.title,
        summary: story.summary,
        status: story.status,
        updatedAt: story.updatedAt,
      } : null;
    },
    async findProfileForUser(ownerId) {
      const profile = profiles.findById(ownerId);
      return profile ? {
        ownerId: profile.userId,
        name: profile.name,
        profileSummary: profile.profileSummary,
      } : null;
    },
    async findLifeStageForUser(ownerId, stageId) {
      const stage = stages.listForUser(ownerId).find((item) => item.stageId === stageId);
      return stage ? {
        stageId: stage.stageId,
        ownerId: stage.userId,
        title: stage.title,
        startDate: stage.startDate,
        endDate: stage.endDate,
        summary: stage.summary,
      } : null;
    },
    async listTranscriptsForStory(ownerId, storyId) {
      const directMessages = stories.getTranscriptsByStoryId(ownerId, storyId).flatMap((session) => session.messages.map((message) => ({
        sessionId: session.sessionId,
        messageId: message.message_id,
        role: message.role,
        text: message.text,
        timestamp: message.timestamp,
      })));
      const creationEvidence = loadStoryCreationEvidenceMessages(databasePath, ownerId, storyId);
      return mergeTranscriptEvidence(directMessages, creationEvidence);
    },
    async findDocumentForUser(ownerId, documentId) {
      const document = documents.findByIdForUser(ownerId, documentId);
      return document ? {
        documentId: document.documentId,
        ownerId: document.userId,
        scopeType: document.scopeType,
        scopeId: document.scopeId,
        title: document.title,
        content: document.content,
        versionNumber: document.versionNumber,
        status: document.status,
      } : null;
    },
    async createNextVersion(input) {
      try {
        const document = documents.createNextVersion({
          userId: input.ownerId,
          storyId: input.scopeId,
          title: input.title,
          content: input.content,
          sourceJson: input.sourceJson,
          expectedStoryUpdatedAt: input.expectedStoryUpdatedAt,
        });
        if (!document) throw new Error('DOCUMENT_CREATE_FAILED');
        return {
          documentId: document.documentId,
          ownerId: document.userId,
          scopeType: 'story',
          scopeId: input.scopeId,
          title: document.title,
          content: document.content,
          versionNumber: document.versionNumber,
          status: 'draft',
          sourceJson: document.sourceJson ?? input.sourceJson,
        };
      } catch (error) {
        if (error instanceof Error && error.message === 'STORY_NOT_FOUND') {
          throw new StoryGenerationError('找不到这个故事。', 'STORY_NOT_FOUND', 404);
        }
        if (error instanceof Error && error.message === 'STORY_NOT_COMPLETE') {
          throw new StoryGenerationError('故事资料尚未完成，暂时不能生成成稿。', 'STORY_NOT_COMPLETE', 409);
        }
        if (error instanceof Error && error.message === 'STORY_CHANGED_DURING_GENERATION') {
          throw new StoryGenerationError('故事在生成期间已更新，请基于最新内容重新生成。', 'STORY_CHANGED_DURING_GENERATION', 409);
        }
        throw error;
      }
    },
  };

  const model: StoryGenerationModelPort = {
    async generate(request) {
      const result = await textModelProvider.complete(request.prompt, {
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.apiFormat ? { apiFormat: config.apiFormat } : {}),
        ...(config.model ? { model: config.model } : {}),
        ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
        maxOutputTokens: config.maxOutputTokens ?? DEFAULT_STORY_GENERATION_MAX_OUTPUT_TOKENS,
        structuredOutput: {
          name: request.structuredOutput.name,
          schema: request.structuredOutput.jsonSchema as Record<string, unknown>,
        },
      });
      return { output: result.output, provider: config.provider, model: result.model };
    },
  };

  return new StoryGenerationService(data, model, contextModel);
}
