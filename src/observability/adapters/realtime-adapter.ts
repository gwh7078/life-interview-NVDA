import {
  createObservationContext,
  createObservationEvent,
  type ObservationContext,
  type ObservationEvent,
  type ObservationStatus,
} from '../observation-event.js';

type SafeFields = Record<string, unknown>;

const LABEL = /^[\w .:/-]{1,80}$/u;
const numericMetrics = [
  'latencyMs', 'slowRecallLatencyMs', 'toolResultLatencyMs', 'totalElapsedMs',
  'factCount', 'attempt', 'attemptCount', 'repairCount', 'toolCallCount', 'scriptCallCount',
  'candidateCount', 'retrievalEvidenceCount', 'retrievalLatencyMs', 'slowAgentLatencyMs',
  'promptTokens', 'completionTokens', 'totalTokens', 'selectedEvidenceCount',
  'toolToFirstAudioMs', 'responseBFirstAudioMs', 'responseBLatencyMs',
  'toolResultWriteLatencyMs', 'toolCycleLatencyMs',
  'silenceObservedMs', 'silenceThresholdMs',
] as const;

const SAFE_FALLBACK_TYPES = new Set(['direct_retrieval']);
const SAFE_SKIP_REASONS = new Set(['no_evidence', 'agent_disabled', 'agent_unavailable', 'agent_not_configured']);
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function normalizeAgentSkipReasonForObservation(
  reason: string | undefined,
  explicitlyDisabled: boolean,
): string | undefined {
  return reason === 'agent_unavailable' && explicitlyDisabled ? 'agent_disabled' : reason;
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return LABEL.test(trimmed) ? trimmed : undefined;
}

