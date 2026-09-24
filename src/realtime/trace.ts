import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeDiagnosticLog } from '../diagnostics/logger.js';

const SAFE_TRACE_FIELD_KEYS = [
  'callId',
  'toolRunId',
  'toolName',
  'candidateCount',
  'retrievalEvidenceCount',
  'retrievalLatencyMs',
  'qaUnitCount',
  'storyExists',
  'storySummaryChars',
  'recentContextChars',
  'evidenceInputChars',
  'inputChars',
  'slowAgentStarted',
  'slowAgentSkipped',
  'slowAgentSkipReason',
  'slowAgentModel',
  'slowAgentLatencyMs',
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'selectedEvidenceCount',
  'possibleConflictCount',
  'interviewHintCount',
  'fallbackUsed',
  'fallbackType',
  'slowPathLatencyMs',
  'toolResultWriteLatencyMs',
  'toolToFirstAudioMs',
  'terminalOutcome',
  'skill',
  'attemptId',
  'runId',
  'contextVersion',
  'queryChars',
  'factCount',
  'factClaimChars',
  'deadlineMs',
  'errorCode',
  'recallStatus',
  'resumeRequested',
  'stale',
  'slowRecallLatencyMs',
  'toolResultLatencyMs',
  'latencyMs',
  'totalElapsedMs',
  'provider',
  'closeoutStatus',
  'closeoutErrorCode',
  'jobId',
  'documentId',
  'name',
  'sent',
  'error',
  'responseId',
  'responseAId',
  'responseBId',
  'eventId',
  'source',
  'tracePoint',
  'stage',
  'turnId',
  'status',
  'ttsType',
  'chunk',
  'chunks',
  'deltaBytes',
  'totalBytes',
  'bytes',
  'frames',
  'frameBytes',
  'chars',
  'deltaCount',
  'deltaChars',
  'renderedChars',
  'textPresent',
  'forwarded',
  'micPacketCount',
  'micPacketAgeMs',
  'turnDetectionMode',
  'silenceObservedMs',
  'silenceThresholdMs',
  'turnState',
  'liveLineVisible',
  'sampleRate',
  'pcmDurationMs',
  'queuedAudioMs',
  'maxQueuedAudioMs',
  'responseDoneToPlaybackDrainMs',
  'playbackCursorAheadMs',
  'playbackNodes',
  'pendingScheduleCount',
  'segmentCount',
  'microphoneStreaming',
  'providerReadyBeforePlaybackReady',
  'mode',
  'contextState',
  'contextTimeMs',
  'scheduledContextTimeMs',
  'baseLatencyMs',
  'outputLatencyMs',
  'echoCancellation',
  'noiseSuppression',
  'autoGainControl',
  'elapsedMs',
  'clientElapsedMs',
  'speechStoppedToUserFinalMs',
  'userFinalToAssistantStartedMs',
  'assistantStartedToFirstAudioMs',
  'interArrivalMs',
  'firstAudioMs',
  'maxGapMs',
  'maxArrivalGapMs',
  'maxScheduleGapMs',
  'maxPlaybackDelayMs',
  'scheduleGapMs',
  'playbackDelayMs',
  'contextElapsedSinceScheduledStartMs',
  'nodeLifetimeMs',
  'pendingNodes',
  'scheduledChunks',
  'droppedChunks',
  'eventCount',
  'intervalMs',
  'responseActive',
  'activeResponseCount',
  'pendingSpeech',
  'awaitingUserTranscript',
  'awaitingAssistant',
  'lifecycle',
  'reason',
  'role',
  'queueDepth',
  'statusCode',
  'drained',
  'transcriptCount',
  'savedTranscriptCount',
  'pendingWriteCount',
  'scheduled',
  'boundaryJump',
  'maxBoundaryJump',
  'peak',
  'maxPeak',
  'rms',
  'maxRms',
  'terminalSampleAbs',
  'clippedSamples',
  'nonFiniteSamples',
  'messageKind',
  'messageIndex',
  'outputWritten',
  'resumeWritten',
  'outcome',
  'toolCycleLatencyMs',
  'responseAStartedToToolCallMs',
  'responseBLatencyMs',
  'responseBFirstAudioMs',
  'responseBTotalMs',
  'rejectedFieldCount',
  'recoveryStepCount',
  'stepCount',
  'drainTimedOut',
  'attempt',
  'retrying',
  'timeoutMs',
  'remainingMs',
  'sessionId',
  'eventType',
  'requiresAck',
  'endAfterPlayback',
  'finishingCurrentUserTurn',
  'closeGraceMs',
  'deliverySemantics',
] as const;

export type RealtimeTraceField = typeof SAFE_TRACE_FIELD_KEYS[number];
export type RealtimeTraceScalar = string | number | boolean | null | undefined;
export type RealtimeTraceFields = Partial<Record<RealtimeTraceField, RealtimeTraceScalar>>;

