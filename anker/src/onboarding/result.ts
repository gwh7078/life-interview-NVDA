import { and, desc, eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { parseTranscript } from '../db/transcript.js';
import { interviewSessions, lifeStages, stories, users } from '../db/schema.js';
import { isOnboardingStoryCompletionPending } from './closeout-workflow.js';
import { OnboardingWorkflowError } from './errors.js';
import { onboardingCloseoutResultSchema } from './schema.js';
import { endYearFromStoredDate, yearFromStoredDate } from './years.js';
import type { OnboardingResult, OnboardingSourceReference } from './types.js';

function parseResultState(value: string | null | undefined) {
  if (!value) return onboardingCloseoutResultSchema.parse({});
  try { return onboardingCloseoutResultSchema.parse(JSON.parse(value)); }
  catch { return onboardingCloseoutResultSchema.parse({}); }
}

function uniqueReferences(references: OnboardingSourceReference[]): OnboardingSourceReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.session_id}\u0000${reference.message_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Owner-scoped, public-safe projection for the onboarding result endpoint. */
export function getOnboardingResult(
  databasePath: string | undefined,
  userId: string,
  sessionId?: string,
): OnboardingResult {
  const connection = createDatabase(databasePath);
  try {
    const profile = connection.db.select().from(users).where(eq(users.userId, userId)).get() ?? null;
    let session = null;
    if (sessionId) {
      session = connection.db.select().from(interviewSessions).where(and(
        eq(interviewSessions.userId, userId),
        eq(interviewSessions.sessionId, sessionId),
        eq(interviewSessions.sessionType, 'onboarding'),
      )).get() ?? null;
      if (!session) throw new OnboardingWorkflowError('找不到这次建档采访。', 'SESSION_NOT_FOUND', 404);
    } else {
      session = connection.db.select().from(interviewSessions).where(and(
        eq(interviewSessions.userId, userId),
        eq(interviewSessions.sessionType, 'onboarding'),
      )).orderBy(
        desc(interviewSessions.startedAt),
        desc(interviewSessions.createdAt),
        desc(interviewSessions.sessionId),
      ).get() ?? null;
    }

    const state = parseResultState(session?.closeoutResultJson);
    const profileSourceRefs = state.profile_source_refs ?? {};
    const lifeStageResults: OnboardingResult['life_stages'] = [];
    const storyResults: OnboardingResult['stories'] = [];
    const evidenceReferences: OnboardingSourceReference[] = [];
    const persistedStageReferences = state.life_stages ?? [];
    for (const stageReference of persistedStageReferences) {
      const stage = connection.db.select().from(lifeStages).where(and(
        eq(lifeStages.stageId, stageReference.stage_id),
        eq(lifeStages.userId, userId),
        eq(lifeStages.createdSourceSessionId, session?.sessionId ?? ''),
      )).get();
      if (!stage) continue;
      lifeStageResults.push({
        stage_id: stage.stageId,
        title: stage.title,
        start_year: yearFromStoredDate(stage.startDate),
        end_year: endYearFromStoredDate(stage.endDate),
        status: stage.status,
        sort_order: stage.sortOrder,
        source_refs: stageReference.source_refs,
      });
      evidenceReferences.push(...stageReference.source_refs);
      for (const storyReference of stageReference.stories) {
        const story = connection.db.select().from(stories).where(and(
          eq(stories.storyId, storyReference.story_id),
          eq(stories.userId, userId),
          eq(stories.stageId, stage.stageId),
          eq(stories.createdSourceSessionId, session?.sessionId ?? ''),
        )).get();
        if (!story) continue;
        storyResults.push({
          story_id: story.storyId,
          stage_id: story.stageId,
          title: story.title,
          summary: story.summary,
          status: story.status,
          source_refs: storyReference.source_refs,
        });
        evidenceReferences.push(...storyReference.source_refs);
      }
    }

    for (const fieldReferences of Object.values(profileSourceRefs)) {
      if (fieldReferences) evidenceReferences.push(...fieldReferences);
    }
    const evidence = uniqueReferences(evidenceReferences).flatMap((reference) => {
      const source = connection.db.select({ transcriptJson: interviewSessions.transcriptJson })
        .from(interviewSessions).where(and(
          eq(interviewSessions.sessionId, reference.session_id),
          eq(interviewSessions.userId, userId),
          eq(interviewSessions.sessionType, 'onboarding'),
        )).get();
      if (!source) return [];
      try {
        const message = parseTranscript(source.transcriptJson).find((item) =>
          item.message_id === reference.message_id && item.role === 'user');
        return message ? [{ ...reference, text: message.text }] : [];
      } catch {
        return [];
      }
    });
    const processingError = state.processing_error
      ? {
          ...(state.processing_error.code ? { code: state.processing_error.code } : {}),
          ...(state.processing_error.message ? { message: state.processing_error.message } : {}),
          ...(state.processing_error.retryable !== undefined ? { retryable: state.processing_error.retryable } : {}),
        }
      : null;
    return {
      onboarding_status: profile?.onboardingStatus ?? null,
      story_completion_pending: session ? isOnboardingStoryCompletionPending(session.sessionId) : false,
      session: session ? {
        session_id: session.sessionId,
        status: session.status,
        closeout_status: session.closeoutStatus,
      } : null,
      processing_error: processingError,
      profile: profile ? {
        user_id: profile.userId,
        name: { value: profile.name, source_refs: profileSourceRefs.name ?? [] },
        birth_year: {
          value: yearFromStoredDate(profile.birthDate),
          source_refs: profileSourceRefs.birth_year ?? profileSourceRefs.birth_date ?? [],
        },
        gender: { value: profile.gender, source_refs: profileSourceRefs.gender ?? [] },
        birth_place: { value: profile.birthPlace, source_refs: profileSourceRefs.birth_place ?? [] },
        current_location: { value: profile.currentLocation, source_refs: profileSourceRefs.current_location ?? [] },
        current_status: { value: profile.currentStatus, source_refs: profileSourceRefs.current_status ?? [] },
        profile_summary: { value: profile.profileSummary, source_refs: profileSourceRefs.profile_summary ?? [] },
      } : null,
      life_stages: lifeStageResults,
      stories: storyResults,
      evidence,
    };
  } finally {
    connection.close();
  }
}
