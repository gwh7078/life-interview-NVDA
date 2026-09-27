import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { and, eq, lt, or } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { nowUtcIso } from '../db/time.js';
import { writeDiagnosticLog } from '../diagnostics/logger.js';
import { diagnosticsContentEnabled, writeDiagnosticSnapshot } from '../diagnostics/snapshot.js';
import { interviewSessions } from '../db/schema.js';
import { CloseoutModelError } from '../interview/llm-provider.js';
import type { TextModelProvider } from '../providers/text-model-provider.js';
import { OnboardingRepository } from '../repositories/onboarding-repository.js';
import { OnboardingWorkflowError } from './errors.js';
import { OnboardingCloseoutContextBuilder } from './context-builder.js';
import { OnboardingCloseoutApplier } from './applier.js';
import {
  DirectOnboardingCloseoutProcessor,
  type OnboardingCloseoutConfig,
  type OnboardingCloseoutProcessor,
} from './processor.js';
import { onboardingCloseoutResultSchema } from './schema.js';

export { OnboardingWorkflowError } from './errors.js';
export type { OnboardingCloseoutConfig } from './processor.js';

const DEFAULT_PROVIDER = 'openai-compatible';
const DEFAULT_MODEL = 'qwen3.6-35b-a3b';
const PROCESSING_STALE_MS = 10 * 60_000;
const storyCompletionPendingSessions = new Set<string>();

export interface OnboardingCloseoutDependencies {
  processor?: OnboardingCloseoutProcessor;
  textModelProvider?: TextModelProvider;
  afterApply?: (userId: string, storyId: string) => void | Promise<void>;
}

export function isOnboardingStoryCompletionPending(sessionId: string): boolean {
  return storyCompletionPendingSessions.has(sessionId);
}