export function pcm16Rms(audio: Uint8Array): number {
  const samples = Math.floor(audio.byteLength / 2);
  if (samples === 0) return 0;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let power = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = view.getInt16(index * 2, true) / 32768;
    power += value * value;
  }
  return Math.sqrt(power / samples);
}

const SAFE_TRACE_FIELDS: ReadonlySet<string> = new Set(SAFE_TRACE_FIELD_KEYS);

const TRACE_RETENTION_COUNT = 30;

export interface RealtimeTraceWriter {
  readonly filePath: string;
  record(event: string, fields?: Record<string, unknown>): void;
  flush(): Promise<void>;
}

export type RealtimeTraceStage = 'speech_stopped' | 'user_final' | 'assistant_started' | 'first_audio';

export interface RealtimeTraceStageTracker {
  mark(stage: RealtimeTraceStage, fields?: RealtimeTraceFields): RealtimeTraceFields;
}

interface RealtimeTraceTurn {
  id: number;
  speechStoppedAt?: number;
  userFinalAt?: number;
  assistantStartedAt?: number;
  firstAudioAt?: number;
  responseId?: string;
}

const TRACE_STAGE_POINTS: Record<RealtimeTraceStage, string> = {
  speech_stopped: 'A',
  user_final: 'B',
  assistant_started: 'C',
  first_audio: 'D',
};

function roundedMilliseconds(value: number): number {
  return Number(Math.max(0, value).toFixed(2));
}

function elapsedSince(startedAt: number | undefined, endedAt: number): number | undefined {
  return startedAt === undefined ? undefined : roundedMilliseconds(endedAt - startedAt);
}

/**
 * Annotates the existing provider/browser trace rows with one A-D turn timeline.
 * It deliberately returns fields instead of writing an event so callers can keep
 * the existing receipt/chunk markers and avoid duplicate instrumentation.
 */
export function createRealtimeTraceStageTracker(options: {
  now?: () => number;
} = {}): RealtimeTraceStageTracker {
  const now = options.now ?? (() => performance.now());
  let nextTurnId = 0;
  let pendingSpeechTurn: RealtimeTraceTurn | undefined;
  let latestUserTurn: RealtimeTraceTurn | undefined;
  let latestAssistantTurn: RealtimeTraceTurn | undefined;
  const responseTurns = new Map<string, RealtimeTraceTurn>();

  const createTurn = (): RealtimeTraceTurn => ({ id: ++nextTurnId });

  const stageFields = (
    stage: RealtimeTraceStage,
    turn: RealtimeTraceTurn,
    fields: RealtimeTraceFields,
  ): RealtimeTraceFields => ({
    ...fields,
    tracePoint: TRACE_STAGE_POINTS[stage],
    stage,
    turnId: turn.id,
  });

  const mark = (stage: RealtimeTraceStage, fields: RealtimeTraceFields = {}): RealtimeTraceFields => {
    const at = now();
    const responseId = typeof fields.responseId === 'string' && fields.responseId.trim()
      ? fields.responseId
      : undefined;

    if (stage === 'speech_stopped') {
      if (pendingSpeechTurn?.speechStoppedAt !== undefined && pendingSpeechTurn.userFinalAt === undefined) {
        return { ...fields };
      }
      const turn = createTurn();
      turn.speechStoppedAt = at;
      pendingSpeechTurn = turn;
      latestUserTurn = turn;
      return stageFields(stage, turn, fields);
    }

    if (stage === 'user_final') {
      const turn = pendingSpeechTurn
        ?? (latestUserTurn?.speechStoppedAt !== undefined && latestUserTurn.userFinalAt === undefined
          ? latestUserTurn
          : undefined);
      if (!turn) {
        if (latestUserTurn?.userFinalAt !== undefined) return { ...fields };
        const created = createTurn();
        created.userFinalAt = at;
        latestUserTurn = created;
        return stageFields(stage, created, {
          ...fields,
          ...(elapsedSince(created.speechStoppedAt, at) === undefined
            ? {}
            : { speechStoppedToUserFinalMs: elapsedSince(created.speechStoppedAt, at) }),
        });
      }
      turn.userFinalAt = at;
      pendingSpeechTurn = undefined;
      latestUserTurn = turn;
      const speechStoppedToUserFinalMs = elapsedSince(turn.speechStoppedAt, at);
      return stageFields(stage, turn, {
        ...fields,
        ...(speechStoppedToUserFinalMs === undefined ? {} : { speechStoppedToUserFinalMs }),
      });
    }

    if (stage === 'assistant_started') {
      if (responseId && responseTurns.has(responseId)) return { ...fields };
      if (!responseId && latestAssistantTurn?.assistantStartedAt !== undefined) return { ...fields };
      const turn = latestUserTurn?.userFinalAt !== undefined && latestUserTurn.assistantStartedAt === undefined
        ? latestUserTurn
        : createTurn();
      turn.assistantStartedAt = at;
      turn.responseId = responseId;
      if (responseId) responseTurns.set(responseId, turn);
      latestAssistantTurn = turn;
      const userFinalToAssistantStartedMs = elapsedSince(turn.userFinalAt, at);
      return stageFields(stage, turn, {
        ...fields,
        ...(userFinalToAssistantStartedMs === undefined ? {} : { userFinalToAssistantStartedMs }),
      });
    }

    const turn = (responseId ? responseTurns.get(responseId) : undefined)
      ?? (latestAssistantTurn && (!responseId || latestAssistantTurn.responseId === responseId)
        ? latestAssistantTurn
        : undefined)
      ?? createTurn();
    if (turn.firstAudioAt !== undefined) return { ...fields };
    turn.firstAudioAt = at;
    if (responseId && !responseTurns.has(responseId)) responseTurns.set(responseId, turn);
    latestAssistantTurn = turn;
    const speechStoppedToUserFinalMs = turn.userFinalAt === undefined
      ? undefined
      : elapsedSince(turn.speechStoppedAt, turn.userFinalAt);
    const userFinalToAssistantStartedMs = turn.assistantStartedAt === undefined
      ? undefined
      : elapsedSince(turn.userFinalAt, turn.assistantStartedAt);
    const assistantStartedToFirstAudioMs = elapsedSince(turn.assistantStartedAt, at);
    return stageFields(stage, turn, {
      ...fields,
      ...(speechStoppedToUserFinalMs === undefined ? {} : { speechStoppedToUserFinalMs }),
      ...(userFinalToAssistantStartedMs === undefined ? {} : { userFinalToAssistantStartedMs }),
      ...(assistantStartedToFirstAudioMs === undefined ? {} : { assistantStartedToFirstAudioMs }),
    });
  };

  return { mark };
}

