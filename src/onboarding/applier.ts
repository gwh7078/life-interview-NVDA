import { OnboardingRepository } from '../repositories/onboarding-repository.js';
import type { AppliedOnboardingCloseout } from '../repositories/onboarding-repository.js';
import type { ValidatedOnboardingCloseoutOutput } from './types.js';

/** Domain write boundary for fully validated Onboarding closeout decisions. */
export class OnboardingCloseoutApplier {
  private readonly repository: OnboardingRepository;

  constructor(databasePath?: string) {
    this.repository = new OnboardingRepository(databasePath);
  }

  apply(input: {
    userId: string;
    sessionId: string;
    expectedAttemptId: string;
    output: ValidatedOnboardingCloseoutOutput;
    modelMetadata: Record<string, unknown>;
  }): AppliedOnboardingCloseout {
    return this.repository.applyCloseout(input);
  }
}
