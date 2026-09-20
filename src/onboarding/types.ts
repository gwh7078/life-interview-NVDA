import type { TranscriptMessage } from '../db/transcript.js';
import type { User } from '../db/schema.js';

export interface OnboardingSourceReference {
  session_id: string;
  message_id: string;
}

export interface OnboardingProfileCandidate<T> {
  value: T;
  source_refs: OnboardingSourceReference[];
}

export interface OnboardingProfileCandidates {
  name: OnboardingProfileCandidate<string>;
  birth_year: OnboardingProfileCandidate<number | null>;
  gender: OnboardingProfileCandidate<string | null>;
  birth_place: OnboardingProfileCandidate<string | null>;
  current_location: OnboardingProfileCandidate<string | null>;
  current_status: OnboardingProfileCandidate<string | null>;
  profile_summary: OnboardingProfileCandidate<string | null>;
}

export interface OnboardingStoryDraft {
  title: string;
  summary: string;
  source_refs: OnboardingSourceReference[];
  status: 'pending';
}

export interface OnboardingLifeStageDraft {
  title: string;
  start_year: number | null;
  end_year: number | 'now' | null;
  source_refs: OnboardingSourceReference[];
  stories: OnboardingStoryDraft[];
}

export interface ValidatedOnboardingCloseoutOutput {
  profile: OnboardingProfileCandidates;
  life_stages: OnboardingLifeStageDraft[];
}

export interface OnboardingTranscriptSession {
  sessionId: string;
  startedAt: string;
  messages: TranscriptMessage[];
  status: string;
  closeoutStatus: string;
  provider: string;
}

export interface OnboardingCloseoutContext {
  sessionId: string;
  userId: string;
  profile: User;
  transcripts: OnboardingTranscriptSession[];
}

export interface OnboardingPromptReferences {
  sourceReferences: Map<string, OnboardingSourceReference>;
}

export interface OnboardingResultSession {
  session_id: string;
  status: string;
  closeout_status: string;
}

export interface OnboardingResultProfile {
  user_id: string;
  name: OnboardingProfileCandidate<string | null>;
  birth_year: OnboardingProfileCandidate<number | null>;
  gender: OnboardingProfileCandidate<string | null>;
  birth_place: OnboardingProfileCandidate<string | null>;
  current_location: OnboardingProfileCandidate<string | null>;
  current_status: OnboardingProfileCandidate<string | null>;
  profile_summary: OnboardingProfileCandidate<string | null>;
}

export interface OnboardingResultLifeStage {
  stage_id: string;
  title: string;
  start_year: number | null;
  end_year: number | 'now' | null;
  status: string;
  sort_order: number;
  source_refs: OnboardingSourceReference[];
}

export interface OnboardingResultStory {
  story_id: string;
  stage_id: string;
  title: string;
  summary: string;
  status: string;
  source_refs: OnboardingSourceReference[];
}

export interface OnboardingResultEvidence extends OnboardingSourceReference {
  text: string;
}

export interface OnboardingResult {
  onboarding_status: string | null;
  story_completion_pending: boolean;
  session: OnboardingResultSession | null;
  processing_error: { code?: string; message?: string; retryable?: boolean } | null;
  profile: OnboardingResultProfile | null;
  life_stages: OnboardingResultLifeStage[];
  stories: OnboardingResultStory[];
  evidence: OnboardingResultEvidence[];
}
