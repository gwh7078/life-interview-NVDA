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
] as const;

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

interface Mapping {
  category: ObservationEvent['category'];
  eventType: string;
  status: ObservationStatus;
  title: string;
  component: string;
}

function mapTrace(event: string, fields: SafeFields): Mapping | undefined {
  if (event === 'session.started') return { category: 'runtime', eventType: 'runtime.started', status: 'start', title: 'Session started', component: 'interview-runtime' };
  if (event === 'provider.session_ready') return { category: 'realtime', eventType: 'realtime.connected', status: 'success', title: 'CONNECTED', component: 'realtime-provider' };
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
  if (event === 'realtime.tool_result_sent') return { category: 'tool', eventType: 'tool.completed', status: fields.sent === false ? 'error' : 'success', title: 'TOOL RESULT', component: 'realtime-tool' };
  if (event === 'realtime.tool_cycle_terminal') {
    const outcome = fields.outcome;
    return { category: 'tool', eventType: outcome === 'completed' ? 'tool.completed' : 'tool.failed', status: normalizedStatus(outcome), title: 'TOOL CYCLE', component: 'realtime-tool' };
  }
  if (event === 'realtime.recall_started' || event === 'realtime.tool_cycle_recall_started') return { category: 'retriever', eventType: 'retriever.started', status: 'start', title: 'NeMo RETRIEVER', component: 'nemo-retriever' };
  if (event === 'realtime.slow_recall_finished' || event === 'realtime.tool_cycle_recall_finished') {
    const status = normalizedStatus(fields.status);
    const eventType = status === 'error' ? 'retriever.failed'
      : status === 'success' ? 'retriever.completed'
        : status === 'warning' ? 'retriever.completed' : 'retriever.running';
    return { category: 'retriever', eventType, status, title: 'RETRIEVER RESULT', component: 'nemo-retriever' };
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
  const fields = input.fields ?? {};
  const mapping = mapTrace(input.event, fields);
  if (!mapping) return undefined;
  const context = input.context ?? createObservationContext({ sessionId: input.sessionId, storyId: input.storyId });
  const operationSpan = safeLabel(fields.toolRunId) ?? safeLabel(fields.responseId) ?? safeLabel(fields.runId);
  const metrics: Record<string, number | string | boolean> = {};
  for (const key of numericMetrics) {
    const value = numberField(fields, key);
    if (value !== undefined) metrics[key] = value;
  }
  if (typeof fields.sent === 'boolean') metrics.sent = fields.sent;
  if (typeof fields.outcome === 'string') metrics.outcome = safeLabel(fields.outcome) ?? 'unknown';

  const count = numberField(fields, 'factCount');
  const latency = numberField(fields, 'slowRecallLatencyMs') ?? numberField(fields, 'latencyMs');
  const summary = mapping.category === 'retriever'
    ? [count === undefined ? undefined : `${count} results`, latency === undefined ? undefined : `${Math.round(latency)} ms`].filter(Boolean).join(' · ') || undefined
    : mapping.category === 'tool' && safeLabel(fields.name)
      ? safeLabel(fields.name)
      : undefined;

  return createObservationEvent(context, {
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    ...(operationSpan ? { spanId: operationSpan, parentSpanId: context.rootSpanId } : { spanId: context.rootSpanId }),
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
    },
  });
}
