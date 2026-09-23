import { randomUUID } from 'node:crypto';

export type ObservationCategory =
  | 'realtime' | 'agent' | 'skill' | 'tool' | 'retriever' | 'reranker'
  | 'evidence' | 'validator' | 'persistence' | 'runtime' | 'system';

export type ObservationStatus = 'start' | 'running' | 'success' | 'warning' | 'error' | 'skip';

export interface ObservationEvent {
  eventId: string;
  timestamp: string;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  sessionId?: string;
  storyId?: string;
  category: ObservationCategory;
  eventType: string;
  status: ObservationStatus;
  component: string;
  title: string;
  summary?: string;
  durationMs?: number;
  metrics?: Record<string, string | number | boolean>;
  metadata?: Record<string, unknown>;
}

export interface ObservationContext {
  traceId: string;
  rootSpanId: string;
  sessionId?: string;
  storyId?: string;
}

export function createObservationContext(input: {
  sessionId?: string;
  storyId?: string;
  traceId?: string;
  rootSpanId?: string;
} = {}): ObservationContext {
  return {
    traceId: input.traceId ?? input.sessionId ?? randomUUID(),
    rootSpanId: input.rootSpanId ?? randomUUID(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.storyId ? { storyId: input.storyId } : {}),
  };
}

export function createObservationEvent(
  context: ObservationContext,
  input: Omit<ObservationEvent, 'eventId' | 'timestamp' | 'traceId' | 'sessionId' | 'storyId'> & {
    eventId?: string;
    timestamp?: string;
    sessionId?: string;
    storyId?: string;
  },
): ObservationEvent {
  return {
    ...input,
    eventId: input.eventId ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    traceId: context.traceId,
    ...(input.sessionId ?? context.sessionId ? { sessionId: input.sessionId ?? context.sessionId } : {}),
    ...(input.storyId ?? context.storyId ? { storyId: input.storyId ?? context.storyId } : {}),
  };
}
