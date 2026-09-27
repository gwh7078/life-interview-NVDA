import {
  createObservationContext,
  createObservationEvent,
  type ObservationEvent,
  type ObservationStatus,
} from '../observation-event.js';
import type { AgentTaskTraceContext } from '../../agent-tasks/contracts/common.js';

export interface AgentObservationSource {
  runId: string;
  agentType: string;
  taskType: string;
  resourceType: string;
  resourceId: string;
  traceContext?: AgentTaskTraceContext;
  runtime: string;
  skill?: string | null;
  provider?: string | null;
  model?: string | null;
  attemptCount?: number;
  repairCount?: number;
  toolCallCount?: number;
  scriptCallCount?: number;
}

export function adaptAgentRun(source: AgentObservationSource, input: {
  eventType: 'agent.started' | 'agent.retry' | 'agent.completed' | 'agent.failed';
  status: ObservationStatus;
  durationMs?: number;
  timestamp?: string;
  errorCode?: string;
}): ObservationEvent[] {
  const sessionId = source.traceContext?.sessionId
    ?? (source.resourceType === 'interview_session' ? source.resourceId : undefined);
  const storyId = source.traceContext?.storyId
    ?? (source.resourceType === 'story' ? source.resourceId : undefined);
  const context = createObservationContext({
    traceId: source.traceContext?.traceId ?? sessionId ?? source.runId,
    rootSpanId: source.traceContext?.parentSpanId ?? (sessionId ? `session:${sessionId}` : `agent:${source.runId}`),
    ...(sessionId ? { sessionId } : {}),
    ...(storyId ? { storyId } : {}),
  });
  const base = {
    spanId: `agent:${source.runId}`,
    ...(sessionId ? { parentSpanId: source.traceContext?.parentSpanId ?? context.rootSpanId } : {}),
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    status: input.status,
    component: source.taskType === 'interview.context_hint' ? 'realtime-context-agent' : source.runtime,
    summary: source.taskType,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    metrics: {
      ...(source.attemptCount === undefined ? {} : { attemptCount: source.attemptCount }),
      ...(source.repairCount === undefined ? {} : { repairCount: source.repairCount }),
      ...(source.toolCallCount === undefined ? {} : { toolCallCount: source.toolCallCount }),
      ...(source.scriptCallCount === undefined ? {} : { scriptCallCount: source.scriptCallCount }),
      ...(source.model ? { model: source.model } : {}),
      ...(source.skill ? { skill: source.skill } : {}),
      ...(input.errorCode && /^[A-Z][A-Z0-9_]{0,63}$/u.test(input.errorCode) ? { errorCode: input.errorCode } : {}),
    },
    metadata: {
      agent: source.agentType,
      runtime: source.runtime,
      ...(source.skill ? { skill: source.skill } : {}),
      ...(source.provider ? { provider: source.provider } : {}),
      ...(source.model ? { model: source.model } : {}),
    },
  } as const;
  const events: ObservationEvent[] = [createObservationEvent(context, {
    ...base,
    spanId: `agent:${source.runId}`,
    category: 'agent',
    eventType: input.eventType,
    title: source.agentType,
  })];
  if (source.skill && input.eventType !== 'agent.retry') {
    const skillStatus = input.eventType === 'agent.started' ? 'start'
      : input.eventType === 'agent.failed' ? 'error'
        : input.eventType === 'agent.completed' ? 'success' : input.status;
    const skillType = input.eventType === 'agent.started' ? 'skill.started'
      : input.eventType === 'agent.failed' ? 'skill.failed'
        : input.eventType === 'agent.completed' ? 'skill.completed' : 'skill.started';
    events.push(createObservationEvent(context, {
      ...base,
      spanId: `skill:${source.runId}`,
      parentSpanId: `agent:${source.runId}`,
      category: 'skill',
      eventType: skillType,
      status: skillStatus,
      title: source.skill,
    }));
  }
  return events;
}
