import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  InterviewContextHintTaskInput,
  InterviewContextHintTaskRequest,
} from '../agent-tasks/contracts/index.js';
import type { AgentTaskPort } from '../agent-tasks/ports/agent-task-port.js';
import type { RetrieverAdapter } from '../retriever/types.js';
import type {
  RealtimeContextHint,
  RealtimeRecallPort,
  RealtimeRecallRequest,
  RealtimeSlowPathProgress,
} from './slow-coordinator.js';
import { boundRealtimeQAEvidence, RetrieverRealtimeRecall } from './retriever-recall.js';
type EvidenceId = InterviewContextHintTaskInput['evidence'][number]['id'];

function emptyHint(turnId: string): RealtimeContextHint {
  return { basedOnTurnId: turnId, facts: [], possibleConflicts: [], interviewHints: [] };
}

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,96}$/u.test(code)
    ? code
    : error instanceof Error && /^[A-Z][A-Za-z0-9]{0,95}$/u.test(error.name)
      ? error.name
      : 'AGENT_TASK_FAILED';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Realtime context hint task aborted.');
  error.name = 'AbortError';
  throw error;
}

function currentModel(): string | undefined {
  return process.env.AGENT_MODEL_REALTIME_CONTEXT?.trim()
    || process.env.AGENT_MODEL_REASONING_FAST?.trim()
    || process.env.AGENT_MODEL_DEFAULT?.trim()
    || undefined;
}

function report(request: RealtimeRecallRequest, event: RealtimeSlowPathProgress): void {
  try {
    request.onProgress?.(event);
  } catch {
    // Observability must not affect the Realtime request.
  }
}

/** Current Story retrieval followed by one read-only context-hint task. */
export class RealtimeSlowContextPipeline implements RealtimeRecallPort {
  private readonly retrieval: RetrieverRealtimeRecall;

  constructor(
    retriever: RetrieverAdapter,
    private readonly agentTasks?: AgentTaskPort | null,
  ) {
    this.retrieval = new RetrieverRealtimeRecall(retriever);
  }

  async recall(
    request: RealtimeRecallRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<RealtimeContextHint> {
    const retrievalStartedAt = performance.now();
    report(request, { stage: 'retrieval', status: 'started' });
    let retrieved: Awaited<ReturnType<RetrieverRealtimeRecall['retrieve']>>;
    try {
      retrieved = await this.retrieval.retrieve(request, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      report(request, {
        stage: 'retrieval',
        status: 'failed',
        latencyMs: Number((performance.now() - retrievalStartedAt).toFixed(2)),
        errorCode: safeErrorCode(error),
      });
      throw error;
    }
    throwIfAborted(options.signal);
    report(request, {
      stage: 'retrieval',
      status: 'completed',
      latencyMs: retrieved.latencyMs,
      candidateCount: retrieved.candidateCount,
      evidenceCount: retrieved.evidence.length,
    });

    const evidence = boundRealtimeQAEvidence(retrieved.evidence).map((item) => ({
      ...item,
      id: item.id as EvidenceId,
    }));
    if (evidence.length === 0) {
      report(request, { stage: 'slow_agent', status: 'skipped', skipReason: 'no_evidence' });
      report(request, {
        stage: 'context_hint',
        status: 'ready',
        count: 0,
        selectedEvidenceCount: 0,
      });
      return emptyHint(request.turnId);
    }

    if (!this.agentTasks) {
      report(request, {
        stage: 'slow_agent',
        status: 'skipped',
        skipReason: 'agent_unavailable',
      });
      report(request, {
        stage: 'context_hint',
        status: 'ready',
        count: 0,
        selectedEvidenceCount: 0,
      });
      return emptyHint(request.turnId);
    }

    const agentEvidence = evidence.map(({ id, question, answer }) => ({ id, question, answer }));
    const evidenceInputChars = agentEvidence.reduce((total, item) => total + item.question.length + item.answer.length, 0);
    const evidenceById = new Map(evidence.map((item) => [item.id, item] as const));
    const inputChars = request.query.length + evidenceInputChars;
    const payload: InterviewContextHintTaskRequest['payload'] = {
      query: request.query,
      story: {
        story_id: request.storyId ?? '',
        subject_id: request.ownerId,
      },
      evidence: agentEvidence,
    };
    const startedAt = performance.now();
    const runId = randomUUID();
    const model = currentModel();
    report(request, {
      stage: 'slow_agent',
      status: 'started',
      runId,
      inputChars,
      evidenceInputChars,
      skill: 'interview-observer',
      ...(model ? { model } : {}),
    });

    try {
      const taskRequest: InterviewContextHintTaskRequest = {
        runId,
        taskType: 'interview.context_hint',
        ownerId: request.ownerId,
        resource: { type: 'story', id: request.storyId ?? '', version: request.sessionId },
        ...(request.traceContext ? { traceContext: request.traceContext } : {}),
        schemaVersion: 'v1',
        payload,
      };
      const result = await this.agentTasks.run(taskRequest, { signal: options.signal });
      throwIfAborted(options.signal);
      if (result.taskType !== 'interview.context_hint') throw new Error('AGENT_TASK_TYPE_MISMATCH');
      const output = result.output;
      const selected = output.selected_evidence_ids.map((id) => {
        const item = evidenceById.get(id);
        if (!item) throw Object.assign(new Error('Unknown evidence id.'), { code: 'REALTIME_EVIDENCE_ID_INVALID' });
        return item;
      });
      const hint: RealtimeContextHint = {
        basedOnTurnId: request.turnId,
        facts: selected.map((item) => ({
          claim: item.answer,
          ...(item.question ? { question: item.question } : {}),
          sourceMessageIds: item.sourceMessageIds,
        })),
        possibleConflicts: output.possible_conflicts,
        interviewHints: output.interview_hints,
      };
      report(request, {
        stage: 'slow_agent',
        status: 'completed',
        runId,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        inputChars,
        skill: result.runtime.skill,
        ...(result.runtime.model ? { model: result.runtime.model } : model ? { model } : {}),
        ...(result.runtime.usage?.promptTokens === undefined ? {} : { promptTokens: result.runtime.usage.promptTokens }),
        ...(result.runtime.usage?.completionTokens === undefined ? {} : { completionTokens: result.runtime.usage.completionTokens }),
        ...(result.runtime.usage?.totalTokens === undefined ? {} : { totalTokens: result.runtime.usage.totalTokens }),
        evidenceInputChars,
        selectedEvidenceCount: selected.length,
        possibleConflictCount: hint.possibleConflicts.length,
        interviewHintCount: hint.interviewHints.length,
      });
      report(request, {
        stage: 'context_hint',
        status: 'ready',
        count: selected.length,
        selectedEvidenceCount: selected.length,
        possibleConflictCount: hint.possibleConflicts.length,
        interviewHintCount: hint.interviewHints.length,
      });
      return hint;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const errorCode = safeErrorCode(error);
      report(request, {
        stage: 'slow_agent',
        status: 'failed',
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        inputChars,
        skill: 'interview-observer',
        ...(model ? { model } : {}),
        errorCode,
      });
      report(request, {
        stage: 'context_hint',
        status: 'ready',
        count: 0,
        selectedEvidenceCount: 0,
      });
      return emptyHint(request.turnId);
    }
  }
}
