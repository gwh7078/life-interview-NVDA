import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { after, test } from 'node:test';
import { AgentToolTokenService } from '../agent/tools/token.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { createInterviewServiceServer } from '../src/server.js';
import { RetrieverScriptGateway } from '../src/retriever/script-gateway.js';
import type { RetrieverAdapter } from '../src/retriever/types.js';

const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

test('internal memory-search route enforces the signed Story scope', async () => {
  const directory = mkdtempSync(path.resolve('data/test-tmp/retriever-server-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  runMigrations(connection);
  seedDatabase(connection);
  connection.close();

  const secret = 'retriever-server-test-secret-012345678901234567890';
  const tokenService = new AgentToolTokenService(secret);
  let received: { ownerId: string; storyId?: string; query: string } | undefined;
  const adapter: RetrieverAdapter = {
    async indexSessionTranscript() {
      return { status: 'accepted' };
    },
    async searchTranscript(input) {
      received = { ownerId: input.ownerId, storyId: input.storyId, query: input.query };
      return [{
        text: '历史原话',
        score: 0.9,
        ownerId: input.ownerId,
        storyId: input.storyId ?? null,
        sourceType: 'subject',
        sessionId: 'session-1',
        messageIds: ['message-1'],
        segmentIds: [],
      }];
    },
    async deleteSessionTranscript(sessionId) {
      return { documentId: sessionId, status: 'deleted' };
    },
    async getIndexStatus(sessionId) {
      return { documentId: sessionId, status: 'completed' };
    },
  };
  const gateway = new RetrieverScriptGateway(adapter, tokenService);
  const server = createInterviewServiceServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    apiKey: '',
    workspaceId: '',
    region: 'cn-beijing',
    model: 'test-model',
    developmentAuthEnabled: true,
  }, { retrieverScriptGateway: gateway });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = tokenService.issue({
    runId: 'run-1',
    userId: seedIds.user,
    tool: 'memory_search',
    resourceType: 'story',
    resourceId: seedIds.firstProject,
    ttlMs: 60_000,
  });

  try {
    const unauthorized = await fetch(`${baseUrl}/internal/agent-retrieval/memory-search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '北京工作' }),
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${baseUrl}/internal/agent-retrieval/memory-search`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: '北京工作' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      matches: [{
        text: '历史原话',
        score: 0.9,
        storyId: seedIds.firstProject,
        sessionId: 'session-1',
        messageIds: ['message-1'],
        segmentIds: [],
      }],
    });
    assert.deepEqual(received, {
      ownerId: seedIds.user,
      storyId: seedIds.firstProject,
      query: '北京工作',
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
});