export type OnboardingCloseoutStartResult =
  | { status: 'processing'; alreadyProcessing: boolean; attemptId?: string }
  | { status: 'completed' }
  | { status: 'failed'; error: { code: string; message: string; retryable: true } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCloseoutResult(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = onboardingCloseoutResultSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeError(error: unknown): { code: string; message: string; retryable: true } {
  if (error instanceof OnboardingWorkflowError || error instanceof CloseoutModelError) {
    return { code: error.code, message: error.message.slice(0, 1000), retryable: true };
  }
  return {
    code: 'ONBOARDING_CLOSEOUT_FAILED',
    message: '首次建档整理失败，请稍后重试。',
    retryable: true,
  };
}

function markFailed(
  databasePath: string | undefined,
  sessionId: string,
  error: unknown,
  expectedAttemptId: string | undefined,
  ownerUserId: string,
): { code: string; message: string; retryable: true } {
  const failure = safeError(error);
  const connection = createDatabase(databasePath);
  try {
    connection.db.transaction((tx) => {
      const where = and(
        eq(interviewSessions.sessionId, sessionId),
        eq(interviewSessions.userId, ownerUserId),
        eq(interviewSessions.sessionType, 'onboarding'),
      );
      const session = tx.select().from(interviewSessions).where(where).get();
      if (!session || session.closeoutStatus === 'completed' || session.status === 'completed') return;
      if (expectedAttemptId) {
        const previous = parseCloseoutResult(session.closeoutResultJson);
        if (session.closeoutStatus !== 'processing' || previous.processing_attempt_id !== expectedAttemptId) return;
      }
      const previous = parseCloseoutResult(session.closeoutResultJson);
      delete previous.processing_attempt_id;
      previous.processing_error = failure;
      tx.update(interviewSessions).set({
        closeoutStatus: 'failed',
        closeoutResultJson: JSON.stringify(onboardingCloseoutResultSchema.parse(previous)),
        updatedAt: nowUtcIso(),
      }).where(where).run();
    });
  } finally {
    connection.close();
  }
  return failure;
}

function claimCloseout(databasePath: string | undefined, sessionId: string, ownerUserId: string): OnboardingCloseoutStartResult {
  const connection = createDatabase(databasePath);
  try {
    return connection.db.transaction((tx) => {
      const where = and(
        eq(interviewSessions.sessionId, sessionId),
        eq(interviewSessions.userId, ownerUserId),
      );
      const session = tx.select().from(interviewSessions).where(where).get();
      if (!session) throw new OnboardingWorkflowError('找不到这次建档采访。', 'SESSION_NOT_FOUND', 404);
      if (session.sessionType !== 'onboarding') {
        throw new OnboardingWorkflowError('当前会话不是首次建档采访。', 'INVALID_SESSION_TYPE', 409);
      }
      if (session.closeoutStatus === 'completed' || session.status === 'completed') return { status: 'completed' };
      if (!session.endedAt || session.status === 'active') {
        throw new OnboardingWorkflowError('采访还没有结束。', 'SESSION_NOT_ENDED', 409);
      }
      const previous = parseCloseoutResult(session.closeoutResultJson);
      if (previous.completion_eligible !== true) {
        throw new OnboardingWorkflowError('只有实时采访模型确认首次建档完成后，才能整理正式人生档案。', 'ONBOARDING_COMPLETION_REQUIRED', 409);
      }
      if (previous.transcript_complete !== true) {
        throw new OnboardingWorkflowError('最后一轮访谈字幕尚未确认完整。请返回继续建档后再完成整理。', 'ONBOARDING_TRANSCRIPT_INCOMPLETE', 409);
      }
      const timestamp = nowUtcIso();
      const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
      const attemptId = randomUUID();
      const mayClaim = or(
        and(eq(interviewSessions.closeoutStatus, 'pending'), eq(interviewSessions.status, 'ended')),
        and(eq(interviewSessions.closeoutStatus, 'failed'), eq(interviewSessions.status, 'ended')),
        and(
          eq(interviewSessions.closeoutStatus, 'processing'),
          eq(interviewSessions.status, 'ended'),
          lt(interviewSessions.updatedAt, staleBefore),
        ),
      );
      const processingState: Record<string, unknown> = { ...previous, processing_attempt_id: attemptId };
      delete processingState.processing_error;
      const claimed = tx.update(interviewSessions).set({
        closeoutStatus: 'processing',
        closeoutResultJson: JSON.stringify(onboardingCloseoutResultSchema.parse(processingState)),
        updatedAt: timestamp,
      }).where(and(
        eq(interviewSessions.sessionId, sessionId),
        eq(interviewSessions.userId, ownerUserId),
        eq(interviewSessions.sessionType, 'onboarding'),
        mayClaim,
      )).run();
      if (claimed.changes === 1) return { status: 'processing', alreadyProcessing: false, attemptId };
      if (session.closeoutStatus === 'processing') return { status: 'processing', alreadyProcessing: true };
      throw new OnboardingWorkflowError('这次建档采访当前不能启动整理。', 'CLOSEOUT_NOT_CLAIMABLE', 409);
    });
  } finally {
    connection.close();
  }
}

function renewCloseoutLease(
  databasePath: string | undefined,
  sessionId: string,
  attemptId: string,
  ownerUserId: string,
): boolean {
  const connection = createDatabase(databasePath);
  try {
    return connection.db.transaction((tx) => {
      const where = and(
        eq(interviewSessions.sessionId, sessionId),
        eq(interviewSessions.userId, ownerUserId),
        eq(interviewSessions.sessionType, 'onboarding'),
      );
      const session = tx.select().from(interviewSessions).where(where).get();
      if (!session || session.status !== 'ended' || session.closeoutStatus !== 'processing') return false;
      const result = parseCloseoutResult(session.closeoutResultJson);
      if (result.processing_attempt_id !== attemptId) return false;
      const updated = tx.update(interviewSessions).set({ updatedAt: nowUtcIso() }).where(and(
        where,
        eq(interviewSessions.status, 'ended'),
        eq(interviewSessions.closeoutStatus, 'processing'),
        eq(interviewSessions.updatedAt, session.updatedAt),
      )).run();
      return updated.changes === 1;
    });
  } finally {
    connection.close();
  }
}

function currentCloseoutAttempt(databasePath: string | undefined, sessionId: string, ownerUserId: string): string | undefined {
  const connection = createDatabase(databasePath);
  try {
    const session = connection.db.select().from(interviewSessions).where(and(
      eq(interviewSessions.sessionId, sessionId),
      eq(interviewSessions.userId, ownerUserId),
      eq(interviewSessions.sessionType, 'onboarding'),
    )).get();
    if (!session || session.status !== 'ended' || session.closeoutStatus !== 'processing') return undefined;
    const result = parseCloseoutResult(session.closeoutResultJson);
    return typeof result.processing_attempt_id === 'string' ? result.processing_attempt_id : undefined;
  } finally {
    connection.close();
  }
}

async function processCloseout(
  databasePath: string | undefined,
  sessionId: string,
  attemptId: string,
  config: OnboardingCloseoutConfig,
  signal: AbortSignal,
  ownerUserId: string,
  dependencies: OnboardingCloseoutDependencies,
): Promise<void> {
  const startedAt = performance.now();
  let leaseLost = false;
  let appliedStoryIds: string[] = [];
  const heartbeat = setInterval(() => {
    try {
      if (!renewCloseoutLease(databasePath, sessionId, attemptId, ownerUserId)) leaseLost = true;
    } catch {
      leaseLost = true;
    }
  }, Math.max(1_000, Math.floor(PROCESSING_STALE_MS / 3)));
  heartbeat.unref?.();
  try {
    const context = new OnboardingCloseoutContextBuilder(databasePath).build(sessionId, ownerUserId);
    const processor = dependencies.processor
      ?? new DirectOnboardingCloseoutProcessor(dependencies.textModelProvider);
    const processed = await processor.process({
      context,
      config,
      signal,
      onModelAttempt(event) {
        writeDiagnosticLog(
          'onboarding-closeout',
          event.phase === 'failed' || event.phase === 'validation_failed' ? 'warn' : 'info',
          `Onboarding closeout model call ${event.phase}.`,
          {
            event: `model_call.${event.phase}`,
            sessionId,
            attemptId,
            modelAttempt: event.attempt,
            provider: config.provider ?? DEFAULT_PROVIDER,
            ...event,
          },
        );
      },
      assertCurrentAttempt() {
        if (leaseLost || currentCloseoutAttempt(databasePath, sessionId, ownerUserId) !== attemptId) {
          throw new OnboardingWorkflowError('本次建档整理任务已失去处理权。', 'CLOSEOUT_ATTEMPT_STALE', 409);
        }
      },
    });
    if (leaseLost || currentCloseoutAttempt(databasePath, sessionId, ownerUserId) !== attemptId) {
      throw new OnboardingWorkflowError('本次建档整理任务已失去写入权。', 'CLOSEOUT_ATTEMPT_STALE', 409);
    }
    const modelMetadata = {
      provider: config.provider ?? DEFAULT_PROVIDER,
      model: processed.modelResult.model || config.model || DEFAULT_MODEL,
      ...(processed.modelResult.responseId ? { response_id: processed.modelResult.responseId } : {}),
      latency_ms: processed.modelResult.latencyMs,
      ...(processed.modelResult.usage ? {
        usage: Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].flatMap((key) => {
          const value = processed.modelResult.usage?.[key];
          return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[key, value]] : [];
        })),
      } : {}),
    };
    const applied = new OnboardingCloseoutApplier(databasePath).apply({
      userId: ownerUserId,
      sessionId,
      expectedAttemptId: attemptId,
      output: processed.output,
      modelMetadata,
    });
    appliedStoryIds = [...new Set(applied.storyIds)];
    const totalElapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    const profileCandidateCount = Object.values(processed.output.profile).filter((candidate) => candidate.value !== null).length;
    const storyCandidateCount = processed.output.life_stages
      .reduce((count, stage) => count + stage.stories.length, 0);
    writeDiagnosticLog('onboarding-closeout', 'info', 'Onboarding closeout applied.', {
      event: 'closeout.completed',
      sessionId,
      attemptId,
      storyCount: appliedStoryIds.length,
      totalElapsedMs,
      profileCandidateCount,
      lifeStageCount: processed.output.life_stages.length,
      storyCandidateCount,
      model: modelMetadata.model,
      provider: modelMetadata.provider,
      latencyMs: modelMetadata.latency_ms,
    });
    const transcriptMessageCount = context.transcripts
      .reduce((count, transcriptSession) => count + transcriptSession.messages.length, 0);
    writeDiagnosticSnapshot('onboarding-closeout', sessionId, {
      attempt_id: attemptId,
      total_elapsed_ms: totalElapsedMs,
      status: 'completed',
      session_id: sessionId,
      created_story_ids: appliedStoryIds,
      story_count: appliedStoryIds.length,
      profile_candidate_count: profileCandidateCount,
      life_stage_count: processed.output.life_stages.length,
      story_candidate_count: storyCandidateCount,
      model_metadata: modelMetadata,
      transcript_session_count: context.transcripts.length,
      transcript_message_count: transcriptMessageCount,
      ...(diagnosticsContentEnabled() ? {
        content: {
          transcripts: context.transcripts,
          output: processed.output,
          model_output: processed.modelResult.output,
        },
      } : {}),
    });
    if (appliedStoryIds.length > 0 && dependencies.afterApply) {
      storyCompletionPendingSessions.add(sessionId);
    }
  } catch (error) {
    const failure = safeError(error);
    const totalElapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    writeDiagnosticLog('onboarding-closeout', 'error', 'Onboarding closeout failed.', {
      event: 'closeout.failed',
      sessionId,
      attemptId,
      code: failure.code,
      retryable: failure.retryable,
      totalElapsedMs,
      provider: config.provider ?? DEFAULT_PROVIDER,
      model: config.model ?? DEFAULT_MODEL,
      ...(error instanceof CloseoutModelError && error.diagnostics?.responseStatus !== undefined
        ? { responseStatus: error.diagnostics.responseStatus }
        : {}),
    });
    writeDiagnosticSnapshot('onboarding-closeout', sessionId, {
      attempt_id: attemptId,
      total_elapsed_ms: totalElapsedMs,
      status: 'failed',
      session_id: sessionId,
      error: failure,
    });
    try { markFailed(databasePath, sessionId, error, attemptId, ownerUserId); }
    catch { /* The lease will recover if SQLite is temporarily unavailable. */ }
  } finally {
    clearInterval(heartbeat);
  }

  // Derived Story Completion runs only after the atomic Onboarding write committed.
  // A single evaluation failure must never roll back the Profile, stages, Stories, or Closeout result.
  if (appliedStoryIds.length > 0 && dependencies.afterApply) {
    try {
      for (const storyId of appliedStoryIds) {
        try {
          await dependencies.afterApply(ownerUserId, storyId);
        } catch (error) {
          const failureType = error instanceof Error ? error.name : 'unknown';
          console.error('[story-completion] Post-Onboarding evaluation failed.', {
            storyId,
            failureType,
          });
          writeDiagnosticLog('story-completion', 'error', 'Post-Onboarding completion failed.', {
            sessionId,
            storyId,
            failureType,
          });
        }
      }
    } finally {
      storyCompletionPendingSessions.delete(sessionId);
    }
  }
}

