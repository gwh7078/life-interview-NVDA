import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { interviewSessions } from '../db/schema.js';
import { nowUtcIso } from '../db/time.js';
import { closeoutResultSchema, serializeJsonColumn } from '../db/transcript.js';
import type { ExternalContributorInterviewContext, RealtimeInterviewContext, StoryInterviewContext } from '../realtime/prompt.js';
import type { RealtimeProviderId } from '../realtime/types.js';

export type RealtimeInterviewProvider = RealtimeProviderId;

export class InterviewSessionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'InterviewSessionError';
  }
}

export interface RealtimeInterviewSession {
  sessionId: string;
  provider: RealtimeInterviewProvider;
  startedAt: string;
  sessionType: 'story' | 'onboarding';
  context: RealtimeInterviewContext;
}

export interface EndRealtimeInterviewSessionOptions {
  /** Persisted server-side gate for final Onboarding Closeout; never accepted from a client message. */
  onboardingCompletionEligible?: boolean;
  /** True only after provider drain and all queued Transcript writes were confirmed. */
  onboardingTranscriptComplete?: boolean;
}

export function createRealtimeInterviewSession(
  databasePath: string | undefined,
  userId: string,
  context: StoryInterviewContext,
  provider: RealtimeInterviewProvider = 'stepaudio3_quality',
): RealtimeInterviewSession {
  const sessionId = randomUUID();
  const startedAt = nowUtcIso();
  const connection = createDatabase(databasePath);
  const storyId = typeof context.story?.story_id === 'string' ? context.story.story_id : null;
  const stageId = typeof context.life_stage.stage_id === 'string' ? context.life_stage.stage_id : null;
  if (!stageId || (context.story && !storyId)) {
    connection.close();
    throw new InterviewSessionError('无法确定本次 Story 采访的阶段或故事。', 'INVALID_INTERVIEW_TARGET');
  }

  try {
    connection.db.transaction((tx) => {
      tx.insert(interviewSessions).values({
        sessionId,
        provider,
        userId,
        stageId: storyId ? null : stageId,
        storyId,
        sessionType: 'story',
        status: 'active',
        closeoutStatus: 'pending',
        transcriptJson: '[]',
        closeoutResultJson: context.story ? null : serializeJsonColumn({
          ...(context.task_context?.target_title ? { target_story_title: context.task_context.target_title } : {}),
        }, closeoutResultSchema),
        startedAt,
        createdAt: startedAt,
        updatedAt: startedAt,
      }).run();
    });
  } finally {
    connection.close();
  }

  return { sessionId, provider, startedAt, context, sessionType: 'story' };
}

export function createExternalContributorInterviewSession(
  databasePath: string | undefined,
  userId: string,
  context: ExternalContributorInterviewContext,
  provider: RealtimeInterviewProvider = 'stepaudio3_quality',
): RealtimeInterviewSession {
  const sessionId = randomUUID();
  const startedAt = nowUtcIso();
  const storyId = context.story.story_id;
  const shareId = context.share_id;
  if (!storyId || !shareId) {
    throw new InterviewSessionError('无法确定外部补充采访的故事或分享链接。', 'INVALID_EXTERNAL_INTERVIEW_TARGET');
  }
  const connection = createDatabase(databasePath);
  try {
    connection.db.insert(interviewSessions).values({
      sessionId,
      provider,
      userId,
      stageId: null,
      storyId,
      sessionType: 'story',
      sourceType: 'external_contributor',
      sourceShareId: shareId,
      status: 'active',
      closeoutStatus: 'pending',
      transcriptJson: '[]',
      closeoutResultJson: null,
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    }).run();
  } finally {
    connection.close();
  }
  return { sessionId, provider, startedAt, context, sessionType: 'story' };
}

export function endRealtimeInterviewSession(
  databasePath: string | undefined,
  userId: string,
  sessionId: string,
  endedAt = nowUtcIso(),
  options: EndRealtimeInterviewSessionOptions = {},
): number {
  const connection = createDatabase(databasePath);
  try {
    return connection.db.transaction((tx) => {
      const session = tx.select().from(interviewSessions).where(and(
        eq(interviewSessions.userId, userId),
        eq(interviewSessions.sessionId, sessionId),
      )).get();
      if (!session) throw new InterviewSessionError('Session 不存在。', 'SESSION_NOT_FOUND');
      const transcript = JSON.parse(session.transcriptJson) as unknown;
      if (!Array.isArray(transcript)) throw new InterviewSessionError('Session Transcript 不是数组。', 'TRANSCRIPT_INVALID');
      const update: Partial<typeof interviewSessions.$inferInsert> = { status: 'ended', endedAt, updatedAt: endedAt };
      if (session.sessionType === 'onboarding') {
        let closeoutState: Record<string, unknown> = {};
        try {
          const parsed = session.closeoutResultJson ? JSON.parse(session.closeoutResultJson) : {};
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            closeoutState = parsed as Record<string, unknown>;
          }
        } catch {
          // A malformed previous result is not allowed to grant eligibility.
        }
        closeoutState.completion_eligible = options.onboardingCompletionEligible === true;
        closeoutState.transcript_complete = options.onboardingCompletionEligible === true
          && options.onboardingTranscriptComplete === true;
        update.closeoutResultJson = JSON.stringify(closeoutState);
      }
      tx.update(interviewSessions).set(update)
        .where(and(eq(interviewSessions.userId, userId), eq(interviewSessions.sessionId, sessionId))).run();
      return transcript.length;
    });
  } catch (error) {
    if (error instanceof SyntaxError) throw new InterviewSessionError('Session Transcript JSON 无法解析。', 'TRANSCRIPT_INVALID');
    throw error;
  } finally {
    connection.close();
  }
}
