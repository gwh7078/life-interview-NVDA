import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { and, eq, lt, or } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { interviewSessions } from '../db/schema.js';
import { closeoutResultSchema, parseTranscript } from '../db/transcript.js';
import { nowUtcIso } from '../db/time.js';
import { writeDiagnosticLog } from '../diagnostics/logger.js';
import { diagnosticsContentEnabled, writeDiagnosticSnapshot } from '../diagnostics/snapshot.js';
import {
  InterviewSessionRepository,
  LifeStageRepository,
  StoryRepository,
  TranscriptRepository,
} from '../repositories/domain-repositories.js';
import { CloseoutModelError, type CloseoutModelConfig } from './llm-provider.js';
import {
  DirectModelCloseoutProcessor,
  type CloseoutProcessor,
  type CloseoutProcessorConfig,
} from './closeout/processor.js';
import { StoryCloseoutContextBuilder } from './closeout/context-builder.js';
import { StoryCloseoutApplier } from './closeout/applier.js';
import { CloseoutWorkflowError } from './closeout/errors.js';
import type { TextModelProvider } from '../providers/text-model-provider.js';

export { CloseoutWorkflowError } from './closeout/errors.js';

const DEFAULT_PROVIDER = 'openai-compatible';
const DEFAULT_MODEL = 'qwen3.6-35b-a3b';
const PROCESSING_STALE_MS = 10 * 60_000;

interface RepairAttemptLog {
  count: number;
  recent: Array<{ code: string }>;
}

export interface CloseoutWorkflowConfig extends CloseoutProcessorConfig {}

export interface CloseoutWorkflowDependencies {
  processor?: CloseoutProcessor;
  textModelProvider?: TextModelProvider;
  afterApply?: (userId: string, storyId: string) => void | Promise<void>;
}

export type CloseoutStartResult =
  | { status: 'processing'; alreadyProcessing: boolean; attemptId?: string }
  | { status: 'completed' }
  | { status: 'failed'; error: { code: string; message: string } };

interface InFlightCloseout {
  promise: Promise<void>;
  abortController: AbortController;
  storyCompletionPending: boolean;
}

const inFlightCloseouts = new Map<string, InFlightCloseout>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCloseoutResult(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    const compact = closeoutResultSchema.safeParse(parsed);
    return compact.success ? compact.data as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function errorProperty(error: unknown, key: string): unknown {
  return error && typeof error === 'object'
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

function agentFailureCode(error: unknown): string | undefined {
  const code = errorProperty(error, 'code');
  if (typeof code === 'string' && code) return code;
  if (errorProperty(error, 'name') === 'AgentProposalValidationError') {
    const feedback = errorProperty(error, 'feedback');
    if (Array.isArray(feedback)) {
      const first = feedback[0];
      if (first && typeof first === 'object' && typeof (first as { code?: unknown }).code === 'string') {
        return (first as { code: string }).code;
      }
    }
  }
  return undefined;
}

function isRetryableAgentFailure(error: unknown): boolean {
  const code = agentFailureCode(error);
  if (code?.startsWith('AGENT_RUNTIME_') || code?.startsWith('AGENT_RESULT_')) return true;
  return errorProperty(error, 'name') === 'AgentProposalValidationError';
}

function safeError(error: unknown, repairLog?: RepairAttemptLog): {
  code: string;
  message: string;
  retryable: boolean;
  diagnostics?: Record<string, unknown>;
} {
  let failure: { code: string; message: string; retryable: boolean; diagnostics?: Record<string, unknown> };
  if (error instanceof CloseoutWorkflowError) {
    failure = {
      code: error.code,
      message: error.message,
      retryable: error.code === 'CLOSEOUT_CANCELLED',
      ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
    };
  } else if (error instanceof CloseoutModelError) {
    failure = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.diagnostics ? { diagnostics: error.diagnostics as unknown as Record<string, unknown> } : {}),
    };
  } else {
    const agentCode = agentFailureCode(error);
    const agentFailure = isRetryableAgentFailure(error);
    failure = {
      code: agentCode ?? 'CLOSEOUT_FAILED',
      message: '访谈整理失败，请稍后重试。',
      retryable: agentFailure,
      diagnostics: {
        failureType: error instanceof Error ? error.name : 'unknown',
        ...(agentCode ? { agent_error_code: agentCode } : {}),
      },
    };
  }
  if (!repairLog?.count) return failure;
  return {
    ...failure,
    diagnostics: {
      ...failure.diagnostics,
      repair_attempt_count: repairLog.count,
      repair_attempts: repairLog.recent,
    },
  };
}

