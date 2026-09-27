import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentTaskPort } from '../agent-tasks/ports/agent-task-port.js';
import type { RetrieverAdapter, RetrieverEvidence } from '../retriever/types.js';
import { RealtimeSlowContextPipeline } from './slow-context-pipeline.js';

const request = {
  ownerId: 'owner-1',
  sessionId: 'session-current',
  storyId: 'story-1',
  turnId: 'turn-1',
  contextVersion: 2,
  query: '第一次去北京是什么时候？',
};

function evidence(answer = '2013年春节以后第一次到北京。'): RetrieverEvidence[] {
  return [{
    text: `[segment_id=segment-1][message_id=answer-1][Q+A]\nQuestion (context only):你第一次去北京是什么时候？\nAnswer (user-provided fact):${answer}`,
    score: 0.9,
    ownerId: 'owner-1',
    storyId: 'story-1',
    sourceType: 'subject',
    sessionId: 'session-old',
    messageIds: ['answer-1'],
    segmentIds: ['segment-1'],
  }];
}

function retriever(rows: RetrieverEvidence[] = evidence()): RetrieverAdapter {
  return {
    async indexSessionTranscript() { return { status: 'accepted' }; },
    async searchTranscript() { return rows; },
    async deleteSessionTranscript(sessionId) { return { documentId: sessionId, status: 'deleted' }; },
    async getIndexStatus(sessionId) { return { documentId: sessionId, status: 'indexed' }; },
  };
}

function agent(output: Record<string, unknown>, onRun?: (request: unknown) => void): AgentTaskPort {
  return {
    async run(taskRequest) {
      onRun?.(taskRequest);
      return {
        runId: taskRequest.runId,
        taskType: 'interview.context_hint',
        schemaVersion: 'v1',
        output,
        runtime: {
          runtime: 'test-agent',
          skill: 'interview-observer',
          model: 'test-model',
          latencyMs: 1,
          usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
        },
      } as Awaited<ReturnType<AgentTaskPort['run']>>;
    },
  };
}

test('no evidence skips Agent and returns an empty context hint', async () => {
  let calls = 0;
  const progress: Array<{ stage: string; status: string; skipReason?: string }> = [];
  const pipeline = new RealtimeSlowContextPipeline(retriever([]), agent({}, () => { calls += 1; }));

  const hint = await pipeline.recall({ ...request, onProgress: (event) => progress.push(event) });

  assert.deepEqual(hint, {
    basedOnTurnId: 'turn-1',
    facts: [],
    possibleConflicts: [],
    interviewHints: [],
  });
  assert.equal(calls, 0);
  assert.ok(progress.some((event) => event.stage === 'slow_agent' && event.skipReason === 'no_evidence'));
});

test('Agent receives bounded context and can select only exact retrieved user answers', async () => {
  let received: unknown;
  const pipeline = new RealtimeSlowContextPipeline(retriever(), agent({
    selected_evidence_ids: ['e1'],
    possible_conflicts: [],
    interview_hints: ['可追问具体年份'],
  }, (taskRequest) => { received = taskRequest; }));

  const hint = await pipeline.recall(request);

  assert.equal((received as { taskType: string }).taskType, 'interview.context_hint');
  assert.deepEqual((received as { payload: unknown }).payload, {
    query: request.query,
    story: { story_id: 'story-1', subject_id: 'owner-1' },
    evidence: [{ id: 'e1', question: '你第一次去北京是什么时候？', answer: '2013年春节以后第一次到北京。' }],
  });
  assert.deepEqual(hint.facts, [{
    claim: '2013年春节以后第一次到北京。',
    question: '你第一次去北京是什么时候？',
    sourceMessageIds: ['answer-1'],
  }]);
  assert.deepEqual(hint.interviewHints, ['可追问具体年份']);
});

test('Agent Task receives the Realtime trace context for the Tool Cycle', async () => {
  let received: unknown;
  const traceContext = {
    traceId: 'trace-session-current',
    sessionId: 'session-current',
    storyId: 'story-1',
    parentSpanId: 'tool-cycle-1',
  };
  const pipeline = new RealtimeSlowContextPipeline(retriever(), agent({
    selected_evidence_ids: ['e1'], possible_conflicts: [], interview_hints: [],
  }, (taskRequest) => { received = taskRequest; }));

  const tracedRequest = Object.assign({}, request, { traceContext });
  await pipeline.recall(tracedRequest);

  assert.deepEqual((received as { traceContext?: unknown }).traceContext, traceContext);
});

