import type { ObservationEvent } from './observation-event.js';
import type { ObservationBus } from './observation-bus.js';

export interface ObservationAnalyticsSnapshot {
  count: number;
  successRate: number;
  errorRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  byType: Record<string, number>;
}

export function createObservationAnalyticsConsumer(bus: ObservationBus, capacity = 2000) {
  const events: ObservationEvent[] = [];
  const unsubscribe = bus.subscribe((event) => {
    events.push(event);
    if (events.length > capacity) events.splice(0, events.length - capacity);
  });
  return {
    snapshot(): ObservationAnalyticsSnapshot {
      const durations = events.map((event) => event.durationMs).filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
      const percentile = (p: number): number | null => durations.length ? durations[Math.max(0, Math.ceil(p * durations.length) - 1)]! : null;
      const terminal = events.filter((event) => event.status === 'success' || event.status === 'error');
      const byType: Record<string, number> = {};
      for (const event of events) byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;
      return {
        count: events.length,
        successRate: terminal.length ? terminal.filter((event) => event.status === 'success').length / terminal.length : 0,
        errorRate: terminal.length ? terminal.filter((event) => event.status === 'error').length / terminal.length : 0,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        byType,
      };
    },
    dispose: unsubscribe,
  };
}
