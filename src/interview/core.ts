import type { StoryInterviewTarget } from './context/story-interview-context.js';
import type { RealtimeInterviewProvider, RealtimeInterviewSession } from './session.js';
import type { RealtimeInterviewContext, StoryInterviewContext } from '../realtime/prompt.js';
import { StoryInterviewStrategy, UserControlledCompletionPolicy, type CompletionPolicy, type InterviewStrategy } from './story/strategy.js';
import { OnboardingInterviewStrategy } from './onboarding/strategy.js';
import type { OnboardingInterviewStart } from './onboarding/types.js';
import { ExternalContributorInterviewStrategy, type ExternalContributorInterviewStart } from './external-contributor/strategy.js';

/** Strategy-independent lifecycle boundary; new interview products supply a strategy, not new core logic. */
export class InterviewCore<TTarget, TContext, TSession> {
  constructor(
    private readonly databasePath: string | undefined,
    private readonly strategy: InterviewStrategy<TTarget, TContext, TSession>,
  ) {}

  prepare(userId: string, target: TTarget): TContext {
    return this.strategy.buildContext(userId, target);
  }

  start(
    userId: string,
    context: TContext,
    provider: RealtimeInterviewProvider = 'modelbest',
  ): TSession {
    return this.strategy.openSession(this.databasePath, userId, context, provider);
  }

  canEnd(reason: string): boolean {
    return this.strategy.completionPolicy.canEnd({ reason });
  }
}

export function createStoryInterviewCore(databasePath?: string): InterviewCore<StoryInterviewTarget, StoryInterviewContext, RealtimeInterviewSession> {
  return new InterviewCore(databasePath, new StoryInterviewStrategy(databasePath));
}

export type InterviewStartInput =
  | { interview_type: 'story'; target: StoryInterviewTarget }
  | OnboardingInterviewStart
  | ExternalContributorInterviewStart;

/** Explicitly routes each discriminated interview start/context to its own Strategy. */
class InterviewStrategyDispatch implements InterviewStrategy<
  InterviewStartInput,
  RealtimeInterviewContext,
  RealtimeInterviewSession
> {
  readonly type = 'dispatch' as const;
  private readonly story: StoryInterviewStrategy;
  private readonly onboarding: OnboardingInterviewStrategy;
  private readonly external: ExternalContributorInterviewStrategy;
  readonly completionPolicy: CompletionPolicy = new UserControlledCompletionPolicy();

  constructor(private readonly databasePath?: string) {
    this.story = new StoryInterviewStrategy(databasePath);
    this.onboarding = new OnboardingInterviewStrategy(databasePath);
    this.external = new ExternalContributorInterviewStrategy(databasePath);
  }

  buildContext(userId: string, input: InterviewStartInput): RealtimeInterviewContext {
    if (input.interview_type === 'onboarding') return this.onboarding.buildContext(userId, input);
    if (input.interview_type === 'external_contributor') return this.external.buildContext(userId, input);
    return this.story.buildContext(userId, input.target);
  }

  openSession(
    databasePath: string | undefined,
    userId: string,
    context: RealtimeInterviewContext,
    provider: RealtimeInterviewProvider,
  ): RealtimeInterviewSession {
    if (context.interview_type === 'onboarding') {
      return this.onboarding.openSession(databasePath, userId, context, provider);
    }
    if (context.interview_type === 'external_contributor') {
      return this.external.openSession(databasePath, userId, context, provider);
    }
    return this.story.openSession(databasePath, userId, context, provider);
  }
}

export function createInterviewRuntimeCore(
  databasePath?: string,
): InterviewCore<InterviewStartInput, RealtimeInterviewContext, RealtimeInterviewSession> {
  return new InterviewCore(databasePath, new InterviewStrategyDispatch(databasePath));
}
