import { performance } from 'node:perf_hooks';
import type { EraContextAdapter, EraContextMatch, EraContextSearchInput } from '../../era-context/types.js';
import type { RetrieverAdapter } from '../../retriever/types.js';
import { boundRealtimeQAEvidence, RetrieverRealtimeRecall } from '../retriever-recall.js';
import type { RealtimeRecallRequest } from '../slow-coordinator.js';
import type {
  CoachEraEvidence,
  CoachEvidence,
  CoachGateResult,
  CoachPacket,
  CoachResolveInput,
  CoachScenario,
  RealtimeCoachPort,
} from './types.js';

const ERA_CONTEXT_TIMEOUT_MS = 1_000;

export interface RealtimeCoachPipelineProgress {
  stage: 'retrieval' | 'era_retrieval' | 'resolve';
  status: 'started' | 'completed' | 'failed' | 'timeout';
  turnId?: string;
  contextVersion?: number;
  latencyMs?: number;
  queryChars?: number;
  startYear?: number;
  endYear?: number;
  candidateCount?: number;
  evidenceCount?: number;
  memoryEvidenceCount?: number;
  eraEvidenceCount?: number;
  errorCode?: string;
}

export interface RealtimeCoachPipelineResult {
  packet: CoachPacket;
  memoryEvidenceCount: number;
  eraEvidenceCount: number;
  retrievalMs: number;
  eraRetrievalMs: number;
  resolveMs: number;
}

function report(
  callback: ((event: RealtimeCoachPipelineProgress) => void) | undefined,
  event: RealtimeCoachPipelineProgress,
): void {
  try { callback?.(event); } catch { /* Coach telemetry must not affect the turn. */ }
}

function safeErrorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : error instanceof Error ? error.name : fallback;
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : fallback;
}

function clip(value: string, maxChars: number): string {
  return Array.from(value.trim()).slice(0, maxChars).join('');
}

function boundEraEvidence(matches: EraContextMatch[]): CoachEraEvidence[] {
  let totalChars = 0;
  const evidence: CoachEraEvidence[] = [];
  for (const match of matches.slice(0, 3)) {
    const id = `era-${evidence.length + 1}`;
    const fixedChars = id.length + String(match.start_year).length + String(match.end_year).length;
    const remaining = Math.min(400 - fixedChars, 1_200 - totalChars - fixedChars);
    if (remaining <= 0) break;
    const title = match.title ? clip(match.title, Math.min(80, remaining)) : '';
    const summaryBudget = Math.max(0, remaining - Array.from(title).length);
    const summary = clip(match.summary, summaryBudget);
    if (!summary && !title) continue;
    totalChars += fixedChars + Array.from(title).length + Array.from(summary).length;
    evidence.push({
      id,
      startYear: match.start_year,
      endYear: match.end_year,
      ...(title ? { title } : {}),
      summary,
    });
  }
  return evidence;
}

function emptyRetrievalError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function searchEraWithTimeout(
  adapter: EraContextAdapter,
  input: Omit<EraContextSearchInput, 'signal'>,
  signal?: AbortSignal,
): Promise<EraContextMatch[]> {
  const controller = new AbortController();
  const abortParent = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abortParent();
  else signal?.addEventListener('abort', abortParent, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutOutcome = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(emptyRetrievalError('Era context search timed out.', 'ERA_CONTEXT_TIMEOUT'));
      controller.abort('coach-era-retrieval-timeout');
    }, ERA_CONTEXT_TIMEOUT_MS);
  });
  return Promise.race([
    Promise.resolve().then(() => adapter.search({ ...input, signal: controller.signal })),
    timeoutOutcome,
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener('abort', abortParent);
  });
}

export class RealtimeCoachPipeline {
  private readonly retrieval?: RetrieverRealtimeRecall;

  constructor(
    private readonly coach: RealtimeCoachPort,
    retriever?: RetrieverAdapter,
    private readonly eraContext?: EraContextAdapter,
  ) {
    if (retriever) this.retrieval = new RetrieverRealtimeRecall(retriever);
  }

