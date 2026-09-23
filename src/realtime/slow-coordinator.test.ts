import assert from 'node:assert/strict';
import test from 'node:test';
import { RetrieverClientError } from '../retriever/client.js';
import {
  RealtimeSlowCoordinator,
  UnavailableRealtimeRecall,
  type RealtimeRecallPort,
} from './slow-coordinator.js';

const request = {
  ownerId: 'user-1',
  sessionId: 'session-1',
  storyId: 'story-1',
  turnId: 'turn-1',
  contextVersion: 1,
  query: '确认王师傅和我的关系',
};

test('unavailable production fallback returns no semantic facts', async () => {
  const result = await new UnavailableRealtimeRecall().recall(request);
  assert.deepEqual(result, {
    basedOnTurnId: 'turn-1',
    facts: [],
    possibleConflicts: [],
    interviewHints: [],
  });
});

test('slow coordinator returns a completed hint', async () => {
  const port: RealtimeRecallPort = {
    async recall(input) {
      return {
        basedOnTurnId: input.turnId,
        facts: [],
        possibleConflicts: [],
        interviewHints: [],
      };
    },
  };
  const result = await new RealtimeSlowCoordinator(port, 100).run(request);
  assert.equal(result.status, 'completed');
  assert.equal(result.hint?.basedOnTurnId, 'turn-1');
});

test('slow coordinator times out and aborts the recall', async () => {
  let aborted = false;
  const port: RealtimeRecallPort = {
    async recall(_input, options) {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
      throw new Error('aborted by coordinator');
    },
  };
  const result = await new RealtimeSlowCoordinator(port, 10).run(request);
  assert.equal(result.status, 'timeout');
  assert.equal(result.errorCode, 'REALTIME_RECALL_TIMEOUT');
  assert.equal(aborted, true);
});

test('slow coordinator preserves stable Retriever error codes', async () => {
  const port: RealtimeRecallPort = {
    async recall() {
      throw new RetrieverClientError('Retriever request failed.', 'RETRIEVER_HTTP_ERROR', 503, true);
    },
  };
  const result = await new RealtimeSlowCoordinator(port, 100).run(request);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'RETRIEVER_HTTP_ERROR');
});

test('a newer turn makes the older recall stale', async () => {
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let callCount = 0;
  const port: RealtimeRecallPort = {
    async recall(input, options) {
      callCount += 1;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        releaseFirst();
      }
      return {
        basedOnTurnId: input.turnId,
        facts: [],
        possibleConflicts: [],
        interviewHints: [],
      };
    },
  };
  const coordinator = new RealtimeSlowCoordinator(port, 100);
  const first = coordinator.run(request);
  const second = coordinator.run({ ...request, turnId: 'turn-2', contextVersion: 2 });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  await firstReleased;
  assert.equal(firstResult.status, 'stale');
  assert.equal(secondResult.status, 'completed');
});
