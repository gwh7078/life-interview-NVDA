import { randomUUID } from 'node:crypto';
import { and, asc, eq, or } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { nowUtcIso } from '../db/time.js';
import { parseTranscript } from '../db/transcript.js';
import {
  interviewSessions,
  lifeStages,
  sessionProviders,
  stories,
  users,
  type InterviewSession,
  type User,
} from '../db/schema.js';
import { onboardingCloseoutResultSchema } from '../onboarding/schema.js';
import { OnboardingWorkflowError } from '../onboarding/errors.js';
import { yearToStoredDate } from '../onboarding/years.js';
import type {
  OnboardingSourceReference,
  OnboardingTranscriptSession,
  ValidatedOnboardingCloseoutOutput,
} from '../onboarding/types.js';

export type OnboardingSessionProvider = Exclude<(typeof sessionProviders)[number], 'openclaw'>;

export interface OnboardingInterviewContextData {
  profile: User | null;
  onboardingStatus: User['onboardingStatus'] | null;
  transcripts: Array<Pick<OnboardingTranscriptSession, 'sessionId' | 'startedAt' | 'messages'>>;
}

export interface CreatedOnboardingInterviewSession {
  sessionId: string;
  provider: OnboardingSessionProvider;
  startedAt: string;
}

export class OnboardingRepositoryError extends OnboardingWorkflowError {
  constructor(message: string, code: string, statusCode = 409) {
    super(message, code, statusCode);
    this.name = 'OnboardingRepositoryError';
  }
}

export interface AppliedOnboardingCloseout {
  sessionId: string;
  stageIds: string[];
  storyIds: string[];
}

function sourceKey(reference: OnboardingSourceReference): string {
  return `${reference.session_id}\u0000${reference.message_id}`;
}

function collectSourceReferences(output: ValidatedOnboardingCloseoutOutput): OnboardingSourceReference[] {
  return [
    ...Object.values(output.profile).flatMap((candidate) => candidate.source_refs),
    ...output.life_stages.flatMap((stage) => [
      ...stage.source_refs,
      ...stage.stories.flatMap((story) => story.source_refs),
    ]),
  ];
}

function assertNoDuplicateReferences(output: ValidatedOnboardingCloseoutOutput): void {
  const lists = [
    ...Object.values(output.profile).map((candidate) => candidate.source_refs),
    ...output.life_stages.flatMap((stage) => [
      stage.source_refs,
      ...stage.stories.map((story) => story.source_refs),
    ]),
  ];
  if (lists.some((references) => new Set(references.map(sourceKey)).size !== references.length)) {
    throw new OnboardingWorkflowError('整理结果包含重复的来源引用。', 'INVALID_SOURCE_REFS', 422);
  }
}

function referenceLists(output: ValidatedOnboardingCloseoutOutput): Record<string, OnboardingSourceReference[]> {
  const fields = Object.fromEntries(
    Object.entries(output.profile).map(([field, candidate]) => [field, candidate.source_refs]),
  ) as Record<string, OnboardingSourceReference[]>;
  return fields;
}

/** Owner-scoped persistence and context access for the Onboarding flow. */
export class OnboardingRepository {
  constructor(private readonly databasePath?: string) {}

  listTranscriptSessionsForUser(userId: string): OnboardingTranscriptSession[] {
    const connection = createDatabase(this.databasePath);
    try {
      const sessions = connection.db.select({
        sessionId: interviewSessions.sessionId,
        provider: interviewSessions.provider,
        status: interviewSessions.status,
        closeoutStatus: interviewSessions.closeoutStatus,
        startedAt: interviewSessions.startedAt,
        transcriptJson: interviewSessions.transcriptJson,
      }).from(interviewSessions).where(and(
        eq(interviewSessions.userId, userId),
        eq(interviewSessions.sessionType, 'onboarding'),
      )).orderBy(
        asc(interviewSessions.startedAt),
        asc(interviewSessions.createdAt),
        asc(interviewSessions.sessionId),
      ).all();
      return sessions.map((session) => ({
        sessionId: session.sessionId,
        provider: session.provider,
        status: session.status,
        closeoutStatus: session.closeoutStatus,
        startedAt: session.startedAt,
        messages: parseTranscript(session.transcriptJson),
      }));
    } finally {
      connection.close();
    }
  }

