import assert from 'node:assert/strict';
import test from 'node:test';
import { RetrieverRealtimeRecall } from './retriever-recall.js';
import type { RetrieverAdapter } from '../retriever/types.js';

const request = {
  ownerId: 'user-1',
  sessionId: 'session-current',
  storyId: 'story-1',
  turnId: 'turn-1',
  contextVersion: 1,
  query: '第一次去北京是什么时候',
};

function adapter(overrides: Partial<RetrieverAdapter> = {}): RetrieverAdapter {
  return {
    async indexSessionTranscript() { return { status: 'accepted' }; },
    async searchTranscript() { return []; },
    async deleteSessionTranscript(sessionId) { return { documentId: sessionId, status: 'deleted' }; },
    async getIndexStatus(sessionId) { return { documentId: sessionId, status: 'indexed' }; },
    ...overrides,
  };
}

test('Realtime Retriever recall sends owner/story scope and keeps only traceable evidence', async () => {
  let received: Parameters<RetrieverAdapter['searchTranscript']>[0] | undefined;
  const recall = new RetrieverRealtimeRecall(adapter({
    async searchTranscript(input) {
      received = input;
      return [
        {
          text: '[segment_id=segment-1][message_id=message-1][Q+A]\nQuestion (context only):你第一次去北京是什么时候？\nAnswer (user-provided fact):2013 年春节以后第一次到北京。',
          score: 0.9,
          ownerId: 'user-1',
          storyId: 'story-1',
          sourceType: 'subject',
          sessionId: 'session-old',
          messageIds: ['message-1'],
          segmentIds: ['segment-1'],
        },
        {
          text: '别的用户的内容',
          score: 0.8,
          ownerId: 'user-2',
          storyId: 'story-1',
          sourceType: 'subject',
          sessionId: 'session-other',
          messageIds: ['message-2'],
          segmentIds: [],
        },
        {
          text: '没有来源 ID 的内容',
          score: 0.7,
          ownerId: 'user-1',
          storyId: 'story-1',
          sourceType: 'subject',
          sessionId: 'session-old',
          messageIds: [],
          segmentIds: [],
        },
      ];
    },
  }));

  const result = await recall.recall(request);

  assert.deepEqual(received && {
    ownerId: received.ownerId,
    storyId: received.storyId,
    sourceType: received.sourceType,
    query: received.query,
    topK: received.topK,
  }, {
    ownerId: 'user-1',
    storyId: 'story-1',
    sourceType: 'subject',
    query: '第一次去北京是什么时候',
    topK: 5,
  });
  assert.deepEqual(result, {
    basedOnTurnId: 'turn-1',
    facts: [{
      claim: '2013 年春节以后第一次到北京。',
      question: '你第一次去北京是什么时候？',
      sourceMessageIds: ['message-1'],
    }],
    possibleConflicts: [],
    interviewHints: [],
  });
});

test('Realtime retrieval fails closed when there is no Current Story', async () => {
  let calls = 0;
  const recall = new RetrieverRealtimeRecall(adapter({
    async searchTranscript() { calls += 1; return []; },
  }));

  const result = await recall.recall({ ...request, storyId: undefined });

  assert.equal(calls, 0);
  assert.deepEqual(result.facts, []);
});

test('only Q+A answers from the exact owner, story and subject source become facts', async () => {
  const recall = new RetrieverRealtimeRecall(adapter({
    async searchTranscript() {
      return [
        {
          text: '[segment_id=a][message_id=a][Q+A]\nQuestion (context only):王师傅什么时候入厂？\nAnswer (user-provided fact):2013年入厂。',
          score: 1,
          ownerId: 'user-1', storyId: 'story-1', sourceType: 'subject',
          sessionId: 'session-a', messageIds: ['a'], segmentIds: ['a'],
        },
        {
          text: '[segment_id=b][message_id=b][Q+A]\nQuestion (context only):王师傅什么时候入厂？\nAnswer (user-provided fact):2013年入厂。',
          score: 0.99,
          ownerId: 'user-1', storyId: 'story-2', sourceType: 'subject',
          sessionId: 'session-b', messageIds: ['b'], segmentIds: ['b'],
        },
        {
          text: '[segment_id=c][message_id=c][Q+A]\nQuestion (context only):王师傅什么时候入厂？\nAnswer (user-provided fact):2013年入厂。',
          score: 0.98,
          ownerId: 'user-1', storyId: 'story-1', sourceType: 'external_contributor',
          sessionId: 'session-c', messageIds: ['c'], segmentIds: ['c'],
        },
      ];
    },
  }));

  const result = await recall.recall(request);

  assert.deepEqual(result.facts, [{
    claim: '2013年入厂。',
    question: '王师傅什么时候入厂？',
    sourceMessageIds: ['a'],
  }]);
});

test('Realtime Retriever recall forwards AbortSignal to the adapter', async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const recall = new RetrieverRealtimeRecall(adapter({
    async searchTranscript(input) {
      receivedSignal = input.signal;
      return [];
    },
  }));

  await recall.recall(request, { signal: controller.signal });

  assert.equal(receivedSignal, controller.signal);
});
