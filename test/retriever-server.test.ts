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
import { EvidenceSearchGateway, RetrieverScriptGateway } from '../src/retriever/script-gateway.js';
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

test('internal evidence-search route enforces signed source scope and returns bounded provenance', async () => {
  const directory = mkdtempSync(path.resolve('data/test-tmp/evidence-search-server-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  runMigrations(connection);
  seedDatabase(connection);
  connection.close();

  const secret = 'evidence-search-server-test-secret-012345678901234567890';
  const tokenService = new AgentToolTokenService(secret);
  let received: { ownerId: string; storyId?: string; sourceType?: string } | undefined;
  const adapter: RetrieverAdapter = {
    async indexSessionTranscript() { return { status: 'accepted' }; },
    async searchTranscript(input) {
      received = { ownerId: input.ownerId, storyId: input.storyId, sourceType: input.sourceType };
      return [{
        text: 'user_id: hidden-owner\nsession_id: hidden-session\nstory_id: hidden-story\n历史原话：正式日期为7月15日。',
        score: 0.9,
        ownerId: input.ownerId,
        storyId: input.storyId ?? null,
        sourceType: 'subject',
        sessionId: 'session-1',
        messageIds: ['message-1'],
        segmentIds: ['segment-1'],
      }];
    },
    async deleteSessionTranscript(sessionId) { return { documentId: sessionId, status: 'deleted' }; },
    async getIndexStatus(sessionId) { return { documentId: sessionId, status: 'completed' }; },
  };
  const gateway = new EvidenceSearchGateway({ retriever: adapter, tokenService, databasePath });
  const server = createInterviewServiceServer({
    host: '127.0.0.1', port: 0, databasePath, apiKey: '', workspaceId: '', region: 'cn-beijing',
    model: 'test-model', developmentAuthEnabled: true,
  }, { evidenceSearchGateway: gateway });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const runId = 'run-evidence-search';
  const token = tokenService.issue({
    runId,
    userId: seedIds.user,
    tool: 'evidence_search',
    resourceType: 'agent_evidence_search',
    resourceId: runId,
    evidenceSearch: {
      task: 'story.completion',
      skill: 'story-completion',
      allowedSourceTypes: ['owner_transcript'],
      storyId: seedIds.firstProject,
    },
    ttlMs: 60_000,
  });

  try {
    const unauthorized = await fetch(`${baseUrl}/internal/agent-retrieval/evidence-search`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '高考日期', source_types: ['owner_transcript'] }),
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${baseUrl}/internal/agent-retrieval/evidence-search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '高考日期', source_types: ['owner_transcript'], top_k: 5 }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      evidence: Array<Record<string, unknown>>;
      retrieval: { status: string; result_count: number; query_chars: number; timeout: boolean };
    };
    assert.equal(body.evidence.length, 1);
    assert.equal(body.evidence[0]?.source_type, 'owner_transcript');
    assert.equal(body.evidence[0]?.story_ref, seedIds.firstProject);
    assert.equal(body.evidence[0]?.source_ref, 'session-1');
    assert.deepEqual(body.evidence[0]?.message_refs, ['message-1']);
    assert.equal(/hidden-owner|hidden-session|hidden-story/u.test(String(body.evidence[0]?.text)), false);
    assert.equal(body.retrieval.status, 'ok');
    assert.equal(body.retrieval.result_count, 1);
    assert.equal(body.retrieval.query_chars, 4);
    assert.equal(body.retrieval.timeout, false);
    assert.deepEqual(received, { ownerId: seedIds.user, storyId: seedIds.firstProject, sourceType: 'subject' });

    const expanded = await fetch(`${baseUrl}/internal/agent-retrieval/evidence-search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '高考日期', source_types: ['contributor_transcript'] }),
    });
    assert.equal(expanded.status, 403);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
