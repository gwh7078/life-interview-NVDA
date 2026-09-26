import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RealtimeCoachPipeline, type RealtimeCoachPipelineProgress } from './pipeline.js';
import type { EraContextAdapter } from '../../era-context/types.js';
import type { RetrieverAdapter } from '../../retriever/types.js';
import type { CoachGateResult, RealtimeCoachPort } from './types.js';

const gate: CoachGateResult = {
  action: 'guide',
  retrieve_memory: true,
  memory_query: '用户过去的工作经历',
  retrieve_era: true,
  era_query: '1998 年就业环境',
  era_start_year: 1996,
  era_end_year: 2000,
  reason: 'history_reference',
  avoid: null,
  direction: '继续追问当时的工作变化。',
};

const request = {
  ownerId: 'owner', sessionId: 'session', storyId: 'story', turnId: 'turn', contextVersion: 1,
  query: '用户过去的工作经历', traceContext: { traceId: 'trace', spanId: 'span', parentSpanId: 'parent', sessionId: 'session', storyId: 'story' },
};

const coach: RealtimeCoachPort = {
  async evaluate() { return gate; },
  async resolve() {
    return {
      selectedEvidenceIds: [], known: [], backgroundHint: null, conflict: null,
      avoid: null, direction: '继续追问当时的工作变化。',
    };
  },
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retriever(delayMs: number): RetrieverAdapter {
  return {
    async indexSessionTranscript() { return { status: 'accepted' }; },
    async searchTranscript() {
      await delay(delayMs);
      return [{
        text: '[segment_id=segment][message_id=message][Q+A]\nQuestion (context only):工作经历\nAnswer (user-provided fact):曾经换过工作。',
        score: 0.9, ownerId: 'owner', storyId: 'story', sourceType: 'subject',
        sessionId: 'history', messageIds: ['message'], segmentIds: ['segment'],
      }];
    },
    async deleteSessionTranscript(sessionId) { return { documentId: sessionId, status: 'deleted' }; },
    async getIndexStatus(sessionId) { return { documentId: sessionId, status: 'indexed' }; },
  };
}

const eraContext: EraContextAdapter = {
  async search() {
    await delay(5);
    return [{ start_year: 1996, end_year: 2000, category: '就业', title: '工作变化', summary: '部分单位经历调整。', score: 0.9 }];
  },
};

test('parallel Memory and Era retrieval report independent completion and durations', async () => {
  const progress: RealtimeCoachPipelineProgress[] = [];
  const result = await new RealtimeCoachPipeline(coach, retriever(45), eraContext).retrieveAndResolve({
    scenario: 'story_continue', currentUserAnswer: '第二年情况更严重了。', gate, request,
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(progress.map(({ stage, status }) => `${stage}:${status}`), [
    'retrieval:started', 'era_retrieval:started', 'era_retrieval:completed',
    'retrieval:completed', 'resolve:started', 'resolve:completed',
  ]);
  const memoryCompleted = progress.find((event) => event.stage === 'retrieval' && event.status === 'completed');
  const eraCompleted = progress.find((event) => event.stage === 'era_retrieval' && event.status === 'completed');
  assert.ok(memoryCompleted?.latencyMs !== undefined && eraCompleted?.latencyMs !== undefined);
  assert.ok(memoryCompleted.latencyMs > eraCompleted.latencyMs);
  assert.equal(result.memoryRetrievalMs, memoryCompleted.latencyMs);
  assert.equal(result.eraRetrievalMs, eraCompleted.latencyMs);
});

test('unavailable or unrequested retrieval is skipped without fake duration', async () => {
  const progress: RealtimeCoachPipelineProgress[] = [];
  const result = await new RealtimeCoachPipeline(coach, retriever(1)).retrieveAndResolve({
    scenario: 'story_continue', currentUserAnswer: '继续。',
    gate: { ...gate, retrieve_era: true }, request,
    onProgress: (event) => progress.push(event),
  });

  const eraSkipped = progress.find((event) => event.stage === 'era_retrieval' && event.status === 'skipped');
  assert.equal(eraSkipped?.skipReason, 'ERA_CONTEXT_UNAVAILABLE');
  assert.equal(result.eraRetrievalMs, null);

  progress.length = 0;
  const noRetrievalResult = await new RealtimeCoachPipeline(coach, retriever(1)).retrieveAndResolve({
    scenario: 'story_continue', currentUserAnswer: '继续。',
    gate: {
      ...gate, retrieve_memory: false, memory_query: null,
      retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    }, request,
    onProgress: (event) => progress.push(event),
  });
  assert.deepEqual(progress.slice(0, 2).map(({ stage, status, skipReason }) => [stage, status, skipReason]), [
    ['retrieval', 'skipped', 'RETRIEVAL_NOT_REQUESTED'],
    ['era_retrieval', 'skipped', 'RETRIEVAL_NOT_REQUESTED'],
  ]);
  assert.equal(noRetrievalResult.memoryRetrievalMs, null);
  assert.equal(noRetrievalResult.eraRetrievalMs, null);
});

test('unavailable or failed requested retrieval is not treated as successful empty evidence', async () => {
  const emptyEra: EraContextAdapter = { async search() { return []; } };
  const failedMemory: RetrieverAdapter = {
    ...retriever(0),
    async searchTranscript() { throw new Error('Retriever service failed.'); },
  };
  const cases: Array<{ name: string; retriever?: RetrieverAdapter }> = [
    { name: 'unavailable', retriever: undefined },
    { name: 'failed', retriever: failedMemory },
  ];

  for (const item of cases) {
    const progress: RealtimeCoachPipelineProgress[] = [];
    await assert.rejects(
      new RealtimeCoachPipeline(coach, item.retriever, emptyEra).retrieveAndResolve({
        scenario: 'story_continue', currentUserAnswer: '继续回忆。', gate, request,
        onProgress: (event) => progress.push(event),
      }),
      (error: unknown) => error instanceof Error
        && (error as Error & { code?: string }).code === 'REALTIME_COACH_RETRIEVAL_FAILED',
      `${item.name} retrieval must fail open when the remaining requested path returns no evidence`,
    );
    assert.equal(progress.some((event) => event.stage === 'resolve' && event.status === 'started'), false);
    const memoryProgress = progress.filter((event) => event.stage === 'retrieval').at(-1);
    if (item.name === 'unavailable') {
      assert.equal(memoryProgress?.skipReason, 'RETRIEVER_UNAVAILABLE');
    } else {
      assert.equal(memoryProgress?.status, 'failed');
    }
    assert.equal(progress.filter((event) => event.stage === 'era_retrieval').at(-1)?.status, 'completed');
  }
});
