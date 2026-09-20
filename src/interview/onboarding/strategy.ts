import type { RealtimeInterviewProvider, RealtimeInterviewSession } from '../session.js';
import type { CompletionPolicy, InterviewStrategy } from '../story/strategy.js';
import { UserControlledCompletionPolicy } from '../story/strategy.js';
import { OnboardingRepository } from '../../repositories/onboarding-repository.js';
import { OnboardingInterviewContextBuilder } from './context-builder.js';
import type { OnboardingInterviewContext, OnboardingInterviewStart } from './types.js';

export class OnboardingInterviewStrategy implements InterviewStrategy<
  OnboardingInterviewStart,
  OnboardingInterviewContext,
  RealtimeInterviewSession
> {
  readonly type = 'onboarding' as const;
  readonly completionPolicy: CompletionPolicy = new UserControlledCompletionPolicy();
  private readonly contexts: OnboardingInterviewContextBuilder;
  private readonly repository: OnboardingRepository;

  constructor(private readonly databasePath?: string) {
    this.contexts = new OnboardingInterviewContextBuilder(databasePath);
    this.repository = new OnboardingRepository(databasePath);
  }

  buildContext(userId: string, input: OnboardingInterviewStart): OnboardingInterviewContext {
    return this.contexts.build(userId, input);
  }

  openSession(
    _databasePath: string | undefined,
    userId: string,
    context: OnboardingInterviewContext,
    provider: RealtimeInterviewProvider,
  ): RealtimeInterviewSession {
    const created = this.repository.createInterviewSessionForUser(userId, provider);
    return {
      ...created,
      provider,
      sessionType: 'onboarding',
      context,
    };
  }
}
