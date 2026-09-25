import { performance } from 'node:perf_hooks';
import type { RetrieverAdapter } from '../../retriever/types.js';
import { boundRealtimeQAEvidence, RetrieverRealtimeRecall } from '../retriever-recall.js';
import type { RealtimeRecallRequest } from '../slow-coordinator.js';
import type { CoachGateResult, CoachPacket, CoachScenario, RealtimeCoachPort } from './types.js';

export interface RealtimeCoachPipelineProgress {
  stage: 'retrieval' | 'resolve';
  status: 'started' | 'completed' | 'failed';
  latencyMs?: number;
  candidateCount?: number;
  evidenceCount?: number;
  errorCode?: string;
}

export interface RealtimeCoachPipelineResult {
  packet: CoachPacket;
  evidenceCount: number;
  retrievalMs: number;
  resolveMs: number;
}

function report(
  callback: ((event: RealtimeCoachPipelineProgress) => void) | undefined,
  event: RealtimeCoachPipelineProgress,
): void {
  try { callback?.(event); } catch { /* Coach telemetry must not affect the turn. */ }
}

export class RealtimeCoachPipeline {
  private readonly retrieval: RetrieverRealtimeRecall;

  constructor(
    private readonly coach: RealtimeCoachPort,
    retriever: RetrieverAdapter,
  ) {
    this.retrieval = new RetrieverRealtimeRecall(retriever);
  }

  async retrieveAndResolve(input: {
    scenario: CoachScenario;
    currentUserAnswer: string;
    gate: CoachGateResult;
    request: RealtimeRecallRequest;
    signal?: AbortSignal;
    onProgress?: (event: RealtimeCoachPipelineProgress) => void;
  }): Promise<RealtimeCoachPipelineResult> {
    const retrievalStartedAt = performance.now();
    report(input.onProgress, { stage: 'retrieval', status: 'started' });
    let retrieved: Awaited<ReturnType<RetrieverRealtimeRecall['retrieve']>>;
    try {
      retrieved = await this.retrieval.retrieve(input.request, { signal: input.signal });
    } catch (error) {
      const errorCode = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : error instanceof Error ? error.name : 'RETRIEVER_FAILED';
      report(input.onProgress, {
        stage: 'retrieval', status: 'failed',
        latencyMs: performance.now() - retrievalStartedAt,
        errorCode: /^[A-Z][A-Z0-9_]{0,63}$/u.test(errorCode) ? errorCode : 'RETRIEVER_FAILED',
      });
      throw error;
    }
    const retrievalMs = Number((performance.now() - retrievalStartedAt).toFixed(2));
    const evidence = boundRealtimeQAEvidence(retrieved.evidence)
      .map(({ id, question, answer }) => ({ id, question, answer }));
    report(input.onProgress, {
      stage: 'retrieval', status: 'completed', latencyMs: retrievalMs,
      candidateCount: retrieved.candidateCount, evidenceCount: evidence.length,
    });
    if (input.signal?.aborted) {
      const error = new Error('Realtime Coach turn was cancelled after retrieval.');
      error.name = 'AbortError';
      throw error;
    }

    const resolveStartedAt = performance.now();
    report(input.onProgress, { stage: 'resolve', status: 'started' });
    try {
      const packet = await this.coach.resolve({
        scenario: input.scenario,
        currentUserAnswer: input.currentUserAnswer,
        gate: input.gate,
        evidence,
      }, { signal: input.signal });
      const resolveMs = Number((performance.now() - resolveStartedAt).toFixed(2));
      report(input.onProgress, {
        stage: 'resolve', status: 'completed', latencyMs: resolveMs,
        evidenceCount: evidence.length,
      });
      return { packet, evidenceCount: evidence.length, retrievalMs, resolveMs };
    } catch (error) {
      const errorCode = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : error instanceof Error ? error.name : 'REALTIME_COACH_FAILED';
      report(input.onProgress, {
        stage: 'resolve', status: 'failed', latencyMs: performance.now() - resolveStartedAt,
        evidenceCount: evidence.length,
        errorCode: /^[A-Z][A-Z0-9_]{0,63}$/u.test(errorCode) ? errorCode : 'REALTIME_COACH_FAILED',
      });
      throw error;
    }
  }
}