  async retrieveAndResolve(input: {
    scenario: CoachScenario;
    currentUserAnswer: string;
    gate: CoachGateResult;
    request: RealtimeRecallRequest;
    signal?: AbortSignal;
    onProgress?: (event: RealtimeCoachPipelineProgress) => void;
    onResolveInput?: (input: CoachResolveInput) => void;
    onResolveOutput?: (packet: CoachPacket) => void;
  }): Promise<RealtimeCoachPipelineResult> {
    const trace = { turnId: input.request.turnId, contextVersion: input.request.contextVersion };
    const memoryStartedAt = performance.now();
    const retrieveMemory = async (): Promise<CoachEvidence[]> => {
      if (!input.gate.retrieve_memory) return [];
      report(input.onProgress, { stage: 'retrieval', status: 'started', ...trace });
      try {
        if (!this.retrieval || !input.gate.memory_query) {
          throw emptyRetrievalError('Personal memory retrieval is unavailable.', 'RETRIEVER_UNAVAILABLE');
        }
        const retrieved = await this.retrieval.retrieve({
          ...input.request,
          query: input.gate.memory_query,
        }, { signal: input.signal });
        const evidence = boundRealtimeQAEvidence(retrieved.evidence)
          .map(({ id, question, answer }) => ({ id, question, answer }));
        report(input.onProgress, {
          stage: 'retrieval', status: 'completed', ...trace,
          latencyMs: Number((performance.now() - memoryStartedAt).toFixed(2)),
          candidateCount: retrieved.candidateCount, evidenceCount: evidence.length,
        });
        return evidence;
      } catch (error) {
        report(input.onProgress, {
          stage: 'retrieval',
          status: safeErrorCode(error, '') === 'RETRIEVER_TIMEOUT' ? 'timeout' : 'failed',
          ...trace,
          latencyMs: Number((performance.now() - memoryStartedAt).toFixed(2)),
          errorCode: safeErrorCode(error, 'RETRIEVER_FAILED'),
        });
        throw error;
      }
    };

    const eraStartedAt = performance.now();
    const retrieveEra = async (): Promise<CoachEraEvidence[]> => {
      if (!input.gate.retrieve_era) return [];
      const query = input.gate.era_query;
      const startYear = input.gate.era_start_year;
      const endYear = input.gate.era_end_year;
      const progress = {
        ...trace,
        queryChars: query ? Array.from(query).length : 0,
        ...(startYear === null ? {} : { startYear }),
        ...(endYear === null ? {} : { endYear }),
      };
      report(input.onProgress, { stage: 'era_retrieval', status: 'started', ...progress });
      if (input.scenario !== 'story_continue' || !this.eraContext || !query
        || startYear === null || endYear === null) {
        report(input.onProgress, {
          stage: 'era_retrieval', status: 'completed', ...progress,
          latencyMs: Number((performance.now() - eraStartedAt).toFixed(2)),
          candidateCount: 0, evidenceCount: 0,
        });
        return [];
      }
      try {
        const matches = await searchEraWithTimeout(this.eraContext, {
          query,
          start_year: startYear,
          end_year: endYear,
          top_k: 3,
        }, input.signal);
        const evidence = boundEraEvidence(matches);
        report(input.onProgress, {
          stage: 'era_retrieval', status: 'completed', ...progress,
          latencyMs: Number((performance.now() - eraStartedAt).toFixed(2)),
          candidateCount: matches.length, evidenceCount: evidence.length,
        });
        return evidence;
      } catch (error) {
        const errorCode = safeErrorCode(error, 'ERA_CONTEXT_FAILED');
        report(input.onProgress, {
          stage: 'era_retrieval', status: errorCode === 'ERA_CONTEXT_TIMEOUT' ? 'timeout' : 'failed',
          ...progress,
          latencyMs: Number((performance.now() - eraStartedAt).toFixed(2)),
          candidateCount: 0, evidenceCount: 0, errorCode,
        });
        throw error;
      }
    };

    const [memoryResult, eraResult] = await Promise.allSettled([retrieveMemory(), retrieveEra()]);
    const memoryEvidence = memoryResult.status === 'fulfilled' ? memoryResult.value : [];
    const eraEvidence = eraResult.status === 'fulfilled' ? eraResult.value : [];
    const retrievalMs = Number((performance.now() - memoryStartedAt).toFixed(2));
    const eraRetrievalMs = Number((performance.now() - eraStartedAt).toFixed(2));
    if (input.signal?.aborted) {
      const error = new Error('Realtime Coach turn was cancelled after retrieval.');
      error.name = 'AbortError';
      throw error;
    }

    const resolveStartedAt = performance.now();
    report(input.onProgress, {
      stage: 'resolve', status: 'started', ...trace,
      memoryEvidenceCount: memoryEvidence.length, eraEvidenceCount: eraEvidence.length,
    });
    try {
      const resolveInput: CoachResolveInput = {
        scenario: input.scenario,
        currentUserAnswer: input.currentUserAnswer,
        gate: input.gate,
        memoryEvidence,
        eraEvidence,
      };
      try { input.onResolveInput?.(resolveInput); } catch { /* Trace must not affect Coach. */ }
      const packet = await this.coach.resolve(resolveInput, { signal: input.signal });
      try { input.onResolveOutput?.(packet); } catch { /* Trace must not affect Coach. */ }
      const resolveMs = Number((performance.now() - resolveStartedAt).toFixed(2));
      report(input.onProgress, {
        stage: 'resolve', status: 'completed', ...trace,
        latencyMs: resolveMs,
        memoryEvidenceCount: memoryEvidence.length, eraEvidenceCount: eraEvidence.length,
      });
      return {
        packet,
        memoryEvidenceCount: memoryEvidence.length,
        eraEvidenceCount: eraEvidence.length,
        retrievalMs,
        eraRetrievalMs,
        resolveMs,
      };
    } catch (error) {
      report(input.onProgress, {
        stage: 'resolve', status: 'failed', ...trace,
        latencyMs: performance.now() - resolveStartedAt,
        memoryEvidenceCount: memoryEvidence.length, eraEvidenceCount: eraEvidence.length,
        errorCode: safeErrorCode(error, 'REALTIME_COACH_FAILED'),
      });
      throw error;
    }
  }
}
