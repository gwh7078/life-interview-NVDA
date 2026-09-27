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
  status: 'started' | 'completed' | 'failed' | 'timeout' | 'skipped';
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
  skipReason?: 'RETRIEVER_UNAVAILABLE' | 'ERA_CONTEXT_UNAVAILABLE' | 'RETRIEVAL_NOT_REQUESTED' | 'NO_EVIDENCE';
}

export interface RealtimeCoachPipelineResult {
  packet: CoachPacket;
  memoryEvidenceCount: number;
  eraEvidenceCount: number;
  memoryRetrievalMs: number | null;
  eraRetrievalMs: number | null;
  resolveMs: number;
}

type RetrievalPathResult<T> =
  | { status: 'not_requested' | 'unavailable'; evidence: T[] }
  | { status: 'success'; evidence: T[] };

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
    let memoryRetrievalMs: number | null = null;
    let eraRetrievalMs: number | null = null;
    const retrieveMemory = async (): Promise<RetrievalPathResult<CoachEvidence>> => {
      if (!input.gate.retrieve_memory) {
        report(input.onProgress, {
          stage: 'retrieval', status: 'skipped', ...trace,
          skipReason: 'RETRIEVAL_NOT_REQUESTED',
        });
        return { status: 'not_requested', evidence: [] };
      }
      const memoryStartedAt = performance.now();
      report(input.onProgress, { stage: 'retrieval', status: 'started', ...trace });
      try {
        if (!this.retrieval || !input.gate.memory_query) {
          report(input.onProgress, {
            stage: 'retrieval', status: 'skipped', ...trace,
            skipReason: 'RETRIEVER_UNAVAILABLE',
            errorCode: 'RETRIEVER_UNAVAILABLE',
          });
          return { status: 'unavailable', evidence: [] };
        }
        const retrieved = await this.retrieval.retrieve({
          ...input.request,
          query: input.gate.memory_query,
        }, { signal: input.signal });
        const evidence = boundRealtimeQAEvidence(retrieved.evidence)
          .map(({ id, question, answer }) => ({ id, question, answer }));
        memoryRetrievalMs = Number((performance.now() - memoryStartedAt).toFixed(2));
        report(input.onProgress, {
          stage: 'retrieval', status: 'completed', ...trace,
          latencyMs: memoryRetrievalMs,
          candidateCount: retrieved.candidateCount, evidenceCount: evidence.length,
        });
        return { status: 'success', evidence };
      } catch (error) {
        memoryRetrievalMs = Number((performance.now() - memoryStartedAt).toFixed(2));
        report(input.onProgress, {
          stage: 'retrieval',
          status: safeErrorCode(error, '') === 'RETRIEVER_TIMEOUT' ? 'timeout' : 'failed',
          ...trace,
          latencyMs: memoryRetrievalMs,
          errorCode: safeErrorCode(error, 'RETRIEVER_FAILED'),
        });
        throw error;
      }
    };

    const retrieveEra = async (): Promise<RetrievalPathResult<CoachEraEvidence>> => {
      if (!input.gate.retrieve_era) {
        report(input.onProgress, {
          stage: 'era_retrieval', status: 'skipped', ...trace,
          skipReason: 'RETRIEVAL_NOT_REQUESTED',
        });
        return { status: 'not_requested', evidence: [] };
      }
      const eraStartedAt = performance.now();
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
          stage: 'era_retrieval', status: 'skipped', ...progress,
          skipReason: 'ERA_CONTEXT_UNAVAILABLE',
          errorCode: 'ERA_CONTEXT_UNAVAILABLE',
        });
        return { status: 'unavailable', evidence: [] };
      }
      try {
        const matches = await searchEraWithTimeout(this.eraContext, {
          query,
          start_year: startYear,
          end_year: endYear,
          top_k: 3,
        }, input.signal);
        const evidence = boundEraEvidence(matches);
        eraRetrievalMs = Number((performance.now() - eraStartedAt).toFixed(2));
        report(input.onProgress, {
          stage: 'era_retrieval', status: 'completed', ...progress,
          latencyMs: eraRetrievalMs,
          candidateCount: matches.length, evidenceCount: evidence.length,
        });
        return { status: 'success', evidence };
      } catch (error) {
        const errorCode = safeErrorCode(error, 'ERA_CONTEXT_FAILED');
        eraRetrievalMs = Number((performance.now() - eraStartedAt).toFixed(2));
        report(input.onProgress, {
          stage: 'era_retrieval', status: errorCode === 'ERA_CONTEXT_TIMEOUT' ? 'timeout' : 'failed',
          ...progress,
          latencyMs: eraRetrievalMs,
          candidateCount: 0, evidenceCount: 0, errorCode,
        });
        throw error;
      }
    };

    const [memoryResult, eraResult] = await Promise.allSettled([retrieveMemory(), retrieveEra()]);
    const memoryOutcome = memoryResult.status === 'fulfilled'
      ? memoryResult.value : { status: 'failed' as const, evidence: [] };
    const eraOutcome = eraResult.status === 'fulfilled'
      ? eraResult.value : { status: 'failed' as const, evidence: [] };
    const memoryEvidence = memoryOutcome.evidence;
    const eraEvidence = eraOutcome.evidence;
    if (input.signal?.aborted) {
      const error = new Error('Realtime Coach turn was cancelled after retrieval.');
      error.name = 'AbortError';
      throw error;
    }
    if (memoryEvidence.length === 0 && eraEvidence.length === 0) {
      if (memoryOutcome.status === 'failed' || memoryOutcome.status === 'unavailable'
        || eraOutcome.status === 'failed' || eraOutcome.status === 'unavailable') {
        throw Object.assign(new Error('Requested Realtime Coach retrieval did not complete successfully.'), {
          code: 'REALTIME_COACH_RETRIEVAL_FAILED',
        });
      }
      report(input.onProgress, {
        stage: 'resolve', status: 'skipped', ...trace,
        memoryEvidenceCount: 0, eraEvidenceCount: 0, skipReason: 'NO_EVIDENCE',
      });
      return {
        packet: {
          selectedEvidenceIds: [], known: [], backgroundHint: null, conflict: null,
          avoid: input.gate.avoid, direction: input.gate.direction,
        },
        memoryEvidenceCount: 0,
        eraEvidenceCount: 0,
        memoryRetrievalMs,
        eraRetrievalMs,
        resolveMs: 0,
      };
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
        memoryRetrievalMs,
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
