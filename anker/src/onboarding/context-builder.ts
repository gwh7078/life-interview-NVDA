import { OnboardingWorkflowError } from './errors.js';
import type { OnboardingCloseoutContext } from './types.js';
import { OnboardingRepository } from '../repositories/onboarding-repository.js';

/** Reads only the current user's Onboarding sessions; Story and LifeStage interviews are excluded. */
export class OnboardingCloseoutContextBuilder {
  private readonly repository: OnboardingRepository;

  constructor(databasePath?: string) {
    this.repository = new OnboardingRepository(databasePath);
  }

  build(sessionId: string, ownerUserId: string): OnboardingCloseoutContext {
    const session = this.repository.findSessionForUser(ownerUserId, sessionId);
    if (!session) throw new OnboardingWorkflowError('找不到这次建档采访。', 'SESSION_NOT_FOUND', 404);
    if (session.sessionType !== 'onboarding') {
      throw new OnboardingWorkflowError('当前会话不是首次建档采访。', 'INVALID_SESSION_TYPE', 409);
    }
    if (!session.endedAt || session.status === 'active') {
      throw new OnboardingWorkflowError('采访还没有结束。', 'SESSION_NOT_ENDED', 409);
    }

    const data = this.repository.getInterviewContextData(ownerUserId);
    if (!data.profile) throw new OnboardingWorkflowError('找不到当前人生档案。', 'PROFILE_NOT_FOUND', 404);
    let transcripts;
    try {
      transcripts = this.repository.listTranscriptSessionsForUser(ownerUserId)
        .filter((transcriptSession) => transcriptSession.status !== 'active');
    } catch {
      throw new OnboardingWorkflowError('建档采访原始记录无法读取。', 'TRANSCRIPT_INVALID', 422);
    }
    if (!transcripts.some((transcriptSession) => transcriptSession.sessionId === sessionId)) {
      throw new OnboardingWorkflowError('找不到这次建档采访的原始记录。', 'SESSION_NOT_FOUND', 404);
    }
    const hasUserAnswer = transcripts.some((transcriptSession) =>
      transcriptSession.messages.some((message) => message.role === 'user' && message.text.trim().length > 0));
    if (!hasUserAnswer) {
      throw new OnboardingWorkflowError('建档采访没有可整理的用户发言。', 'TRANSCRIPT_EMPTY', 422);
    }
    return { sessionId, userId: ownerUserId, profile: data.profile, transcripts };
  }
}