/** Records retryable pre-closeout failures, such as an incomplete final Transcript drain. */
export function failOnboardingCloseout(
  databasePath: string | undefined,
  sessionId: string,
  code: string,
  message: string,
  ownerUserId: string,
): void {
  const connection = createDatabase(databasePath);
  try {
    connection.db.transaction((tx) => {
      const where = and(
        eq(interviewSessions.sessionId, sessionId),
        eq(interviewSessions.userId, ownerUserId),
        eq(interviewSessions.sessionType, 'onboarding'),
      );
      const session = tx.select().from(interviewSessions).where(where).get();
      if (!session) throw new OnboardingWorkflowError('找不到这次建档采访。', 'SESSION_NOT_FOUND', 404);
      if (!session.endedAt || session.status === 'active') {
        throw new OnboardingWorkflowError('采访还没有结束。', 'SESSION_NOT_ENDED', 409);
      }
      if (session.closeoutStatus === 'completed' || session.status === 'completed'
        || session.closeoutStatus === 'processing') return;
      const previous = parseCloseoutResult(session.closeoutResultJson);
      delete previous.processing_attempt_id;
      previous.processing_error = {
        code: code.slice(0, 128),
        message: message.slice(0, 1000),
        retryable: previous.completion_eligible === true && previous.transcript_complete === true,
      };
      tx.update(interviewSessions).set({
        closeoutStatus: 'failed',
        closeoutResultJson: JSON.stringify(onboardingCloseoutResultSchema.parse(previous)),
        updatedAt: nowUtcIso(),
      }).where(and(where, or(
        eq(interviewSessions.closeoutStatus, 'pending'),
        eq(interviewSessions.closeoutStatus, 'failed'),
      ))).run();
    });
  } finally {
    connection.close();
  }
}