function markFailed(
  databasePath: string | undefined,
  sessionId: string,
  error: unknown,
  expectedAttemptId: string | undefined,
  ownerUserId: string,
  repairs?: RepairAttemptLog,
): { code: string; message: string } {
  const failure = safeError(error, repairs);
  const connection = createDatabase(databasePath);
  try {
    connection.db.transaction((tx) => {
      const where = and(eq(interviewSessions.sessionId, sessionId), eq(interviewSessions.userId, ownerUserId));
      const session = tx.select().from(interviewSessions).where(where).get();
      if (!session || session.closeoutStatus === 'completed') return;
      const previous = parseCloseoutResult(session.closeoutResultJson);
      if (expectedAttemptId && (session.closeoutStatus !== 'processing' || previous.processing_attempt_id !== expectedAttemptId)) return;
      delete previous.processing_attempt_id;
      previous.processing_error = failure;
      const safeResult = closeoutResultSchema.parse(previous);
      tx.update(interviewSessions).set({
        closeoutStatus: 'failed',
        closeoutResultJson: JSON.stringify(safeResult),
        updatedAt: nowUtcIso(),
      }).where(where).run();
    });
  } finally {
    connection.close();
  }
  return failure;
}

function claimCloseout(databasePath: string | undefined, sessionId: string, ownerUserId: string): CloseoutStartResult {
  const connection = createDatabase(databasePath);
  try {
    return connection.db.transaction((tx) => {
      const where = and(eq(interviewSessions.sessionId, sessionId), eq(interviewSessions.userId, ownerUserId));
      const session = tx.select().from(interviewSessions).where(where).get();
      if (!session) throw new CloseoutWorkflowError('找不到这次访谈。', 'SESSION_NOT_FOUND', 404);
      if (session.closeoutStatus === 'completed' || session.status === 'completed') return { status: 'completed' };
      const previous = parseCloseoutResult(session.closeoutResultJson);
      const failure = isRecord(previous.processing_error) ? previous.processing_error : undefined;
      const transcriptRetryBlockedCodes = new Set([
        'TRANSCRIPT_EMPTY', 'TRANSCRIPT_INVALID', 'SESSION_END_FAILED',
        'TRANSCRIPT_WRITE_INCOMPLETE', 'TRANSCRIPT_DRAIN_INCOMPLETE',
      ]);
      if (session.closeoutStatus === 'failed' && typeof failure?.code === 'string'
        && transcriptRetryBlockedCodes.has(failure.code)) {
        throw new CloseoutWorkflowError('访谈原始记录不完整，不能直接重试整理；请先检查 Transcript。', 'CLOSEOUT_RETRY_BLOCKED', 409);
      }
      if (session.sessionType !== 'story') throw new CloseoutWorkflowError('当前只支持整理 Story 访谈。', 'INVALID_SESSION_TYPE');
      if (session.sourceType !== 'subject') throw new CloseoutWorkflowError('外部贡献者访谈不能进入主人公 Story 整理链路。', 'INVALID_SESSION_SOURCE', 409);
      if (!session.endedAt || session.status === 'active') throw new CloseoutWorkflowError('访谈还没有结束。', 'SESSION_NOT_ENDED', 409);

      const timestamp = nowUtcIso();
      const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
      const attemptId = randomUUID();
      const mayClaim = or(
        and(eq(interviewSessions.closeoutStatus, 'pending'), eq(interviewSessions.status, 'ended')),
        and(eq(interviewSessions.closeoutStatus, 'failed'), eq(interviewSessions.status, 'ended')),
        and(eq(interviewSessions.closeoutStatus, 'processing'), eq(interviewSessions.status, 'ended'), lt(interviewSessions.updatedAt, staleBefore)),
      );
      const claimed = tx.update(interviewSessions).set({
        closeoutStatus: 'processing',
        closeoutResultJson: JSON.stringify({
          ...(typeof previous.target_story_title === 'string' ? { target_story_title: previous.target_story_title } : {}),
          processing_attempt_id: attemptId,
        }),
        updatedAt: timestamp,
      }).where(and(eq(interviewSessions.sessionId, sessionId), eq(interviewSessions.userId, ownerUserId), mayClaim)).run();
      if (claimed.changes === 1) return { status: 'processing', alreadyProcessing: false, attemptId };
      if (session.closeoutStatus === 'processing') return { status: 'processing', alreadyProcessing: true };
      throw new CloseoutWorkflowError('这次访谈当前不能启动整理。', 'CLOSEOUT_NOT_CLAIMABLE', 409);
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
      const where = and(eq(interviewSessions.sessionId, sessionId), eq(interviewSessions.userId, ownerUserId));
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
    const where = and(eq(interviewSessions.sessionId, sessionId), eq(interviewSessions.userId, ownerUserId));
    const session = connection.db.select().from(interviewSessions).where(where).get();
    if (!session || session.status !== 'ended' || session.closeoutStatus !== 'processing') return undefined;
    const result = parseCloseoutResult(session.closeoutResultJson);
    return typeof result.processing_attempt_id === 'string' ? result.processing_attempt_id : undefined;
  } finally {
    connection.close();
  }
}

function cancellationError(error: unknown): unknown {
  const code = errorProperty(error, 'code');
  return (error instanceof CloseoutModelError && error.code === 'MODEL_CANCELLED') || code === 'AGENT_RUNTIME_CANCELLED'
    ? new CloseoutWorkflowError('已停止访谈整理。', 'CLOSEOUT_CANCELLED', 409)
    : error;
}

async function processCloseout(
  databasePath: string | undefined,
  sessionId: string,
  attemptId: string,
  config: CloseoutWorkflowConfig,
  signal: AbortSignal,
  ownerUserId: string,
  dependencies: CloseoutWorkflowDependencies,
  markStoryCompletionPending: () => void,
): Promise<void> {
  const startedAt = performance.now();
  const repairs: RepairAttemptLog = { count: 0, recent: [] };
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
    const context = new StoryCloseoutContextBuilder(databasePath).build(sessionId, ownerUserId);
    const processor = dependencies.processor
      ?? new DirectModelCloseoutProcessor(dependencies.textModelProvider);
    const processed = await processor.process({
      context,
      config,
      signal,
      repairLog: repairs,
      onModelAttempt(event) {
        writeDiagnosticLog(
          'story-closeout',
          event.phase === 'failed' || event.phase === 'validation_failed' ? 'warn' : 'info',
          `Story closeout model call ${event.phase}.`,
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
          throw new CloseoutWorkflowError('本次整理任务已失去处理权，已停止继续调用模型。', 'CLOSEOUT_ATTEMPT_STALE', 409);
        }
      },
    });
    if (leaseLost || currentCloseoutAttempt(databasePath, sessionId, ownerUserId) !== attemptId) {
      throw new CloseoutWorkflowError('本次整理任务已失去写入权，已停止继续整理。', 'CLOSEOUT_ATTEMPT_STALE', 409);
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
      repair_attempt_count: processed.repairAttemptCount,
    };
    const applied = new StoryCloseoutApplier(databasePath).apply({
      context,
      output: processed.output,
      expectedAttemptId: attemptId,
      modelMetadata,
    });
    appliedStoryIds = [...new Set([applied.storyId, ...applied.createdStoryIds])];
    const currentStoryOutput = processed.output.mode === 'continue'
      ? processed.output.current_story
      : processed.output.story;
    const totalElapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    console.info('[story-closeout] applied', {
      sessionId,
      storyId: applied.storyId,
      storyUpdated: applied.storyUpdated,
      createdStoryCount: applied.createdStoryIds.length,
      completionStoryCount: appliedStoryIds.length,
    });
    writeDiagnosticLog('story-closeout', 'info', 'Story closeout applied.', {
      event: 'closeout.completed',
      sessionId,
      attemptId,
      storyId: applied.storyId,
      storyUpdated: applied.storyUpdated,
      createdStoryCount: applied.createdStoryIds.length,
      completionStoryCount: appliedStoryIds.length,
      repairAttemptCount: processed.repairAttemptCount,
      totalElapsedMs,
      outputMode: processed.output.mode,
      summaryChars: currentStoryOutput.summary.length,
      agentMemoryChars: currentStoryOutput.agent_memory.length,
      sourceMessageCount: currentStoryOutput.source_message_ids.length,
      newStoryCount: processed.output.mode === 'continue' ? processed.output.new_stories.length : 0,
      model: modelMetadata.model,
      provider: modelMetadata.provider,
      latencyMs: modelMetadata.latency_ms,
      responseId: processed.modelResult.responseId,
    });
    writeDiagnosticSnapshot('story-closeout', sessionId, {
      attempt_id: attemptId,
      total_elapsed_ms: totalElapsedMs,
      status: 'completed',
      session_id: sessionId,
      story_id: applied.storyId,
      created_story_ids: applied.createdStoryIds,
      story_updated: applied.storyUpdated,
      repair_attempt_count: processed.repairAttemptCount,
      output_mode: processed.output.mode,
      new_story_count: processed.output.mode === 'continue' ? processed.output.new_stories.length : 0,
      model_metadata: modelMetadata,
      current_story: {
        summary_chars: currentStoryOutput.summary.length,
        agent_memory_chars: currentStoryOutput.agent_memory.length,
        source_message_count: currentStoryOutput.source_message_ids.length,
      },
      transcript_message_count: context.transcript.length,
      ...(diagnosticsContentEnabled() ? {
        content: {
          transcript: context.transcript,
          previous_summary: context.currentStory?.summary ?? null,
          previous_agent_memory: context.currentStory?.agent_memory ?? null,
          output: processed.output,
          model_output: processed.modelResult.output,
        },
      } : {}),
    });
  } catch (error) {
    const failure = safeError(cancellationError(error), repairs);
    const totalElapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    writeDiagnosticLog('story-closeout', 'error', 'Story closeout failed.', {
      event: 'closeout.failed',
      sessionId,
      attemptId,
      code: failure.code,
      retryable: failure.retryable,
      repairAttemptCount: repairs.count,
      totalElapsedMs,
      provider: config.provider ?? DEFAULT_PROVIDER,
      model: config.model ?? DEFAULT_MODEL,
      ...(typeof failure.diagnostics?.responseStatus === 'number'
        ? { responseStatus: failure.diagnostics.responseStatus }
        : {}),
    });
    writeDiagnosticSnapshot('story-closeout', sessionId, {
      attempt_id: attemptId,
      total_elapsed_ms: totalElapsedMs,
      status: 'failed',
      session_id: sessionId,
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        diagnostics: failure.diagnostics,
      },
    });
    try {
      markFailed(databasePath, sessionId, cancellationError(error), attemptId, ownerUserId, repairs);
    } catch {
      // Let the lease recover if SQLite is unavailable.
    }
  } finally {
    clearInterval(heartbeat);
  }

  // This hook is deliberately outside the Closeout failure boundary. The Closeout
  // transaction has committed, so a derived Completion failure must never rewrite it.
  if (appliedStoryIds.length > 0 && dependencies.afterApply) {
    markStoryCompletionPending();
    for (const storyId of appliedStoryIds) {
      try {
        await dependencies.afterApply(ownerUserId, storyId);
      } catch (error) {
        const failureType = error instanceof Error ? error.name : 'unknown';
        console.error('[story-completion] Post-Closeout evaluation failed.', {
          storyId,
          failureType,
        });
        writeDiagnosticLog('story-completion', 'error', 'Post-Closeout completion failed.', {
          sessionId,
          storyId,
          failureType,
        });
      }
    }
  }
}

