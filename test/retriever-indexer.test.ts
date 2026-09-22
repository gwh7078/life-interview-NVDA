import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { AgentToolTokenService } from '../agent/tools/token.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { retrieverIndexJobs } from '../src/db/schema.js';
import { createStoryInterviewCore } from '../src/interview/core.js';
import { endRealtimeInterviewSession } from '../src/interview/session.js';
import { TranscriptRepository } from '../src/repositories/domain-repositories.js';
import { RetrieverIndexService } from '../src/retriever/indexer.js';
import { RetrieverScriptGateway } from '../src/retriever/script-gateway.js';
import type { RetrieverAdapter, RetrieverIndexInput, RetrieverRequestOptions } from '../src/retriever/types.js';

const tempDirectories: string[] = [];

after(() => {
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.resolve('data/test-tmp/retriever-'));
  tempDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  runMigrations(connection);
  seedDatabase(connection);
  connection.close();

  const core = createStoryInterviewCore(databasePath);
  const session = core.start(seedIds.user, core.prepare(seedIds.user, {
    mode: 'continue',
    storyId: seedIds.firstProject,
  }), 'qwen');
  const message = new TranscriptRepository(databasePath).appendForSession(seedIds.user, session.sessionId, {
    role: 'user',
    text: '我在2013年春节以后第一次独自去北京工作。',
    provider: 'qwen',
    providerMessageId: 'retriever-test-message',
  });
  assert.equal(endRealtimeInterviewSession(databasePath, seedIds.user, session.sessionId), 1);
  return { databasePath, sessionId: session.sessionId, messageId: message.message_id };
}

function fakeAdapter(options: {
  fail?: boolean;
  onIndex?: (input: RetrieverIndexInput) => void;
  onDelete?: (sessionId: string, options?: RetrieverRequestOptions) => void;
} = {}): RetrieverAdapter & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async indexSessionTranscript(input) {
      calls += 1;
      options.onIndex?.(input);
      if (options.fail) throw Object.assign(new Error('retriever offline'), { code: 'RETRIEVER_NETWORK_ERROR' });
      return { jobId: `job-${calls}`, documentId: `document-${calls}`, status: 'accepted' };
    },
    async searchTranscript() { return []; },
    async deleteSessionTranscript(sessionId, requestOptions) {
      options.onDelete?.(sessionId, requestOptions);
      return { documentId: sessionId, status: 'deleted' };
    },
    async getIndexStatus(sessionId) { return { documentId: sessionId, status: 'completed' }; },
  };
}

test('Transcript remains persisted, indexing is traceable, and the same content is idempotent', async () => {
  const input = fixture();
  let indexedText = '';
  const adapter = fakeAdapter({ onIndex: (value) => { indexedText = value.transcriptText; } });
  const service = new RetrieverIndexService(input.databasePath, adapter);

  const first = await service.indexSessionTranscript(seedIds.user, input.sessionId);
  const second = await service.indexSessionTranscript(seedIds.user, input.sessionId);
  assert.equal(first.status, 'indexed');
  assert.equal(second.status, 'indexed');
  assert.equal(adapter.calls, 1);
  assert.match(indexedText, new RegExp(`message_id=${input.messageId}`));
  assert.match(indexedText, /2013年春节以后/);

  const connection = createDatabase(input.databasePath);
  try {
    const job = connection.db.select().from(retrieverIndexJobs)
      .where(eq(retrieverIndexJobs.sessionId, input.sessionId)).get();
    assert.equal(job?.status, 'indexed');
    assert.equal(job?.attemptCount, 1);
    assert.equal(job?.retrieverDocumentId, 'document-1');
  } finally {
    connection.close();
  }
});

test('Retriever failure is recorded and an explicit retry can succeed without touching the Transcript', async () => {
  const input = fixture();
  const failing = fakeAdapter({ fail: true });
  const failed = await new RetrieverIndexService(input.databasePath, failing)
    .indexSessionTranscript(seedIds.user, input.sessionId);
  assert.equal(failed.status, 'failed');

  const successful = fakeAdapter();
  const retried = await new RetrieverIndexService(input.databasePath, successful)
    .retrySessionTranscript(seedIds.user, input.sessionId);
  assert.equal(retried.status, 'indexed');
  assert.equal(successful.calls, 1);

  const connection = createDatabase(input.databasePath);
  try {
    const session = connection.sqlite.prepare(
      'SELECT transcript_json AS transcriptJson FROM interview_sessions WHERE session_id = ?',
    ).get(input.sessionId) as { transcriptJson: string };
    assert.match(session.transcriptJson, /2013年春节以后/);
    const job = connection.db.select().from(retrieverIndexJobs)
      .where(eq(retrieverIndexJobs.sessionId, input.sessionId)).get();
    assert.equal(job?.status, 'indexed');
    assert.equal(job?.attemptCount, 2);
  } finally {
    connection.close();
  }
});

