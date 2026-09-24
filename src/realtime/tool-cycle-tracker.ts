import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RealtimeTraceFields } from './trace.js';
import type { SlowRecallStatus } from './slow-coordinator.js';

export type RealtimeToolCycleOutcome =
  | 'completed'
  | 'timeout'
  | 'failed'
  | 'stale'
  | 'aborted'
  | 'session_ended'
  | 'provider_disconnected';

export type RealtimeToolMessageKind = 'output' | 'resume';

interface ToolCycle {
  toolRunId: string;
  callId: string;
  toolName: string;
  responseAId: string;
  startedAt: number;
  recallStatus?: SlowRecallStatus;
  provider?: string;
  expectedOutcome?: RealtimeToolCycleOutcome;
  recallLatencyMs?: number;
  slowPathMetrics?: RealtimeTraceFields;
  errorCode?: string;
  resumeRequestedAt?: number;
  responseBId?: string;
  responseBStartedAt?: number;
  responseBFirstAudioAt?: number;
  responseStartTimer?: NodeJS.Timeout;
}

export interface RealtimeToolCycleTracker {
  start(input: {
    callId: string;
    toolName: string;
    responseAId: string;
    provider?: string;
    turnId?: string;
    contextVersion?: number;
  }): string;
  markRecallStarted(callId: string): void;
  markRecallFinished(callId: string, input: {
    status: SlowRecallStatus;
    latencyMs: number;
    errorCode?: string;
    metrics?: RealtimeTraceFields;
  }): void;
  recordMessageWrite(callId: string, input: {
    kind: RealtimeToolMessageKind;
    messageIndex: number;
    sent: boolean;
  }): void;
  setExpectedOutcome(callId: string, outcome: RealtimeToolCycleOutcome, errorCode?: string): void;
  markAssistantResponseStarted(responseId: string): void;
  markFirstAudio(responseId: string): number | undefined;
  setMetrics(callId: string, metrics: RealtimeTraceFields): void;
  markAssistantResponseDone(responseId: string, status: string): void;
  finish(callId: string, outcome: RealtimeToolCycleOutcome, reason: string, errorCode?: string): void;
  finishAll(outcome: 'session_ended' | 'provider_disconnected', reason: string): void;
}

type RecordTrace = (event: string, fields?: RealtimeTraceFields) => void;

function roundMilliseconds(value: number): number {
  return Number(Math.max(0, value).toFixed(2));
}

