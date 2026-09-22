import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentToolTokenService } from '../../agent/tools/token.js';
import { EraContextScriptGateway } from '../../src/era-context/script-gateway.js';

const secret = 'era-context-test-secret-012345678901234567890';
const tokenService = new AgentToolTokenService(secret);
const match = {
  start_year: 1999,
  end_year: 2002,
  category: '互联网' as const,
  title: '网吧和QQ逐渐普及',
  summary: '网吧和即时通信逐渐进入年轻人的日常生活。',
  score: 0.88,
};

test('era context gateway requires global signed capability and returns hint matches only', async () => {
  const gateway = new EraContextScriptGateway({
    async search(input) {
      assert.equal(input.query, '刚参加工作时的娱乐生活');
      return [match];
    },
  }, tokenService);
  const token = tokenService.issue({
    runId: 'run-era-1',
    userId: 'user-1',
    tool: 'era_context_search',
    resourceType: 'era_context',
    resourceId: 'global',
    ttlMs: 60_000,
  });

  assert.deepEqual(await gateway.search(token, {
    query: '刚参加工作时的娱乐生活',
    start_year: 1998,
    end_year: 2002,
  }), { matches: [match] });
});

test('era context gateway rejects a Story-scoped memory token', async () => {
  const gateway = new EraContextScriptGateway({ async search() { return []; } }, tokenService);
  const token = tokenService.issue({
    runId: 'run-memory-1',
    userId: 'user-1',
    tool: 'memory_search',
    resourceType: 'story',
    resourceId: 'story-1',
    ttlMs: 60_000,
  });

  await assert.rejects(
    gateway.search(token, { query: '北京', start_year: 2000, end_year: 2002 }),
    (error: unknown) => error instanceof Error && error.name === 'EraContextScriptError'
      && 'statusCode' in error && error.statusCode === 401,
  );
});

test('era context retrieval failure is converted to a safe unavailable error', async () => {
  const gateway = new EraContextScriptGateway({
    async search() { throw new Error('retriever offline'); },
  }, tokenService);
  const token = tokenService.issue({
    runId: 'run-era-2',
    userId: 'user-1',
    tool: 'era_context_search',
    resourceType: 'era_context',
    resourceId: 'global',
    ttlMs: 60_000,
  });

  await assert.rejects(
    gateway.search(token, { query: '北京', start_year: 2000, end_year: 2002 }),
    (error: unknown) => error instanceof Error && error.name === 'EraContextScriptError'
      && 'statusCode' in error && error.statusCode === 503,
  );
});
