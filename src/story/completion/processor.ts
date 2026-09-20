import {
  StoryCompletionModelError,
  StoryCompletionOutputParseError,
  StoryCompletionValidationError,
} from './errors.js';
import { buildStoryCompletionPrompt } from './prompt-builder.js';
import { storyCompletionJsonSchema } from './schema.js';
import { StoryCompletionValidator } from './validator.js';
import type {
  StoryCompletionContext,
  StoryCompletionModelRunner,
  StoryCompletionOutput,
  StoryCompletionProcessorPort,
} from './types.js';

export const STORY_COMPLETION_MAX_MODEL_CALLS = 3;
export const STORY_COMPLETION_SCHEMA_NAME = 'story_completion';

function parseCandidate(response: unknown): unknown {
  if (typeof response !== 'string') return response;
  try {
    return JSON.parse(response) as unknown;
  } catch {
    throw new StoryCompletionOutputParseError();
  }
}

function isRetryableModelOutputError(error: unknown): boolean {
  return error instanceof StoryCompletionValidationError
    || (error instanceof StoryCompletionModelError && error.retryable);
}

/** Calls the model at most three times and retries only classified model/output failures. */
export class StoryCompletionProcessor implements StoryCompletionProcessorPort {
  constructor(
    private readonly modelRunner: StoryCompletionModelRunner,
    private readonly validator = new StoryCompletionValidator(),
  ) {}

  async process(context: StoryCompletionContext): Promise<StoryCompletionOutput> {
    const prompt = buildStoryCompletionPrompt(context);
    const request = {
      prompt,
      schema: {
        name: STORY_COMPLETION_SCHEMA_NAME,
        jsonSchema: storyCompletionJsonSchema,
      },
    };

    for (let call = 1; call <= STORY_COMPLETION_MAX_MODEL_CALLS; call += 1) {
      try {
        const response = await this.modelRunner.complete(request);
        return this.validator.validate(parseCandidate(response));
      } catch (error) {
        if (call === STORY_COMPLETION_MAX_MODEL_CALLS || !isRetryableModelOutputError(error)) {
          throw error;
        }
      }
    }

    throw new Error('Story Completion processor exited without a result.');
  }
}
