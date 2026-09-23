import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export interface RealtimeRecallRequest {
  ownerId: string;
  sessionId: string;
  storyId?: string;
  turnId: string;
  contextVersion: number;
  query: string;
}

export interface RealtimeContextFact {
  claim: string;
  sourceMessageIds: string[];
}

export interface RealtimeContextHint {
  basedOnTurnId: string;
  facts: RealtimeContextFact[];
  possibleConflicts: string[];
  interviewHints: string[];
}

export interface RealtimeRecallPort {
  recall(
    request: RealtimeRecallRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RealtimeContextHint>;
}

/** Deterministic seam for live integration before the Classic Retrieval adapter lands. */
export class StubRealtimeRecall implements RealtimeRecallPort {
  async recall(
    request: RealtimeRecallRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<RealtimeContextHint> {
    if (options.signal?.aborted) throw abortError();
    return {
      basedOnTurnId: request.turnId,
      facts: [{
        claim: '此前用户提到王师傅是入厂后的第一位师傅。',
        sourceMessageIds: ['stub-message-1'],
      }],
      possibleConflicts: [],
      interviewHints: ['如果用户正在纠正年份或关系，优先追问并保留用户的明确修正。'],
    };
  }
}

/** Safe production fallback when the Retriever is not configured or available. */
export class UnavailableRealtimeRecall implements RealtimeRecallPort {
  async recall(
    request: RealtimeRecallRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<RealtimeContextHint> {
    if (options.signal?.aborted) throw abortError();
    return {
      basedOnTurnId: request.turnId,
      facts: [],
      possibleConflicts: [],
      interviewHints: [],
    };
  }
}

export type SlowRecallStatus = 'completed' | 'timeout' | 'failed' | 'aborted' | 'stale';

export interface SlowRecallResult {
  runId: string;
  status: SlowRecallStatus;
  latencyMs: number;
  hint?: RealtimeContextHint;
  errorCode?: string;
}

type RecallOutcome =
  | { kind: 'completed'; hint: RealtimeContextHint }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

interface ActiveRecall {
  controller: AbortController;
  generation: number;
  runId: string;
}

function abortError(): Error {
  const error = new Error('Realtime recall aborted.');
  error.name = 'AbortError';
  return error;
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && /^RETRIEVER_[A-Z0-9_]+$/.test(code)) return code;
    if (error.name) return error.name;
  }
  return 'unknown';
}

export class RealtimeSlowCoordinator {
  private generation = 0;
  private active?: ActiveRecall;

  constructor(
    private readonly recallPort: RealtimeRecallPort,
    private readonly deadlineMs = 5_500,
  ) {
    if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
      throw new Error('Realtime slow recall deadline must be a positive integer.');
    }
  }

  cancel(): void {
    this.generation += 1;
    this.active?.controller.abort('cancelled');
    this.active = undefined;
  }

  run(
    request: RealtimeRecallRequest,
    isCurrent: () => boolean = () => true,
  ): Promise<SlowRecallResult> {
    this.active?.controller.abort('superseded');
    const generation = ++this.generation;
    const runId = randomUUID();
    const controller = new AbortController();
    const active: ActiveRecall = { controller, generation, runId };
    this.active = active;
    return this.execute(active, request, isCurrent);
  }

  private async execute(
    active: ActiveRecall,
    request: RealtimeRecallRequest,
    isCurrent: () => boolean,
  ): Promise<SlowRecallResult> {
    const startedAt = performance.now();
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const outcome = await Promise.race<RecallOutcome>([
        Promise.resolve(this.recallPort.recall(request, { signal: active.controller.signal }))
          .then((hint): RecallOutcome => ({ kind: 'completed', hint }))
          .catch((error): RecallOutcome => ({ kind: 'failed', error })),
        new Promise<RecallOutcome>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: 'timeout' }), this.deadlineMs);
        }),
        new Promise<RecallOutcome>((resolve) => {
          abortListener = () => resolve({ kind: 'aborted' });
          if (active.controller.signal.aborted) resolve({ kind: 'aborted' });
          else active.controller.signal.addEventListener('abort', abortListener, { once: true });
        }),
      ]);
      const latencyMs = performance.now() - startedAt;
      const stale = active.generation !== this.generation || this.active?.runId !== active.runId || !isCurrent();
      if (stale) return { runId: active.runId, status: 'stale', latencyMs };
      if (outcome.kind === 'completed') return { runId: active.runId, status: 'completed', latencyMs, hint: outcome.hint };
      if (outcome.kind === 'timeout') {
        active.controller.abort('deadline');
        return { runId: active.runId, status: 'timeout', latencyMs, errorCode: 'REALTIME_RECALL_TIMEOUT' };
      }
      if (outcome.kind === 'aborted') return { runId: active.runId, status: 'aborted', latencyMs, errorCode: 'REALTIME_RECALL_ABORTED' };
      return { runId: active.runId, status: 'failed', latencyMs, errorCode: errorCode(outcome.error) };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) active.controller.signal.removeEventListener('abort', abortListener);
      if (this.active?.runId === active.runId) this.active = undefined;
    }
  }
}