export function failInterviewCloseout(
  databasePath: string | undefined,
  sessionId: string,
  code: string,
  message: string,
  ownerUserId: string,
): void {
  markFailed(databasePath, sessionId, new CloseoutWorkflowError(message, code, 422), undefined, ownerUserId);
}

export function beginInterviewCloseout(
  databasePath: string | undefined,
  sessionId: string,
  config: CloseoutWorkflowConfig,
  ownerUserId: string,
  dependencies: CloseoutWorkflowDependencies = {},
): CloseoutStartResult {
  let claimed: CloseoutStartResult;
  try {
    claimed = claimCloseout(databasePath, sessionId, ownerUserId);
  } catch (error) {
    const failure = safeError(error);
    writeDiagnosticLog('story-closeout', 'warn', 'Story closeout start rejected.', {
      event: 'closeout.start_rejected',
      sessionId,
      code: failure.code,
      retryable: failure.retryable,
    });
    throw error;
  }
  if (claimed.status !== 'processing' || claimed.alreadyProcessing) {
    writeDiagnosticLog('story-closeout', 'info', 'Story closeout was not started.', {
      event: 'closeout.not_started',
      sessionId,
      status: claimed.status,
      alreadyProcessing: claimed.status === 'processing' && claimed.alreadyProcessing,
    });
    return claimed;
  }
  if (!claimed.attemptId) throw new CloseoutWorkflowError('无法确认本次整理任务的归属。', 'CLOSEOUT_ATTEMPT_UNAVAILABLE', 500);
  writeDiagnosticLog('story-closeout', 'info', 'Story closeout started.', {
    event: 'closeout.started',
    sessionId,
    attemptId: claimed.attemptId,
    provider: config.provider ?? DEFAULT_PROVIDER,
    model: config.model ?? DEFAULT_MODEL,
  });
  const abortController = new AbortController();
  const inFlight: InFlightCloseout = {
    promise: Promise.resolve(),
    abortController,
    storyCompletionPending: false,
  };
  const job = processCloseout(
    databasePath, sessionId, claimed.attemptId, config, abortController.signal, ownerUserId, dependencies,
    () => { inFlight.storyCompletionPending = true; },
  ).finally(() => {
    if (inFlightCloseouts.get(sessionId)?.promise === job) inFlightCloseouts.delete(sessionId);
  });
  inFlight.promise = job;
  inFlightCloseouts.set(sessionId, inFlight);
  return claimed;
}