export function createRealtimeToolCycleTracker(options: {
  record: RecordTrace;
  now?: () => number;
  responseStartTimeoutMs?: number;
}): RealtimeToolCycleTracker {
  const now = options.now ?? (() => performance.now());
  const responseStartTimeoutMs = options.responseStartTimeoutMs ?? 30_000;
  if (!Number.isInteger(responseStartTimeoutMs) || responseStartTimeoutMs <= 0) {
    throw new Error('Realtime tool response-start timeout must be a positive integer.');
  }
  const cyclesByCallId = new Map<string, ToolCycle>();
  const callsWaitingForResponse: string[] = [];
  const cyclesByResponseId = new Map<string, ToolCycle>();
  const responseStartedAt = new Map<string, number>();

  const cycleFields = (cycle: ToolCycle): RealtimeTraceFields => ({
    toolRunId: cycle.toolRunId,
    callId: cycle.callId,
    toolName: cycle.toolName,
    ...(cycle.provider ? { provider: cycle.provider } : {}),
  });

  const finish = (
    callId: string,
    outcome: RealtimeToolCycleOutcome,
    reason: string,
    errorCode?: string,
    responseBStatus?: string,
  ): void => {
    const cycle = cyclesByCallId.get(callId);
    if (!cycle) return;
    const endedAt = now();
    options.record('realtime.tool_cycle_terminal', {
      ...cycleFields(cycle),
      responseAId: cycle.responseAId,
      ...(cycle.responseBId ? { responseBId: cycle.responseBId } : {}),
      outcome,
      reason,
      ...(responseBStatus ? { status: responseBStatus } : {}),
      ...(cycle.recallStatus ? { recallStatus: cycle.recallStatus } : {}),
      ...(errorCode ?? cycle.errorCode ? { errorCode: errorCode ?? cycle.errorCode } : {}),
      toolCycleLatencyMs: roundMilliseconds(endedAt - cycle.startedAt),
      ...(cycle.recallLatencyMs === undefined ? {} : { slowRecallLatencyMs: cycle.recallLatencyMs }),
      ...(cycle.slowPathMetrics ?? {}),
      ...(cycle.resumeRequestedAt === undefined || cycle.responseBStartedAt === undefined
        ? {}
        : { responseBLatencyMs: roundMilliseconds(cycle.responseBStartedAt - cycle.resumeRequestedAt) }),
      ...(cycle.responseBFirstAudioAt === undefined || cycle.responseBStartedAt === undefined
        ? {}
        : { responseBFirstAudioMs: roundMilliseconds(cycle.responseBFirstAudioAt - cycle.responseBStartedAt) }),
      ...(cycle.responseBFirstAudioAt === undefined
        ? {}
        : { toolToFirstAudioMs: roundMilliseconds(cycle.responseBFirstAudioAt - cycle.startedAt) }),
      ...(cycle.responseBStartedAt === undefined
        ? {}
        : { responseBTotalMs: roundMilliseconds(endedAt - cycle.responseBStartedAt) }),
    });
    if (cycle.responseStartTimer) clearTimeout(cycle.responseStartTimer);
    cyclesByCallId.delete(callId);
    if (cycle.responseBId) cyclesByResponseId.delete(cycle.responseBId);
    for (let index = callsWaitingForResponse.length - 1; index >= 0; index -= 1) {
      if (callsWaitingForResponse[index] === callId) callsWaitingForResponse.splice(index, 1);
    }
  };

  return {
    start(input) {
      if (cyclesByCallId.has(input.callId)) {
        finish(input.callId, 'failed', 'duplicate_call_id');
      }
      const cycle: ToolCycle = {
        toolRunId: randomUUID(),
        callId: input.callId,
        toolName: input.toolName,
        responseAId: input.responseAId,
        ...(input.provider ? { provider: input.provider } : {}),
        startedAt: now(),
      };
      const responseAStartedAt = responseStartedAt.get(input.responseAId);
      cyclesByCallId.set(input.callId, cycle);
      options.record('realtime.tool_cycle_started', {
        ...cycleFields(cycle),
        responseAId: cycle.responseAId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.contextVersion === undefined ? {} : { contextVersion: input.contextVersion }),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(responseAStartedAt === undefined ? {} : {
          responseAStartedToToolCallMs: roundMilliseconds(cycle.startedAt - responseAStartedAt),
        }),
      });
      return cycle.toolRunId;
    },

    markRecallStarted(callId) {
      const cycle = cyclesByCallId.get(callId);
      if (!cycle) return;
      options.record('realtime.tool_cycle_recall_started', {
        ...cycleFields(cycle),
        responseAId: cycle.responseAId,
      });
    },

    markRecallFinished(callId, input) {
      const cycle = cyclesByCallId.get(callId);
      if (!cycle) return;
      cycle.recallStatus = input.status;
      cycle.recallLatencyMs = roundMilliseconds(input.latencyMs);
      cycle.errorCode = input.errorCode;
      cycle.slowPathMetrics = input.metrics;
      options.record('realtime.tool_cycle_recall_finished', {
        ...cycleFields(cycle),
        responseAId: cycle.responseAId,
        status: input.status,
        slowRecallLatencyMs: cycle.recallLatencyMs,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      });
    },

    recordMessageWrite(callId, input) {
      const cycle = cyclesByCallId.get(callId);
      if (!cycle) return;
      options.record('realtime.tool_cycle_message_write', {
        ...cycleFields(cycle),
        messageKind: input.kind,
        messageIndex: input.messageIndex,
        sent: input.sent,
        status: input.sent ? 'written_to_local_socket' : 'write_failed',
        deliverySemantics: 'local_socket_write_only',
      });
      if (input.kind === 'resume' && input.sent) {
        if (cycle.responseStartTimer) clearTimeout(cycle.responseStartTimer);
        cycle.resumeRequestedAt = now();
        callsWaitingForResponse.push(callId);
        cycle.responseStartTimer = setTimeout(() => {
          finish(callId, 'timeout', 'response_b_start_timeout');
        }, responseStartTimeoutMs);
      }
    },

    setExpectedOutcome(callId, outcome, errorCode) {
      const cycle = cyclesByCallId.get(callId);
      if (!cycle) return;
      cycle.expectedOutcome = outcome;
      if (errorCode) cycle.errorCode = errorCode;
    },

    markAssistantResponseStarted(responseId) {
      const at = now();
      responseStartedAt.set(responseId, at);
      if (responseStartedAt.size > 64) {
        const oldest = responseStartedAt.keys().next().value as string | undefined;
        if (oldest) responseStartedAt.delete(oldest);
      }
      while (callsWaitingForResponse.length > 0) {
        const callId = callsWaitingForResponse.shift();
        const cycle = callId ? cyclesByCallId.get(callId) : undefined;
        if (!cycle || cycle.responseAId === responseId || cycle.responseBId) continue;
        cycle.responseBId = responseId;
        cycle.responseBStartedAt = at;
        if (cycle.responseStartTimer) clearTimeout(cycle.responseStartTimer);
        cycle.responseStartTimer = undefined;
        cyclesByResponseId.set(responseId, cycle);
        options.record('realtime.tool_cycle_response_started', {
          ...cycleFields(cycle),
          responseAId: cycle.responseAId,
          responseId,
          ...(cycle.resumeRequestedAt === undefined ? {} : {
            responseBLatencyMs: roundMilliseconds(at - cycle.resumeRequestedAt),
          }),
        });
        break;
      }
    },

    markFirstAudio(responseId) {
      const cycle = cyclesByResponseId.get(responseId);
      if (!cycle || cycle.responseBFirstAudioAt !== undefined) return undefined;
      const at = now();
      cycle.responseBFirstAudioAt = at;
      const toolToFirstAudioMs = roundMilliseconds(at - cycle.startedAt);
      options.record('realtime.tool_cycle_response_first_audio', {
        ...cycleFields(cycle),
        responseId,
        toolToFirstAudioMs,
        ...(cycle.responseBStartedAt === undefined ? {} : {
          responseBFirstAudioMs: roundMilliseconds(at - cycle.responseBStartedAt),
        }),
      });
      return toolToFirstAudioMs;
    },

    setMetrics(callId, metrics) {
      const cycle = cyclesByCallId.get(callId);
      if (!cycle) return;
      cycle.slowPathMetrics = { ...cycle.slowPathMetrics, ...metrics };
    },

    markAssistantResponseDone(responseId, status) {
      const cycle = cyclesByResponseId.get(responseId);
      if (!cycle) return;
      const outcome = status === 'completed'
        ? cycle.expectedOutcome
          ?? (cycle.recallStatus === 'completed' || cycle.recallStatus === undefined
            ? 'completed'
            : cycle.recallStatus)
        : status === 'cancelled' ? 'aborted' : 'failed';
      finish(cycle.callId, outcome, `response_${status}`, undefined, status);
    },

    finish,

    finishAll(outcome, reason) {
      for (const callId of [...cyclesByCallId.keys()]) finish(callId, outcome, reason);
    },
  };
}