test('Agent Context Hint uses the five-item, 450-character, 2,000-character Q+A evidence budget', async () => {
  const oversizedEvidence = Array.from({ length: 7 }, (_, index) => ({
    ...evidence('答'.repeat(700))[0]!,
    text: `[segment_id=segment-${index}][message_id=answer-${index}][Q+A]\nQuestion (context only):${'问'.repeat(100)}\nAnswer (user-provided fact):${'答'.repeat(700)}`,
    messageIds: [`answer-${index}`],
    segmentIds: [`segment-${index}`],
  }));
  const assertBudget = (facts: Awaited<ReturnType<RealtimeSlowContextPipeline['recall']>>['facts']) => {
    assert.ok(facts.length <= 5);
    assert.ok(facts.every((fact) => (fact.question?.length ?? 0) + fact.claim.length <= 450));
    assert.ok(facts.reduce((total, fact) => total + (fact.question?.length ?? 0) + fact.claim.length, 0) <= 2_000);
  };

  let agentInput: unknown;
  const successHint = await new RealtimeSlowContextPipeline(retriever(oversizedEvidence), agent({
    selected_evidence_ids: ['e1'], possible_conflicts: [], interview_hints: [],
  }, (taskRequest) => { agentInput = taskRequest; })).recall(request);
  assertBudget(successHint.facts);
  const submittedEvidence = (agentInput as { payload: { evidence: Array<{ question: string; answer: string }> } }).payload.evidence;
  assert.ok(submittedEvidence.length <= 5);
  assert.ok(submittedEvidence.every((item) => item.question.length + item.answer.length <= 450));
  assert.ok(submittedEvidence.reduce((total, item) => total + item.question.length + item.answer.length, 0) <= 2_000);
});

test('an invalid Agent evidence selection fails closed to no-context', async () => {
  const progress: Array<{ stage: string; status: string; errorCode?: string; fallbackUsed?: boolean }> = [];
  const pipeline = new RealtimeSlowContextPipeline(retriever(), agent({
    selected_evidence_ids: ['e2'],
    possible_conflicts: [],
    interview_hints: [],
  }));

  const hint = await pipeline.recall({ ...request, onProgress: (event) => progress.push(event) });

  assert.deepEqual(hint.facts, []);
  assert.ok(progress.some((event) => event.status === 'failed' && event.errorCode === 'REALTIME_EVIDENCE_ID_INVALID'));
  assert.equal(progress.some((event) => event.fallbackUsed), false);
});

test('Agent unavailable fails closed to no-context instead of forwarding Retriever evidence', async () => {
  const progress: Array<{ stage: string; status: string; fallbackType?: string; skipReason?: string }> = [];
  const pipeline = new RealtimeSlowContextPipeline(retriever());

  const hint = await pipeline.recall({ ...request, onProgress: (event) => progress.push(event) });

  assert.deepEqual(hint.facts, []);
  assert.ok(progress.some((event) => event.stage === 'slow_agent'
    && event.status === 'skipped' && event.skipReason === 'agent_unavailable'));
  assert.equal(progress.some((event) => event.fallbackType === 'direct_retrieval'), false);
});

test('Agent error fails closed to no-context', async () => {
  const failedTasks: AgentTaskPort = {
    async run() { throw new Error('AGENT_RUNTIME_FAILED'); },
  };
  const progress: Array<{ stage: string; status: string; errorCode?: string; fallbackUsed?: boolean }> = [];
  const hint = await new RealtimeSlowContextPipeline(retriever(), failedTasks)
    .recall({ ...request, onProgress: (event) => progress.push(event) });

  assert.deepEqual(hint.facts, []);
  assert.ok(progress.some((event) => event.stage === 'slow_agent'
    && event.status === 'failed' && event.errorCode === 'Error'));
  assert.equal(progress.some((event) => event.fallbackUsed), false);
});

test('an aborted Agent result cannot emit a hint after the slow-path deadline', async () => {
  let resolveTask: ((value: Awaited<ReturnType<AgentTaskPort['run']>>) => void) | undefined;
  const agentPort: AgentTaskPort = {
    run() {
      return new Promise((resolve) => { resolveTask = resolve; });
    },
  };
  const controller = new AbortController();
  const progress: Array<{ stage: string; status: string }> = [];
  const pipeline = new RealtimeSlowContextPipeline(retriever(), agentPort);
  const result = pipeline.recall({ ...request, onProgress: (event) => progress.push(event) }, { signal: controller.signal });
  while (!resolveTask) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  resolveTask({
    runId: 'run-1',
    taskType: 'interview.context_hint',
    schemaVersion: 'v1',
    output: { selected_evidence_ids: ['e1'], possible_conflicts: [], interview_hints: [] },
    runtime: { runtime: 'test-agent', skill: 'interview-observer' },
  } as Awaited<ReturnType<AgentTaskPort['run']>>);

  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(progress.some((event) => event.stage === 'context_hint' && event.status === 'ready'), false);
});
