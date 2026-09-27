import type { ObservationEvent } from './observation-event.js';

type ObservationListener = (event: ObservationEvent) => void;

export class ObservationBus {
  private readonly buffers = new Map<string, ObservationEvent[]>();
  private readonly listeners = new Set<ObservationListener>();
  private readonly pending: ObservationEvent[] = [];
  private scheduled = false;

  constructor(private readonly options: { capacity?: number; maxSessions?: number; enabled?: boolean } = {}) {}

  get enabled(): boolean { return this.options.enabled !== false; }

  emit(event: ObservationEvent): void {
    if (!this.enabled) return;
    const capacity = this.options.capacity ?? 100;
    if (event.sessionId) {
      const events = this.buffers.get(event.sessionId) ?? [];
      events.push(event);
      if (events.length > capacity) events.splice(0, events.length - capacity);
      this.buffers.delete(event.sessionId);
      this.buffers.set(event.sessionId, events);
      const maxSessions = this.options.maxSessions ?? 32;
      while (this.buffers.size > maxSessions) {
        const oldest = this.buffers.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.buffers.delete(oldest);
      }
    }
    if (this.listeners.size === 0) return;
    this.pending.push(event);
    if (this.pending.length > capacity) this.pending.splice(0, this.pending.length - capacity);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  recent(sessionId: string): ObservationEvent[] {
    return [...(this.buffers.get(sessionId) ?? [])];
  }

  subscribe(listener: ObservationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
    this.pending.length = 0;
    this.buffers.clear();
  }

  private flush(): void {
    this.scheduled = false;
    const events = this.pending.splice(0);
    for (const event of events) {
      for (const listener of this.listeners) {
        try { listener(event); } catch { /* Observation consumers cannot affect runtime work. */ }
      }
    }
  }
}

const defaultObservationBus = new ObservationBus();

export function emitObservationEvent(event: ObservationEvent, bus: ObservationBus = defaultObservationBus): void {
  try { bus.emit(event); } catch { /* Observation failures never reach product flows. */ }
}