/** Claims a distinct Onboarding lease, then processes all persisted Onboarding transcripts. */
export function beginOnboardingCloseout(
  databasePath: string | undefined,
  sessionId: string,
  config: OnboardingCloseoutConfig,
  ownerUserId: string,
  dependencies: OnboardingCloseoutDependencies = {},
): OnboardingCloseoutStartResult {
  let claimed: OnboardingCloseoutStartResult;
  try {
    claimed = claimCloseout(databasePath, sessionId, ownerUserId);
  } catch (error) {
    const failure = safeError(error);
    writeDiagnosticLog('onboarding-closeout', 'warn', 'Onboarding closeout start rejected.', {
      event: 'closeout.start_rejected',
      sessionId,
      code: failure.code,
      retryable: failure.retryable,
    });
    throw error;
  }
  if (claimed.status !== 'processing' || claimed.alreadyProcessing) {
    writeDiagnosticLog('onboarding-closeout', 'info', 'Onboarding closeout was not started.', {
      event: 'closeout.not_started',
      sessionId,
      status: claimed.status,
      alreadyProcessing: claimed.status === 'processing' && claimed.alreadyProcessing,
    });
    return claimed;
  }
  if (!claimed.attemptId) {
    throw new OnboardingWorkflowError('无法确认本次建档整理任务的归属。', 'CLOSEOUT_ATTEMPT_UNAVAILABLE', 500);
  }
  writeDiagnosticLog('onboarding-closeout', 'info', 'Onboarding closeout started.', {
    event: 'closeout.started',
    sessionId,
    attemptId: claimed.attemptId,
    provider: config.provider ?? DEFAULT_PROVIDER,
    model: config.model ?? DEFAULT_MODEL,
  });
  const abortController = new AbortController();
  void processCloseout(databasePath, sessionId, claimed.attemptId, config, abortController.signal, ownerUserId, dependencies);
  return claimed;
}