function cleanFields(fields: Record<string, unknown>): {
  values: Record<string, string | number | boolean | null>;
  rejectedFieldCount: number;
} {
  const cleaned: Record<string, string | number | boolean | null> = {};
  let rejectedFieldCount = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_TRACE_FIELDS.has(key)) {
      rejectedFieldCount += 1;
      continue;
    }
    if (typeof value === 'string') {
      cleaned[key] = value.slice(0, 100);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      cleaned[key] = Number(value.toFixed(2));
    } else if (typeof value === 'boolean' || value === null) {
      cleaned[key] = value;
    }
  }
  return { values: cleaned, rejectedFieldCount };
}

async function prepareTraceDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = await readdir(directory, { withFileTypes: true });
  const traceFiles = await Promise.all(files
    .filter((file) => file.isFile() && /^[0-9a-f-]{36}\.jsonl$/i.test(file.name))
    .map(async (file) => {
      const filePath = path.join(directory, file.name);
      try {
        return { filePath, modifiedAt: (await stat(filePath)).mtimeMs };
      } catch {
        return null;
      }
    }));
  const existing = traceFiles.filter((file): file is NonNullable<typeof file> => file !== null)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const expired of existing.slice(TRACE_RETENTION_COUNT - 1)) {
    try { await unlink(expired.filePath); } catch { /* concurrent cleanup is harmless */ }
  }
}

export function createRealtimeTraceWriter(options: {
  directory: string;
  sessionId: string;
  provider: string;
}): RealtimeTraceWriter {
  const directory = path.resolve(options.directory);
  const filePath = path.join(directory, `${options.sessionId}.jsonl`);
  const sessionStartedAt = performance.now();
  let writeTail = Promise.resolve();
  let directoryReady: Promise<void> | undefined;
  let writeFailureReported = false;

  const record = (event: string, fields: Record<string, unknown> = {}): void => {
    const cleaned = cleanFields(fields);
    const entry = {
      at: new Date().toISOString(),
      elapsed_ms: Number((performance.now() - sessionStartedAt).toFixed(2)),
      session_id: options.sessionId,
      provider: options.provider,
      event: event.slice(0, 100),
      ...cleaned.values,
      ...(cleaned.rejectedFieldCount > 0 ? { rejectedFieldCount: cleaned.rejectedFieldCount } : {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    directoryReady ??= prepareTraceDirectory(directory);
    writeTail = writeTail.then(async () => {
      await directoryReady;
      await appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
    }).catch((error: unknown) => {
      if (writeFailureReported) return;
      writeFailureReported = true;
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? 'write_error')
        : 'write_error';
      console.error(`[realtime-trace] write failed (${code})`);
      writeDiagnosticLog('server', 'error', 'Realtime trace write failed.', { code });
    });
  };

  return { filePath, record, flush: () => writeTail };
}
