export type StoryCompletionStatus = 'pending' | 'interviewing' | 'complete';

/** The only story data that may enter Completion prompts. */
export interface StoryCompletionContext {
  title: string;
  agentMemory: string;
  stageTitle: string;
  currentStatus: StoryCompletionStatus;
  /** Previous round's still-actionable interview questions; Completion rolls these forward instead of recreating blindly. */
  previousGaps?: string[];
  /** Explicit "cannot remember / do not ask again" directions derived from Agent Memory. */
  blockedDirections?: string[];
  sessionCount?: number;
  /** Internal optimistic-lock token. Prompt builders must never serialize it. */
  sourceUpdatedAt?: string;
}

export interface StoryCompletionOutput {
  status: StoryCompletionStatus;
  gaps: string[];
}

export interface StoryCompletionPrompt {
  system: string;
  user: string;
}

export interface StoryCompletionStructuredSchema {
  name: string;
  jsonSchema: Record<string, unknown>;
}

export interface StoryCompletionModelRequest {
  prompt: StoryCompletionPrompt;
  schema: StoryCompletionStructuredSchema;
}

/** A provider adapter should map only retryable transport/provider failures to retryable model errors. */
export interface StoryCompletionModelRunner {
  complete(request: StoryCompletionModelRequest): Promise<unknown>;
}

export type Awaitable<T> = T | Promise<T>;

/** Owner scoping belongs to the injected loader; the builder only projects the prompt-safe fields. */
export interface StoryCompletionContextLoader {
  loadForUser(userId: string, storyId: string): Awaitable<StoryCompletionContext | null>;
}

/** The persistence adapter applies sticky-complete semantics atomically and returns the stored state. */
export interface StoryCompletionResultWriter {
  updateCompletionForUser(
    userId: string,
    storyId: string,
    output: StoryCompletionOutput,
    expectedUpdatedAt?: string,
  ): Awaitable<StoryCompletionOutput>;
}

export interface StoryCompletionExecutionContext {
  userId: string;
  storyId: string;
  signal?: AbortSignal;
}

export interface StoryCompletionProcessorPort {
  process(
    context: StoryCompletionContext,
    execution?: StoryCompletionExecutionContext,
  ): Promise<StoryCompletionOutput>;
}
