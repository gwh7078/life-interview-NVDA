import { OnboardingRepository } from '../../repositories/onboarding-repository.js';
import { yearFromStoredDate } from '../../onboarding/years.js';
import type { OnboardingInterviewContext, OnboardingInterviewStart } from './types.js';

function readField(source: object, ...keys: string[]): unknown {
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return null;
}
function projectProfile(profile: object): Record<string, unknown> {
  return {
    name: readField(profile, 'name'),
    nickname: readField(profile, 'nickname'),
    birth_year: yearFromStoredDate(readField(profile, 'birthDate', 'birth_date')),
    gender: readField(profile, 'gender'),
    birth_place: readField(profile, 'birthPlace', 'birth_place'),
    current_location: readField(profile, 'currentLocation', 'current_location'),
    current_status: readField(profile, 'currentStatus', 'current_status'),
    profile_summary: readField(profile, 'profileSummary', 'profile_summary'),
    occupation_summary: readField(profile, 'occupationSummary', 'occupation_summary'),
    family_summary: readField(profile, 'familySummary', 'family_summary'),
  };
}

/** Builds only structured context. Database access stays in the owner-scoped repository. */
export class OnboardingInterviewContextBuilder {
  private readonly repository: OnboardingRepository;

  constructor(databasePath?: string) {
    this.repository = new OnboardingRepository(databasePath);
  }

  build(userId: string, _input: OnboardingInterviewStart): OnboardingInterviewContext {
    const data = this.repository.getInterviewContextData(userId);
    const profile = data.profile;
    if (!profile || typeof profile !== 'object') {
      throw new Error('找不到当前人生档案。');
    }
    const transcripts = Array.isArray(data.transcripts) ? data.transcripts : [];

    return {
      interview_type: 'onboarding',
      profile: projectProfile(profile),
      previousOnboardingTranscripts: transcripts.map((history) => ({
        startedAt: history.startedAt,
        messages: history.messages
          .filter((message) => (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string')
          .map((message) => ({
            role: message.role as 'user' | 'assistant',
            text: message.text,
            ...(typeof message.timestamp === 'string' ? { timestamp: message.timestamp } : {}),
          })),
      })),
      taskContext: {
        mode: data.onboardingStatus === 'not_started' ? 'new' : 'continue',
      },
    };
  }
}
