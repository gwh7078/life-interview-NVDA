export class StoryCompletionContextError extends Error {
  constructor(message: string, readonly code = 'STORY_COMPLETION_CONTEXT_INVALID') {
    super(message);
    this.name = 'StoryCompletionContextError';
  }
}

/** Provider adapters use this error to classify model failures without retrying arbitrary exceptions. */
export class StoryCompletionModelError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'StoryCompletionModelError';
  }
}

export class StoryCompletionOutputParseError extends StoryCompletionModelError {
  constructor() {
    super('Story Completion model returned invalid JSON.', 'MODEL_OUTPUT_PARSE_ERROR', true);
    this.name = 'StoryCompletionOutputParseError';
  }
}

export class StoryCompletionValidationError extends Error {
  readonly code = 'STORY_COMPLETION_OUTPUT_INVALID';

  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = 'StoryCompletionValidationError';
  }
}
