import { createObservationContext, createObservationEvent, type ObservationEvent } from '../observation-event.js';
import { adaptAgentRun, type AgentObservationSource } from './agent-adapter.js';

export interface NatAgentTrace extends AgentObservationSource {
  status: string;
  latencyMs?: number | null;
  errorCode?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

function validatorOutcome(validation: {
  contract_valid?: boolean;
  backend_validation?: string;
  semantic_valid?: boolean;
} | undefined, evaluationStatus: 'succeeded' | 'failed'): 'passed' | 'failed' | undefined {
  if (!validation) return undefined;
  if (evaluationStatus === 'failed' || validation.contract_valid === false || validation.backend_validation === 'failed'
    || validation.backend_validation === 'not_run' || validation.semantic_valid === false) return 'failed';
  if (validation.contract_valid === true && validation.semantic_valid === true
    && validation.backend_validation === 'passed') return 'passed';
  return undefined;
}

export function adaptNatEvaluation(input: {
  trace?: NatAgentTrace;
  caseId?: string | null;
  status: 'succeeded' | 'failed';
  validation?: { contract_valid?: boolean; backend_validation?: string; semantic_valid?: boolean };
  latencyMs?: number;
  timestamp?: string;
}): ObservationEvent[] {
  const trace = input.trace;
  const sessionId = trace?.resourceType === 'interview_session' ? trace.resourceId : undefined;
  const storyId = trace?.resourceType === 'story' ? trace.resourceId : undefined;
  const traceId = sessionId ?? trace?.runId ?? `nat:${input.caseId ?? 'evaluation'}`;
  const agentSpanId = trace ? `agent:${trace.runId}` : undefined;
  const context = createObservationContext({
    traceId,
    rootSpanId: sessionId ? `session:${sessionId}` : trace ? agentSpanId : `nat:${traceId}`,
    ...(sessionId ? { sessionId } : {}),
    ...(storyId ? { storyId } : {}),
  });
  const success = input.status === 'succeeded';
  const durationMs = trace?.latencyMs ?? input.latencyMs;
  if (trace) {
    const runEvents = [
      ...(trace.startedAt ? adaptAgentRun(trace, { eventType: 'agent.started', status: 'running', timestamp: trace.startedAt }) : []),
      ...adaptAgentRun(trace, {
        eventType: success ? 'agent.completed' : 'agent.failed',
        status: success ? 'success' : 'error',
        ...(typeof durationMs === 'number' ? { durationMs } : {}),
        ...(trace.completedAt ? { timestamp: trace.completedAt } : input.timestamp ? { timestamp: input.timestamp } : {}),
      }),
    ];
    const result = validatorOutcome(input.validation, input.status);
    if (result === 'passed') {
      runEvents.push(createObservationEvent(context, {
        category: 'validator', eventType: 'validator.passed', status: 'success',
        component: 'NAT validator', title: 'VALIDATION PASSED', spanId: `validator:${traceId}`, parentSpanId: agentSpanId ?? context.rootSpanId,
        ...(input.timestamp ? { timestamp: input.timestamp } : {}),
      }));
    } else if (result === 'failed') {
      runEvents.push(createObservationEvent(context, {
        category: 'validator', eventType: 'validator.failed', status: 'error',
        component: 'NAT validator', title: 'VALIDATION FAILED', spanId: `validator:${traceId}`, parentSpanId: agentSpanId ?? context.rootSpanId,
        ...(input.timestamp ? { timestamp: input.timestamp } : {}),
      }));
    }
    return runEvents;
  }

  const base = {
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    component: 'NAT evaluation',
    summary: input.caseId ?? 'Agent evaluation',
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {}),
    metadata: { source: 'NAT evaluation' },
  } as const;
  const events: ObservationEvent[] = [createObservationEvent(context, {
    ...base,
    spanId: context.rootSpanId,
    category: 'agent',
    eventType: success ? 'agent.completed' : 'agent.failed',
    status: success ? 'success' : 'error',
    title: 'Agent evaluation',
  })];
  const result = validatorOutcome(input.validation, input.status);
  if (result === 'passed') {
    events.push(createObservationEvent(context, {
      ...base,
      spanId: `validator:${traceId}`,
      parentSpanId: context.rootSpanId,
      category: 'validator',
      eventType: 'validator.passed',
      status: 'success',
      title: 'VALIDATION PASSED',
    }));
  } else if (result === 'failed') {
    events.push(createObservationEvent(context, {
      ...base,
      spanId: `validator:${traceId}`,
      parentSpanId: context.rootSpanId,
      category: 'validator',
      eventType: 'validator.failed',
      status: 'error',
      title: 'VALIDATION FAILED',
    }));
  }
  return events;
}

export function adaptNatEvaluationSafely(input: Parameters<typeof adaptNatEvaluation>[0]): ObservationEvent[] {
  try { return adaptNatEvaluation(input); } catch { return []; }
}
