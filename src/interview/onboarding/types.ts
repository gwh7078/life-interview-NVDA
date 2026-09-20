export interface OnboardingTranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}
export interface OnboardingTranscriptHistory {
  startedAt: string;
  messages: OnboardingTranscriptTurn[];
}

/** Structured, owner-scoped interview input; it contains no prompt or provider state. */
export interface OnboardingInterviewContext {
  interview_type: 'onboarding';
  profile: Record<string, unknown>;
  previousOnboardingTranscripts: OnboardingTranscriptHistory[];
  taskContext: { mode: 'new' | 'continue' };
}

export interface OnboardingInterviewStart {
  interview_type: 'onboarding';
}