export function cancelInterviewCloseout(sessionId: string): { status: 'cancelling' | 'not_running' } {
  const current = inFlightCloseouts.get(sessionId);
  if (!current) return { status: 'not_running' };
  current.abortController.abort();
  return { status: 'cancelling' };
}

export function getInterviewCloseoutResult(
  databasePath: string | undefined,
  sessionId: string,
  ownerUserId: string,
): Record<string, unknown> {
  const sessions = new InterviewSessionRepository(databasePath);
  const session = sessions.findByIdForUser(ownerUserId, sessionId);
  if (!session) throw new CloseoutWorkflowError('找不到这次访谈。', 'SESSION_NOT_FOUND', 404);
  const transcript = new TranscriptRepository(databasePath).getForSession(session.userId, sessionId) ?? [];
  const closeoutResult = parseCloseoutResult(session.closeoutResultJson);
  delete closeoutResult.processing_attempt_id;
  const sourceMessages = Object.fromEntries(transcript
    .filter((message) => message.role === 'user')
    .map((message) => [message.message_id, message.text]));
  const stories = new StoryRepository(databasePath);
  const story = session.storyId ? stories.findByIdForUser(session.userId, session.storyId) : null;
  const stage = story ? new LifeStageRepository(databasePath).findByIdForUser(session.userId, story.stageId) : null;
  const createdRefs = Array.isArray(closeoutResult.new_stories)
    ? closeoutResult.new_stories.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.story_id === 'string')
    : [];
  const createdStories = createdRefs.flatMap((reference) => {
    const created = stories.findByIdForUser(session.userId, reference.story_id as string);
    if (!created || created.createdSourceSessionId !== session.sessionId) return [];
    const createdStage = new LifeStageRepository(databasePath).findByIdForUser(session.userId, created.stageId);
    return [{
      story_id: created.storyId,
      title: created.title,
      summary: created.summary,
      stage_id: created.stageId,
      stage_title: createdStage?.title ?? null,
      status: created.status,
      source_message_ids: Array.isArray(reference.source_message_ids) ? reference.source_message_ids : [],
    }];
  });
  const processingError = isRecord(closeoutResult.processing_error) ? closeoutResult.processing_error : undefined;
  const errorCode = typeof processingError?.code === 'string' ? processingError.code : undefined;
  return {
    status: session.status,
    closeoutStatus: session.closeoutStatus,
    storyCompletionPending: inFlightCloseouts.get(sessionId)?.storyCompletionPending === true,
    ...(processingError ? {
      error: typeof processingError.message === 'string' ? processingError.message : '访谈整理失败，请稍后重试。',
      errorCode: errorCode ?? 'CLOSEOUT_FAILED',
      retryable: processingError.retryable === true,
    } : {}),
    ...(session.closeoutStatus === 'failed' && !processingError ? {
      error: '访谈整理失败，请稍后重试。', errorCode: 'CLOSEOUT_FAILED', retryable: false,
    } : {}),
    session: {
      session_id: session.sessionId,
      provider: session.provider,
      session_type: session.sessionType,
      status: session.status,
      closeout_status: session.closeoutStatus,
      started_at: session.startedAt,
      ended_at: session.endedAt,
      story_id: session.storyId,
    },
    story: story ? {
      story_id: story.storyId,
      title: story.title,
      summary: story.summary,
      status: story.status,
      stage_id: story.stageId,
      stage_title: stage?.title ?? null,
    } : null,
    newStories: createdStories,
    currentStorySourceMessageIds: Array.isArray(closeoutResult.current_story_source_message_ids)
      ? closeoutResult.current_story_source_message_ids
      : [],
    modelMetadata: isRecord(closeoutResult.model_metadata) ? closeoutResult.model_metadata : null,
    transcript,
    sourceMessages,
  };
}