test('accepted uploads stay indexing until a later status refresh confirms completion', async () => {
  const input = fixture();
  let statusCalls = 0;
  const adapter = fakeAdapter();
  adapter.getIndexStatus = async () => {
    statusCalls += 1;
    return {
      jobId: 'job-1',
      documentId: 'document-1',
      status: statusCalls === 1 ? 'processing' : 'completed',
    };
  };
  const service = new RetrieverIndexService(input.databasePath, adapter);

  const queued = await service.indexSessionTranscript(seedIds.user, input.sessionId);
  assert.equal(queued.status, 'indexing');
  assert.equal(service.getIndexStatus(seedIds.user, input.sessionId)?.status, 'indexing');

  const settled = await service.waitForIndex(seedIds.user, input.sessionId, { pollIntervalMs: 1, timeoutMs: 100 });
  assert.equal(settled?.status, 'indexed');
  assert.equal(service.getIndexStatus(seedIds.user, input.sessionId)?.status, 'indexed');
  assert.equal(statusCalls, 2);
});

test('forced reindex deletes the persisted remote document before creating its replacement', async () => {
  const input = fixture();
  let deleted: { sessionId: string; documentId?: string; jobId?: string } | undefined;
  const adapter = fakeAdapter({
    onDelete: (sessionId, options) => {
      deleted = {
        sessionId,
        documentId: options?.reference?.documentId,
        jobId: options?.reference?.jobId,
      };
    },
  });
  const service = new RetrieverIndexService(input.databasePath, adapter);

  await service.indexSessionTranscript(seedIds.user, input.sessionId);
  await service.retrySessionTranscript(seedIds.user, input.sessionId);

  assert.deepEqual(deleted, {
    sessionId: input.sessionId,
    documentId: 'document-1',
    jobId: 'job-1',
  });
  assert.equal(service.getIndexStatus(seedIds.user, input.sessionId)?.retrieverDocumentId, 'document-2');
});

test('a terminal remote failure is persisted as failed instead of remaining indexing', async () => {
  const input = fixture();
  const adapter = fakeAdapter();
  adapter.indexSessionTranscript = async () => ({
    jobId: 'job-failed',
    documentId: 'document-failed',
    status: 'failed',
  });
  const result = await new RetrieverIndexService(input.databasePath, adapter)
    .indexSessionTranscript(seedIds.user, input.sessionId);

  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'RETRIEVER_REMOTE_FAILED');
  const connection = createDatabase(input.databasePath);
  try {
    const job = connection.db.select().from(retrieverIndexJobs)
      .where(eq(retrieverIndexJobs.sessionId, input.sessionId)).get();
    assert.equal(job?.status, 'failed');
    assert.equal(job?.retrieverJobId, 'job-failed');
    assert.equal(job?.retrieverDocumentId, 'document-failed');
  } finally {
    connection.close();
  }
});

test('memory-search gateway derives owner and Story scope from the signed token', async () => {
  const secret = 'retriever-test-secret-012345678901234567890';
  const tokenService = new AgentToolTokenService(secret);
  let received: { ownerId?: string; storyId?: string; sourceType?: string } = {};
  const adapter = fakeAdapter();
  adapter.searchTranscript = async (input) => {
    received = { ownerId: input.ownerId, storyId: input.storyId, sourceType: input.sourceType };
    return [{
      text: '历史原话', score: 0.9, ownerId: input.ownerId, storyId: input.storyId ?? null,
      sourceType: 'subject',
      sessionId: 'session-1', messageIds: ['message-1'], segmentIds: [],
    }, {
      text: '不属于当前 Story 的结果', score: 0.99, ownerId: input.ownerId, storyId: 'other-story',
      sourceType: 'subject',
      sessionId: 'other-session', messageIds: ['other-message'], segmentIds: [],
    }, {
      text: '不属于当前用户的结果', score: 0.98, ownerId: 'other-owner', storyId: input.storyId ?? null,
      sourceType: 'subject',
      sessionId: 'other-owner-session', messageIds: ['other-owner-message'], segmentIds: [],
    }, {
      text: '贡献者结果', score: 0.97, ownerId: input.ownerId, storyId: input.storyId ?? null,
      sourceType: 'external_contributor',
      sessionId: 'contributor-session', messageIds: ['contributor-message'], segmentIds: [],
    }];
  };
  const gateway = new RetrieverScriptGateway(adapter, tokenService);
  const token = tokenService.issue({
    runId: 'run-1', userId: 'owner-1', tool: 'memory_search',
    resourceType: 'story', resourceId: 'story-1', ttlMs: 60_000,
  });
  const result = await gateway.memorySearch(token, { query: '北京工作' });
  assert.equal(result.matches[0]?.text, '历史原话');
  assert.equal(result.matches.length, 1);
  assert.deepEqual(received, { ownerId: 'owner-1', storyId: 'story-1', sourceType: 'subject' });
  await assert.rejects(gateway.memorySearch('invalid-token', { query: '北京工作' }), /token/i);
});
