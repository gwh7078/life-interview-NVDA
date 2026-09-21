import { writeDiagnosticLog } from '../../diagnostics/logger.js';
import { diagnosticsContentEnabled, writeDiagnosticSnapshot } from '../../diagnostics/snapshot.js';
import { StoryGenerationContextBuilder } from './context-builder.js';
import { StoryGenerationError } from './errors.js';
import { buildStoryGenerationPrompt } from './prompt-builder.js';
import {
  storyGenerationInputSchema,
  storyGenerationJsonSchema,
  storyGenerationOutputSchema,
  storyGenerationSourceSchema,
} from './schema.js';
import type {
  StoryGenerationContextModelPort,
  StoryGenerationDataPort,
  StoryGenerationModelPort,
  StoryGenerationSourceMetadata,
} from './types.js';

function safeModelLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) return undefined;
  // Routing labels are useful provenance; token-like values are not.
  if (/\b(?:api[_ -]?key|access[_ -]?token|secret|password|bearer)\b/i.test(normalized)
    || /^(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}$/i.test(normalized)) return undefined;
  return normalized;
}

export class StoryGenerationService {
  private readonly contextBuilder: StoryGenerationContextBuilder;

  constructor(
    private readonly data: StoryGenerationDataPort,
    private readonly model: StoryGenerationModelPort,
    private readonly contextModel?: StoryGenerationContextModelPort,
  ) {
    this.contextBuilder = new StoryGenerationContextBuilder(data);
  }

  async generate(input: unknown) {
    const parsedInput = storyGenerationInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new StoryGenerationError('成稿请求参数无效。', 'GENERATION_INPUT_INVALID', 400, {
        issues: parsedInput.error.issues.map(({ path, code }) => ({
          path: path.map(String).join('.'),
          code,
        })),
      });
    }
    const request = parsedInput.data;
    const story = await this.data.findStoryForUser(request.ownerId, request.storyId);
    if (!story || story.ownerId !== request.ownerId || story.storyId !== request.storyId) {
      throw new StoryGenerationError('找不到这个故事。', 'STORY_NOT_FOUND', 404);
    }
    if (story.status !== 'complete') {
      throw new StoryGenerationError('故事资料尚未完成，暂时不能生成成稿。', 'STORY_NOT_COMPLETE', 409);
    }

    let baseDocument = null;
    if (request.baseDocumentId !== null) {
      const selected = await this.data.findDocumentForUser(request.ownerId, request.baseDocumentId);
      if (!selected || selected.documentId !== request.baseDocumentId || selected.ownerId !== request.ownerId
        || selected.scopeType !== 'story' || selected.scopeId !== request.storyId) {
        throw new StoryGenerationError('找不到这个故事的指定文稿版本。', 'BASE_DOCUMENT_NOT_FOUND', 404);
      }
      baseDocument = selected;
    }

    const context = await this.contextBuilder.build({
      ...request,
      story,
      baseDocument,
    });
    // Agent mode consumes structured Context through the Skill. Direct mode preserves the legacy Prompt path.
    const modelResponse = this.contextModel
      ? await this.contextModel.generateContext({
          ownerId: request.ownerId,
          storyId: story.storyId,
          resourceVersion: story.updatedAt,
          context,
        })
      : await this.model.generate({
          prompt: buildStoryGenerationPrompt(context),
          structuredOutput: {
            name: 'story_generation',
            jsonSchema: storyGenerationJsonSchema,
          },
        });
    const parsedOutput = storyGenerationOutputSchema.safeParse(modelResponse.output);
    if (!parsedOutput.success || !parsedOutput.data.content.trim()) {
      throw new StoryGenerationError('模型没有返回有效的文章正文。', 'GENERATION_OUTPUT_INVALID', 422);
    }

    const provider = safeModelLabel(modelResponse.provider);
    const model = safeModelLabel(modelResponse.model);
    const source = storyGenerationSourceSchema.parse({
      storyId: story.storyId,
      generationMode: context.mode,
      baseDocumentId: baseDocument?.documentId ?? null,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      promptVersion: 'story-generation-v1',
      style: request.style,
      userInstruction: request.userInstruction,
      generationParameters: {},
      sessionIds: context.transcriptSessionIds,
    }) as StoryGenerationSourceMetadata;

    const created = await this.data.createNextVersion({
      ownerId: request.ownerId,
      scopeType: 'story',
      scopeId: story.storyId,
      title: story.title,
      content: parsedOutput.data.content.trim(),
      status: 'draft',
      sourceJson: JSON.stringify(source),
      expectedStoryUpdatedAt: story.updatedAt,
    });
    writeDiagnosticLog('story-generation', 'info', 'Story generation completed.', {
      storyId: story.storyId,
      documentId: created.documentId,
      generationMode: context.mode,
      contentChars: parsedOutput.data.content.trim().length,
      provider,
      model,
    });
    writeDiagnosticSnapshot('story-generation', story.storyId, {
      status: 'completed',
      story_id: story.storyId,
      document_id: created.documentId,
      generation_mode: context.mode,
      content_chars: parsedOutput.data.content.trim().length,
      provider: provider ?? null,
      model: model ?? null,
      transcript_session_count: context.transcriptSessionIds.length,
      ...(diagnosticsContentEnabled() ? {
        content: {
          generated_document: parsedOutput.data.content.trim(),
          source,
        },
      } : {}),
    });
    return created;
  }
}