function numberField(fields: SafeFields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizedStatus(value: unknown): ObservationStatus {
  if (value === 'completed' || value === 'success' || value === 'succeeded') return 'success';
  if (value === 'failed' || value === 'timeout' || value === 'provider_disconnected' || value === 'write_failed') return 'error';
  if (value === 'stale' || value === 'aborted' || value === 'session_ended' || value === 'skipped') return 'warning';
  return 'running';
}

function slowPathMapping(event: string, fields: SafeFields): Mapping | undefined {
  const match = /^realtime\.slow_path\.(retrieval|slow_agent|context_hint)\.(started|finished|failed|skipped|ready)$/u.exec(event);
  if (!match) return undefined;
  const [, stage, suffix] = match;
  const status = fields.status === 'finished' ? 'completed' : fields.status ?? suffix;

  if (stage === 'retrieval') {
    if (status === 'started') return undefined;
    if (status === 'completed') return { category: 'retriever', eventType: 'retriever.completed', status: 'success', title: 'RETRIEVER COMPLETE', component: 'nemo-retriever' };
    if (status === 'failed') return { category: 'retriever', eventType: 'retriever.failed', status: 'error', title: 'RETRIEVER FAILED', component: 'nemo-retriever' };
    if (status === 'skipped') return { category: 'retriever', eventType: 'retriever.skipped', status: 'skip', title: 'RETRIEVER SKIPPED', component: 'nemo-retriever' };
    return undefined;
  }

  if (stage === 'slow_agent') {
    if (status === 'started') return undefined;
    if (status === 'completed') return { category: 'agent', eventType: 'agent.metrics', status: 'success', title: 'CONTEXT HINT AGENT METRICS', component: 'realtime-context-agent' };
    if (status === 'skipped') return { category: 'agent', eventType: 'agent.skipped', status: 'skip', title: 'CONTEXT HINT AGENT SKIPPED', component: 'realtime-context-agent' };
    return undefined;
  }

  if (status === 'ready') return { category: 'evidence', eventType: 'evidence.ready', status: 'success', title: 'CONTEXT HINT READY', component: 'realtime-context' };
  return undefined;
}

interface Mapping {
  category: ObservationEvent['category'];
  eventType: string;
  status: ObservationStatus;
  title: string;
  component: string;
}

function mapTrace(event: string, fields: SafeFields): Mapping | undefined {
  const slowPath = slowPathMapping(event, fields);
  if (slowPath) return slowPath;
  if (event === 'session.started') return { category: 'runtime', eventType: 'runtime.started', status: 'start', title: 'Session started', component: 'interview-runtime' };
  if (event === 'provider.session_ready') return { category: 'realtime', eventType: 'realtime.connected', status: 'success', title: 'CONNECTED', component: 'realtime-provider' };
  if (event === 'provider.turn_detection_requested') return { category: 'realtime', eventType: 'realtime.turn_detection_requested', status: 'start', title: 'LOCAL TURN CONTROL', component: 'realtime-provider' };
  if (event === 'provider.turn_detection_acknowledged') return { category: 'realtime', eventType: 'realtime.turn_detection_acknowledged', status: fields.turnDetectionMode === 'manual' ? 'success' : 'warning', title: fields.turnDetectionMode === 'manual' ? 'MANUAL TURN CONFIRMED' : 'TURN MODE UNKNOWN', component: 'realtime-provider' };
  if (event === 'client.local_vad_silence_started') return { category: 'realtime', eventType: 'realtime.local_silence_started', status: 'running', title: 'LOCAL VAD SILENCE', component: 'local-silero-vad' };
  if (event === 'client.local_vad_speech_resumed') return { category: 'realtime', eventType: 'realtime.user_speaking', status: 'running', title: 'USER SPEAKING', component: 'local-silero-vad' };
  if (event === 'client.local_vad_commit_triggered') return { category: 'realtime', eventType: 'realtime.turn_committed', status: 'success', title: 'USER TURN COMMITTED', component: 'local-silero-vad' };
  if (event === 'provider.speech_started') return { category: 'realtime', eventType: 'realtime.user_speaking', status: 'running', title: 'USER SPEAKING', component: 'realtime-provider' };
  if (event === 'provider.speech_stopped_received' || event === 'provider.speech_stopped_forwarded') return { category: 'realtime', eventType: 'realtime.listening', status: 'running', title: 'LISTENING', component: 'realtime-provider' };
  if (event === 'provider.response_created') return { category: 'realtime', eventType: 'realtime.model_thinking', status: 'running', title: 'AI THINKING', component: 'realtime-provider' };
  if (event === 'provider.audio_started' || event === 'provider.first_audio_received') return { category: 'realtime', eventType: 'realtime.responding', status: 'running', title: 'AI SPEAKING', component: 'realtime-provider' };
  if (event === 'provider.response_done' || event === 'client.playback_response_drained') return { category: 'realtime', eventType: 'realtime.listening', status: 'success', title: 'RESPONSE COMPLETE', component: 'realtime-provider' };
  if (event === 'client.playback_interruption') return { category: 'realtime', eventType: 'realtime.interrupted', status: 'warning', title: 'INTERRUPTED', component: 'realtime-client' };
  if (event === 'realtime.tool_call_requested') return { category: 'tool', eventType: 'tool.started', status: 'running', title: 'TOOL CALL', component: 'realtime-tool' };
  if (event === 'realtime.tool_call_rejected' || event === 'realtime.tool_call_ignored' || event === 'realtime.tool_result_failed') return { category: 'tool', eventType: 'tool.failed', status: 'error', title: 'TOOL FAILED', component: 'realtime-tool' };
  if (event === 'realtime.tool_cycle_started') return { category: 'realtime', eventType: 'realtime.hold', status: 'running', title: 'HOLD', component: 'realtime-tool-cycle' };
  if (event === 'realtime.tool_cycle_message_write' && fields.messageKind === 'resume') return { category: 'realtime', eventType: 'realtime.resume', status: fields.sent === true ? 'success' : 'error', title: 'RESUME', component: 'realtime-tool-cycle' };
  if (event === 'realtime.tool_cycle_response_started') return { category: 'realtime', eventType: 'realtime.responding', status: 'success', title: 'AI RESUMED', component: 'realtime-tool-cycle' };
  if (event === 'realtime.tool_cycle_response_first_audio') return { category: 'realtime', eventType: 'realtime.first_audio', status: 'success', title: 'FIRST AUDIO', component: 'realtime-tool-cycle' };
  if (event === 'realtime.tool_result_sent') return { category: 'tool', eventType: 'tool.completed', status: fields.sent === false ? 'error' : 'success', title: 'TOOL RESULT', component: 'realtime-tool' };
  if (event === 'realtime.tool_cycle_terminal') {
    const outcome = fields.outcome;
    return { category: 'tool', eventType: outcome === 'completed' ? 'tool.completed' : 'tool.failed', status: normalizedStatus(outcome), title: 'TOOL CYCLE', component: 'realtime-tool' };
  }
  // Keep realtime.recall_started and retrieval.finished as the Retriever lifecycle;
  // suppress the corresponding tracker and stage-start aliases.
  if (event === 'realtime.tool_cycle_recall_finished' || event === 'realtime.tool_cycle_recall_started') return undefined;
  if (event === 'realtime.recall_started') return { category: 'retriever', eventType: 'retriever.started', status: 'start', title: 'NeMo RETRIEVER', component: 'nemo-retriever' };
  if (event === 'realtime.slow_recall_finished') {
    const sourceStatus = fields.status;
    const status = sourceStatus === 'completed' ? 'success'
      : sourceStatus === 'timeout' ? 'warning'
        : sourceStatus === 'failed' ? 'error'
          : sourceStatus === 'aborted' || sourceStatus === 'stale' ? 'warning' : normalizedStatus(sourceStatus);
    const result = typeof sourceStatus === 'string' && ['completed', 'timeout', 'failed', 'aborted', 'stale'].includes(sourceStatus)
      ? sourceStatus : 'unknown';
    return { category: 'runtime', eventType: `realtime.slow_path.result.${result}`, status, title: result === 'completed' ? 'SLOW PATH RESULT' : `SLOW PATH ${result.toUpperCase()}`, component: 'realtime-slow-path' };
  }
  if (event === 'retriever.index_scheduled') return { category: 'retriever', eventType: 'retriever.started', status: 'start', title: 'RETRIEVER INDEX', component: 'nemo-retriever' };
  if (event === 'retriever.index_finished') {
    if (fields.status === 'indexed' || fields.status === 'completed' || fields.status === 'success') {
      return { category: 'retriever', eventType: 'retriever.completed', status: 'success', title: 'INDEX COMPLETE', component: 'nemo-retriever' };
    }
    if (fields.status === 'failed') return { category: 'retriever', eventType: 'retriever.failed', status: 'error', title: 'INDEX FAILED', component: 'nemo-retriever' };
    if (fields.status === 'skipped') return { category: 'retriever', eventType: 'retriever.skipped', status: 'skip', title: 'INDEX SKIPPED', component: 'nemo-retriever' };
    return { category: 'retriever', eventType: 'retriever.running', status: 'running', title: 'INDEX IN PROGRESS', component: 'nemo-retriever' };
  }
  if (event === 'retriever.index_failed') return { category: 'retriever', eventType: 'retriever.failed', status: 'error', title: 'INDEX FAILED', component: 'nemo-retriever' };
  if (event === 'retriever.index_skipped') return { category: 'retriever', eventType: 'retriever.skipped', status: 'skip', title: 'INDEX SKIPPED', component: 'nemo-retriever' };
  if (event === 'transcript.write_queued') return { category: 'persistence', eventType: 'database.write.started', status: 'start', title: 'SAVE TRANSCRIPT', component: 'sqlite' };
  if (event === 'transcript.write_succeeded') return { category: 'persistence', eventType: 'database.write.completed', status: 'success', title: 'TRANSCRIPT SAVED', component: 'sqlite' };
  if (event === 'transcript.write_failed') return { category: 'persistence', eventType: 'database.write.failed', status: 'error', title: 'SAVE FAILED', component: 'sqlite' };
  if (event === 'session.ending' || event === 'session.ended') return { category: 'runtime', eventType: 'runtime.ended', status: 'success', title: 'SESSION ENDED', component: 'interview-runtime' };
  return undefined;
}

export function adaptRealtimeTrace(input: {
  context?: ObservationContext;
  sessionId: string;
  storyId?: string;
  provider: string;
  environment?: string;
  event: string;
  fields?: SafeFields;
  timestamp?: string;
}): ObservationEvent | undefined {
  const event = input.event;
  const fields = input.fields ?? {};
  const mapping = mapTrace(input.event, fields);
  if (!mapping) return undefined;
  const context = input.context ?? createObservationContext({ sessionId: input.sessionId, storyId: input.storyId });
  const toolRunId = safeLabel(fields.toolRunId);
  const runId = safeLabel(fields.runId);
  const operationSpan = mapping.eventType === 'agent.metrics' && runId
    ? `agent:${runId}`
    : toolRunId ?? safeLabel(fields.responseId) ?? runId;
  const metrics: Record<string, number | string | boolean> = {};
  for (const key of numericMetrics) {
    const value = numberField(fields, key);
    if (value !== undefined) metrics[key] = value;
  }
  if (typeof fields.sent === 'boolean') metrics.sent = fields.sent;
  if (typeof fields.outcome === 'string') metrics.outcome = safeLabel(fields.outcome) ?? 'unknown';
  if (typeof fields.fallbackUsed === 'boolean') metrics.fallbackUsed = fields.fallbackUsed;
  if (typeof fields.fallbackType === 'string' && SAFE_FALLBACK_TYPES.has(fields.fallbackType)) metrics.fallbackType = fields.fallbackType;
  if (typeof fields.slowAgentSkipReason === 'string' && SAFE_SKIP_REASONS.has(fields.slowAgentSkipReason)) metrics.skipReason = fields.slowAgentSkipReason;
  if (typeof fields.errorCode === 'string' && SAFE_ERROR_CODE.test(fields.errorCode)) metrics.errorCode = fields.errorCode;
  if (safeLabel(fields.slowAgentModel)) metrics.model = safeLabel(fields.slowAgentModel)!;
  if (safeLabel(fields.skill)) metrics.skill = safeLabel(fields.skill)!;
  const responseStartLatency = numberField(fields, 'responseBLatencyMs');
  if (responseStartLatency !== undefined) metrics.resumeLatencyMs = responseStartLatency;
  const firstAudioLatency = numberField(fields, 'toolToFirstAudioMs') ?? numberField(fields, 'responseBFirstAudioMs');
  if (firstAudioLatency !== undefined) metrics.firstAudioLatencyMs = firstAudioLatency;
  const evidenceCount = numberField(fields, 'retrievalEvidenceCount') ?? numberField(fields, 'factCount');
  if (evidenceCount !== undefined) metrics.evidenceCount = evidenceCount;
  if (numberField(fields, 'candidateCount') !== undefined) metrics.candidateCount = numberField(fields, 'candidateCount')!;

  const count = numberField(fields, 'factCount');
  const latency = event === 'realtime.tool_cycle_response_started'
    ? responseStartLatency
    : event === 'realtime.tool_cycle_response_first_audio'
      ? numberField(fields, 'toolToFirstAudioMs') ?? numberField(fields, 'responseBFirstAudioMs')
        : event === 'realtime.tool_result_sent'
          ? numberField(fields, 'toolResultLatencyMs') ?? numberField(fields, 'toolResultWriteLatencyMs')
          : event === 'realtime.tool_cycle_message_write' && fields.messageKind === 'resume'
            ? undefined
            : event === 'realtime.tool_cycle_terminal'
              ? numberField(fields, 'toolCycleLatencyMs') ?? numberField(fields, 'slowRecallLatencyMs')
              : numberField(fields, 'slowAgentLatencyMs') ?? numberField(fields, 'slowRecallLatencyMs') ?? numberField(fields, 'latencyMs');
  const summary = mapping.category === 'retriever'
    ? [count === undefined ? undefined : `${count} results`, latency === undefined ? undefined : `${Math.round(latency)} ms`].filter(Boolean).join(' · ') || undefined
    : mapping.category === 'tool' && safeLabel(fields.name)
      ? safeLabel(fields.name)
      : undefined;

  return createObservationEvent(context, {
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    ...(operationSpan ? {
      spanId: operationSpan,
      parentSpanId: mapping.eventType === 'agent.metrics' ? toolRunId ?? context.rootSpanId : context.rootSpanId,
    } : { spanId: context.rootSpanId }),
    category: mapping.category,
    eventType: mapping.eventType,
    status: mapping.status,
    component: mapping.component,
    title: mapping.title,
    ...(summary ? { summary } : {}),
    ...(latency === undefined ? {} : { durationMs: latency }),
    ...(Object.keys(metrics).length ? { metrics } : {}),
    metadata: {
      provider: input.provider,
      ...(input.environment ? { environment: input.environment } : {}),
      ...(safeLabel(fields.name) ? { tool: safeLabel(fields.name) } : {}),
      ...(safeLabel(fields.slowAgentModel) ? { model: safeLabel(fields.slowAgentModel) } : {}),
      ...(safeLabel(fields.skill) ? { skill: safeLabel(fields.skill) } : {}),
    },
  });
}
