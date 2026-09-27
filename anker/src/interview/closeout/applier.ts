import { StoryCloseoutRepository, StoryCloseoutRepositoryError } from '../../repositories/story-closeout-repository.js';
import type { StoryCloseoutContext } from './context-builder.js';
import { CloseoutWorkflowError } from './errors.js';
import type { ValidatedStoryCloseoutOutput } from './types.js';

export class StoryCloseoutApplier {
  private readonly repository: StoryCloseoutRepository;

  constructor(databasePath?: string) {
    this.repository = new StoryCloseoutRepository(databasePath);
  }

  apply(input: {
    context: StoryCloseoutContext;
    output: ValidatedStoryCloseoutOutput;
    expectedAttemptId: string;
    modelMetadata: Record<string, unknown>;
  }) {
    try {
      return this.repository.apply({
        ...input,
        ...(input.context.currentStory ? { expectedStoryUpdatedAt: input.context.currentStory.updated_at } : {}),
      });
    } catch (error) {
      if (error instanceof StoryCloseoutRepositoryError) {
        const httpStatus = error.code === 'SESSION_NOT_FOUND' ? 404
          : error.code === 'SESSION_NOT_ENDED' || error.code === 'SESSION_CLOSEOUT_ALREADY_APPLIED' ? 409
            : 422;
        throw new CloseoutWorkflowError(error.message, error.code, httpStatus);
      }
      throw error;
    }
  }
}
