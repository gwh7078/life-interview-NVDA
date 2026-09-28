import type { CoachGateResult } from './coach/types.js';

export type InterviewBenchmarkVariant = 'A' | 'B' | 'C';

export interface InterviewBenchmarkProfile {
  variant: InterviewBenchmarkVariant;
  coachEnabled: boolean;
  memoryRetrievalEnabled: boolean;
  eraRetrievalEnabled: boolean;
}

export function parseInterviewBenchmarkVariant(value: unknown): InterviewBenchmarkVariant | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return undefined;
  const variant = typeof value === 'string' ? value.trim() : value;
  if (variant === 'A' || variant === 'B' || variant === 'C') return variant;
  throw new Error('INTERVIEW_BENCHMARK_VARIANT must be A, B, C, or unset.');
}

export function resolveInterviewBenchmarkProfile(
  variant: InterviewBenchmarkVariant | undefined,
): InterviewBenchmarkProfile | undefined {
  if (!variant) return undefined;
  return {
    variant,
    coachEnabled: variant !== 'A',
    memoryRetrievalEnabled: variant === 'C',
    eraRetrievalEnabled: variant === 'C',
  };
}

export function constrainCoachGate(
  gate: CoachGateResult,
  profile: InterviewBenchmarkProfile | undefined,
): CoachGateResult {
  if (!profile) return gate;
  return {
    ...gate,
    ...(!profile.memoryRetrievalEnabled ? { retrieve_memory: false, memory_query: null } : {}),
    ...(!profile.eraRetrievalEnabled ? {
      retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    } : {}),
  };
}

export function assertInterviewBenchmarkCompatible(
  variant: InterviewBenchmarkVariant | undefined,
  runtime: {
    provider: string;
    model: string;
    memoryTriggerMode: string;
    coachConfigured: boolean;
    retrieverEnabled: boolean;
  },
): void {
  if (!variant) return;
  if (runtime.provider !== 'stepaudio2_mini') {
    throw new Error('Interview Benchmark A/B/C requires STORY_INTERVIEW_PROVIDER=stepaudio2_mini.');
  }
  if (runtime.model !== 'step-audio-2-mini') {
    throw new Error('Interview Benchmark A/B/C requires STEPFUN_REALTIME_MODEL=step-audio-2-mini.');
  }
  if (runtime.memoryTriggerMode !== 'supervisor_auto') {
    throw new Error('Interview Benchmark A/B/C requires REALTIME_MEMORY_TRIGGER=supervisor_auto.');
  }
  if (variant !== 'A' && !runtime.coachConfigured) {
    throw new Error(`Interview Benchmark Variant ${variant} requires REALTIME_COACH_API_KEY or BAILIAN_API_KEY.`);
  }
  if (variant === 'C' && !runtime.retrieverEnabled) {
    throw new Error('Interview Benchmark Variant C requires NEMO_RETRIEVER_ENABLED=true so Story transcripts stay indexed.');
  }
}
