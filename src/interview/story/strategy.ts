import type { RealtimeInterviewProvider, RealtimeInterviewSession } from '../session.js';
import { createRealtimeInterviewSession } from '../session.js';
import {
  StoryInterviewContextBuilder,
  type StoryInterviewTarget,
} from '../context/story-interview-context.js';
import type { StoryInterviewContext } from '../../realtime/prompt.js';

export interface CompletionPolicy {
  canEnd(input: { reason: string }): boolean;
}

/** User intent always wins; readiness is advisory and never blocks ending an interview. */
export class UserControlledCompletionPolicy implements CompletionPolicy {
  canEnd(_input: { reason: string }): boolean { return true; }
}

export interface InterviewStrategy<TStartInput, TContext, TSession> {
  readonly type: string;
  readonly completionPolicy: CompletionPolicy;
  buildContext(userId: string, input: TStartInput): TContext;
  openSession(
    databasePath: string | undefined,
    userId: string,
    context: TContext,
    provider: RealtimeInterviewProvider,
  ): TSession;
}

/** One Strategy handles both existing Story supplements and new Story interviews. */
export class StoryInterviewStrategy implements InterviewStrategy<StoryInterviewTarget, StoryInterviewContext, RealtimeInterviewSession> {
  readonly type = 'story' as const;
  readonly completionPolicy = new UserControlledCompletionPolicy();
  private readonly contexts: StoryInterviewContextBuilder;

  constructor(databasePath?: string) {
    this.contexts = new StoryInterviewContextBuilder(databasePath);
  }

  buildContext(userId: string, input: StoryInterviewTarget): StoryInterviewContext {
    return this.contexts.build(userId, input);
  }

  openSession(
    databasePath: string | undefined,
    userId: string,
    context: StoryInterviewContext,
    provider: RealtimeInterviewProvider,
  ): RealtimeInterviewSession {
    return createRealtimeInterviewSession(databasePath, userId, context, provider);
  }
}