  getInterviewContextData(userId: string): OnboardingInterviewContextData {
    const connection = createDatabase(this.databasePath);
    try {
      const profile = connection.db.select().from(users).where(eq(users.userId, userId)).get() ?? null;
      if (!profile) return { profile: null, onboardingStatus: null, transcripts: [] };
      return {
        profile,
        onboardingStatus: profile.onboardingStatus,
        transcripts: this.listTranscriptSessionsForUser(userId).map((session) => ({
          sessionId: session.sessionId,
          startedAt: session.startedAt,
          messages: session.messages,
        })),
      };
    } finally {
      connection.close();
    }
  }

  createInterviewSessionForUser(userId: string, provider: OnboardingSessionProvider): CreatedOnboardingInterviewSession {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.transaction((tx) => {
        const profile = tx.select().from(users).where(eq(users.userId, userId)).get();
        if (!profile) throw new OnboardingRepositoryError('找不到当前人生档案。', 'PROFILE_NOT_FOUND', 404);
        if (profile.onboardingStatus === 'completed') {
          throw new OnboardingRepositoryError('首次建档已经完成。', 'ONBOARDING_ALREADY_COMPLETED', 409);
        }
        const finalizingSession = tx.select({ sessionId: interviewSessions.sessionId })
          .from(interviewSessions).where(and(
            eq(interviewSessions.userId, userId),
            eq(interviewSessions.sessionType, 'onboarding'),
            or(
              eq(interviewSessions.closeoutStatus, 'processing'),
              eq(interviewSessions.closeoutStatus, 'completed'),
              eq(interviewSessions.status, 'completed'),
            ),
          )).get();
        if (finalizingSession) {
          throw new OnboardingRepositoryError('首次建档整理正在进行或已经完成。', 'ONBOARDING_CLOSEOUT_IN_PROGRESS', 409);
        }
        const activeSession = tx.select({ sessionId: interviewSessions.sessionId })
          .from(interviewSessions).where(and(
            eq(interviewSessions.userId, userId),
            eq(interviewSessions.sessionType, 'onboarding'),
            eq(interviewSessions.status, 'active'),
          )).get();
        if (activeSession) {
          throw new OnboardingRepositoryError('已有一场首次建档采访正在进行。', 'ONBOARDING_SESSION_ALREADY_ACTIVE', 409);
        }

        const sessionId = randomUUID();
        const startedAt = nowUtcIso();
        tx.insert(interviewSessions).values({
          sessionId,
          provider,
          userId,
          stageId: null,
          storyId: null,
          sessionType: 'onboarding',
          status: 'active',
          closeoutStatus: 'pending',
          transcriptJson: '[]',
          closeoutResultJson: null,
          startedAt,
          endedAt: null,
          createdAt: startedAt,
          updatedAt: startedAt,
        }).run();
        if (profile.onboardingStatus === 'not_started') {
          tx.update(users).set({ onboardingStatus: 'in_progress', updatedAt: startedAt })
            .where(eq(users.userId, userId)).run();
        }
        return { sessionId, provider, startedAt };
      });
    } finally {
      connection.close();
    }
  }

  findSessionForUser(userId: string, sessionId: string): InterviewSession | null {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select().from(interviewSessions).where(and(
        eq(interviewSessions.userId, userId),
        eq(interviewSessions.sessionId, sessionId),
        eq(interviewSessions.sessionType, 'onboarding'),
      )).get() ?? null;
    } finally {
      connection.close();
    }
  }

  applyCloseout(input: {
    userId: string;
    sessionId: string;
    expectedAttemptId: string;
    output: ValidatedOnboardingCloseoutOutput;
    modelMetadata: Record<string, unknown>;
  }): AppliedOnboardingCloseout {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.transaction((tx) => {
        const session = tx.select().from(interviewSessions).where(and(
          eq(interviewSessions.userId, input.userId),
          eq(interviewSessions.sessionId, input.sessionId),
        )).get();
        if (!session) throw new OnboardingWorkflowError('找不到这次建档采访。', 'SESSION_NOT_FOUND', 404);
        if (session.sessionType !== 'onboarding') {
          throw new OnboardingWorkflowError('当前会话不是首次建档采访。', 'INVALID_SESSION_TYPE', 409);
        }
        if (!session.endedAt || session.status === 'active') {
          throw new OnboardingWorkflowError('采访还没有结束，不能写入建档结果。', 'SESSION_NOT_ENDED', 409);
        }
        if (session.closeoutStatus === 'completed' || session.status === 'completed') {
          throw new OnboardingWorkflowError('首次建档结果已经写入。', 'ONBOARDING_CLOSEOUT_ALREADY_APPLIED', 409);
        }
        let previous: Record<string, unknown> = {};
        try {
          const parsed = onboardingCloseoutResultSchema.safeParse(
            session.closeoutResultJson ? JSON.parse(session.closeoutResultJson) : {},
          );
          if (parsed.success) previous = parsed.data as Record<string, unknown>;
        } catch {
          previous = {};
        }
        if (session.closeoutStatus !== 'processing' || previous.processing_attempt_id !== input.expectedAttemptId) {
          throw new OnboardingWorkflowError('本次建档整理任务已失去写入权。', 'CLOSEOUT_ATTEMPT_STALE', 409);
        }
        if (previous.completion_eligible !== true) {
          throw new OnboardingWorkflowError('当前采访未获得模型完成确认，不能写入人生档案。', 'ONBOARDING_COMPLETION_REQUIRED', 409);
        }
        if (previous.transcript_complete !== true) {
          throw new OnboardingWorkflowError('最后一轮访谈字幕尚未确认完整，不能写入人生档案。', 'ONBOARDING_TRANSCRIPT_INCOMPLETE', 409);
        }

        const profile = tx.select().from(users).where(eq(users.userId, input.userId)).get();
        if (!profile) throw new OnboardingWorkflowError('找不到当前人生档案。', 'PROFILE_NOT_FOUND', 404);
        if (profile.onboardingStatus === 'completed') {
          throw new OnboardingWorkflowError('首次建档已由另一场采访完成。', 'ONBOARDING_ALREADY_COMPLETED', 409);
        }
        if (!input.output.profile.name.value.trim()) {
          throw new OnboardingWorkflowError('Profile 姓名为必填项。', 'PROFILE_NAME_REQUIRED', 422);
        }
        assertNoDuplicateReferences(input.output);

        // Re-resolve every model-originated reference inside the same transaction as final writes.
        // A valid prompt alias is not sufficient if its underlying session or message changed.
        const references = collectSourceReferences(input.output);
        for (const reference of references) {
          const sourceSession = tx.select({ transcriptJson: interviewSessions.transcriptJson })
            .from(interviewSessions).where(and(
              eq(interviewSessions.sessionId, reference.session_id),
              eq(interviewSessions.userId, input.userId),
              eq(interviewSessions.sessionType, 'onboarding'),
            )).get();
          if (!sourceSession) {
            throw new OnboardingWorkflowError('整理结果引用了无效的建档采访来源。', 'INVALID_SOURCE_REFS', 422);
          }
          let transcript;
          try { transcript = parseTranscript(sourceSession.transcriptJson); }
          catch { throw new OnboardingWorkflowError('建档采访原始记录无法读取。', 'TRANSCRIPT_INVALID', 422); }
          if (!transcript.some((message) => message.message_id === reference.message_id
            && message.role === 'user' && message.text.trim().length > 0)) {
            throw new OnboardingWorkflowError('整理结果来源必须是已保存的用户发言。', 'INVALID_SOURCE_REFS', 422);
          }
        }

        const timestamp = nowUtcIso();
        const resolvedProfileRefs = referenceLists(input.output);
        const profileUpdates: Partial<typeof users.$inferInsert> = {
          name: input.output.profile.name.value.trim(),
          onboardingStatus: 'completed',
          updatedAt: timestamp,
        };
        const nameRefs = input.output.profile.name.source_refs;
        if (nameRefs.length === 0) {
          throw new OnboardingWorkflowError('Profile 姓名缺少用户来源。', 'SOURCE_REFS_REQUIRED', 422);
        }
        if (input.output.profile.birth_year.value !== null) {
          profileUpdates.birthDate = yearToStoredDate(input.output.profile.birth_year.value);
          // Retained for compatibility with older readers of the legacy profile column.
          profileUpdates.birthDatePrecision = 'year';
        }
        if (input.output.profile.gender.value !== null) profileUpdates.gender = input.output.profile.gender.value;
        if (input.output.profile.birth_place.value !== null) profileUpdates.birthPlace = input.output.profile.birth_place.value;
        if (input.output.profile.current_location.value !== null) profileUpdates.currentLocation = input.output.profile.current_location.value;
        if (input.output.profile.current_status.value !== null) profileUpdates.currentStatus = input.output.profile.current_status.value;
        if (input.output.profile.profile_summary.value !== null) profileUpdates.profileSummary = input.output.profile.profile_summary.value;
        tx.update(users).set(profileUpdates).where(eq(users.userId, input.userId)).run();

        const existingStages = tx.select({ sortOrder: lifeStages.sortOrder }).from(lifeStages)
          .where(eq(lifeStages.userId, input.userId)).all();
        let nextSortOrder = existingStages.reduce((max, stage) => Math.max(max, stage.sortOrder), -1) + 1;
        const stageIds: string[] = [];
        const storyIds: string[] = [];
        const persistedStages: Array<{
          stage_id: string;
          source_refs: OnboardingSourceReference[];
          stories: Array<{ story_id: string; source_refs: OnboardingSourceReference[] }>;
        }> = [];
        for (const stageDraft of input.output.life_stages) {
          const stageId = randomUUID();
          stageIds.push(stageId);
          tx.insert(lifeStages).values({
            stageId,
            userId: input.userId,
            title: stageDraft.title,
            startDate: stageDraft.start_year === null ? null : yearToStoredDate(stageDraft.start_year),
            endDate: stageDraft.end_year === null || stageDraft.end_year === 'now'
              ? stageDraft.end_year
              : yearToStoredDate(stageDraft.end_year),
            datePrecision: null,
            summary: null,
            sortOrder: nextSortOrder++,
            status: 'active',
            createdSourceSessionId: input.sessionId,
            createdAt: timestamp,
            updatedAt: timestamp,
          }).run();
          const persistedStories: Array<{ story_id: string; source_refs: OnboardingSourceReference[] }> = [];
          for (const storyDraft of stageDraft.stories) {
            const storyId = randomUUID();
            storyIds.push(storyId);
            tx.insert(stories).values({
              storyId,
              userId: input.userId,
              stageId,
              title: storyDraft.title,
              summary: storyDraft.summary,
              agentMemory: storyDraft.summary,
              status: 'pending',
              createdSourceSessionId: input.sessionId,
              createdAt: timestamp,
              updatedAt: timestamp,
            }).run();
            persistedStories.push({ story_id: storyId, source_refs: storyDraft.source_refs });
          }
          persistedStages.push({ stage_id: stageId, source_refs: stageDraft.source_refs, stories: persistedStories });
        }

        const resultJson = JSON.stringify(onboardingCloseoutResultSchema.parse({
          completion_eligible: previous.completion_eligible,
          transcript_complete: previous.transcript_complete,
          profile_source_refs: resolvedProfileRefs,
          life_stages: persistedStages,
          model_metadata: input.modelMetadata,
        }));
        const finished = tx.update(interviewSessions).set({
          closeoutResultJson: resultJson,
          status: 'completed',
          closeoutStatus: 'completed',
          updatedAt: timestamp,
        }).where(and(
          eq(interviewSessions.userId, input.userId),
          eq(interviewSessions.sessionId, input.sessionId),
          eq(interviewSessions.sessionType, 'onboarding'),
          eq(interviewSessions.status, 'ended'),
          eq(interviewSessions.closeoutStatus, 'processing'),
        )).run();
        if (finished.changes !== 1) {
          throw new OnboardingWorkflowError('建档采访状态已变化，结果未写入。', 'CLOSEOUT_ATTEMPT_STALE', 409);
        }
        return { sessionId: input.sessionId, stageIds, storyIds };
      });
    } finally {
      connection.close();
    }
  }
}
