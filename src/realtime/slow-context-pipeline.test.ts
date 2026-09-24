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
  storySummary: '项目故事摘要。',
  recentContext: [
    { role: 'user' as const, text: '最近用户回答。' },
    { role: 'assistant' as const, text: '最近助手提问。' },
  ],
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
    story_summary: '项目故事摘要。',
    recent_context: request.recentContext,
    evidence: [{ id: 'e1', question: '你第一次去北京是什么时候？', answer: '2013年春节以后第一次到北京。' }],
  });
  assert.deepEqual(hint.facts, [{
    claim: '2013年春节以后第一次到北京。',
    question: '你第一次去北京是什么时候？',
    sourceMessageIds: ['answer-1'],
  }]);
  assert.deepEqual(hint.interviewHints, ['可追问具体年份']);
});

test('an ID omitted from the Agent input fails validation and falls back to direct evidence', async () => {
  const progress: Array<{ stage: string; status: string; errorCode?: string; fallbackUsed?: boolean }> = [];
  const pipeline = new RealtimeSlowContextPipeline(retriever(), agent({
    selected_evidence_ids: ['e2'],
    possible_conflicts: [],
    interview_hints: [],
  }));

  const hint = await pipeline.recall({ ...request, onProgress: (event) => progress.push(event) });

  assert.equal(hint.facts[0]?.claim, '2013年春节以后第一次到北京。');
  assert.ok(progress.some((event) => event.status === 'failed' && event.errorCode === 'REALTIME_EVIDENCE_ID_INVALID'));
  assert.ok(progress.some((event) => event.stage === 'context_hint' && event.fallbackUsed));
});

test('Agent unavailable uses scoped direct Retriever evidence', async () => {
  const progress: Array<{ stage: string; status: string; fallbackType?: string }> = [];
  const pipeline = new RealtimeSlowContextPipeline(retriever());

  const hint = await pipeline.recall({ ...request, onProgress: (event) => progress.push(event) });

  assert.equal(hint.facts.length, 1);
  assert.equal(hint.facts[0]?.claim, '2013年春节以后第一次到北京。');
  assert.ok(progress.some((event) => event.stage === 'slow_agent'
    && event.status === 'skipped' && event.fallbackType === 'direct_retrieval'));
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
