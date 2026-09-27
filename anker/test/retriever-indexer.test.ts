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
import { buildRetrieverIndexInput, RetrieverIndexService } from '../src/retriever/indexer.js';
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

function transcriptText(messages: Array<{
  message_id: string;
  role: 'assistant' | 'user';
  text: string;
}>): string {
  return buildRetrieverIndexInput({
    userId: 'user-1',
    sessionId: 'session-1',
    storyId: null,
    stageId: null,
    sessionType: 'story',
    sourceType: 'subject',
    endedAt: null,
    transcriptJson: JSON.stringify(messages.map((message) => ({
      ...message,
      timestamp: '2026-01-01T00:00:00.000Z',
      provider: 'test',
    }))),
  }).transcriptText;
}

test('Retriever indexes Q+A pairs with provenance only on each user answer', () => {
  const text = transcriptText([
    { message_id: 'question-1', role: 'assistant', text: '你第一次独自出远门是什么时候？' },
    { message_id: 'answer-1', role: 'user', text: '我第一次独自去北京是在2013年。' },
    { message_id: 'question-2', role: 'assistant', text: '之后去了哪里？' },
    { message_id: 'answer-2', role: 'user', text: '我后来去了上海。' },
  ]);

  assert.match(text, /\[segment_id=answer-1\]\[message_id=answer-1\]\[Q\+A\]/);
  assert.match(text, /Question \(context only\): 你第一次独自出远门是什么时候？/);
  assert.match(text, /Answer \(user-provided fact\): 我第一次独自去北京是在2013年。/);
  assert.match(text, /\[segment_id=answer-2\]\[message_id=answer-2\]\[Q\+A\]/);
  assert.match(text, /Question \(context only\): 之后去了哪里？/);
  assert.match(text, /Answer \(user-provided fact\): 我后来去了上海。/);
  assert.doesNotMatch(text, /\[segment_id=question-1\]|\[message_id=question-1\]/);
  assert.doesNotMatch(text, /\[segment_id=question-2\]|\[message_id=question-2\]/);
});

test('a user answer without an assistant question is indexed with an empty question', () => {
  const text = transcriptText([
    { message_id: 'answer-alone', role: 'user', text: '我第一次独自去北京是在2013年。' },
  ]);

  assert.match(text, /Question \(context only\): \nAnswer \(user-provided fact\): 我第一次独自去北京是在2013年。/);
  assert.match(text, /\[segment_id=answer-alone\]\[message_id=answer-alone\]/);
});

test('the nearest persisted assistant message is used when several questions precede an answer', () => {
  const text = transcriptText([
    { message_id: 'question-old', role: 'assistant', text: '较早的问题' },
    { message_id: 'question-nearest', role: 'assistant', text: '紧邻回答的问题' },
    { message_id: 'answer-nearest', role: 'user', text: '回答内容' },
  ]);

  assert.match(text, /Question \(context only\): 紧邻回答的问题/);
  assert.doesNotMatch(text, /较早的问题/);
});

test('partial status cannot be represented; indexing accepts schema-valid persisted messages only', () => {
  assert.throws(() => buildRetrieverIndexInput({
    userId: 'user-1',
    sessionId: 'session-1',
    storyId: null,
    stageId: null,
    sessionType: 'story',
    sourceType: 'subject',
    endedAt: null,
    transcriptJson: JSON.stringify([{
      message_id: 'partial-answer',
      role: 'user',
      text: '尚未完成的回答',
      timestamp: '2026-01-01T00:00:00.000Z',
      provider: 'test',
      status: 'partial',
    }]),
  }), /Session Transcript JSON is invalid/);
});

test('blank persisted user answers are skipped and do not carry a question forward', () => {
  const text = transcriptText([
    { message_id: 'question-for-blank', role: 'assistant', text: '这个问题没有有效回答' },
    { message_id: 'blank-answer', role: 'user', text: ' \n  ' },
    { message_id: 'answer-after-blank', role: 'user', text: '没有问题的有效回答' },
  ]);

  assert.doesNotMatch(text, /blank-answer|这个问题没有有效回答/);
  assert.match(text, /Question \(context only\): \nAnswer \(user-provided fact\): 没有问题的有效回答/);
});

test('long answers split into bounded chunks and repeat the same question on each chunk', () => {
  const answer = '答'.repeat(2500);
  const text = transcriptText([
    { message_id: 'long-question', role: 'assistant', text: '请详细讲讲。' },
    { message_id: 'long-answer', role: 'user', text: answer },
  ]);
  const chunks = (text.match(/Answer \(user-provided fact\): [^\n]*/gu) ?? [])
    .map((line) => line.slice('Answer (user-provided fact): '.length));

  assert.deepEqual(chunks.map((chunk) => Array.from(chunk).length), [320, 320, 320, 320, 320, 320, 320, 260]);
  assert.equal((text.match(/Question \(context only\): 请详细讲讲。/gu) ?? []).length, 8);
  assert.equal(chunks.join(''), answer);
  assert.equal((text.match(/\[segment_id=long-answer\]/gu) ?? []).length, 8);
});

test('a correcting answer is marked as fact while the possibly wrong question stays context', () => {
  const text = transcriptText([
    { message_id: 'question-wrong-fact', role: 'assistant', text: '你是2014年开始工作的，对吗？' },
    { message_id: 'answer-correction', role: 'user', text: '不是，我是2013年开始工作的。' },
  ]);

  assert.match(text, /Question \(context only\): 你是2014年开始工作的，对吗？/);
  assert.match(text, /Answer \(user-provided fact\): 不是，我是2013年开始工作的。/);
  assert.match(text, /\[segment_id=answer-correction\]\[message_id=answer-correction\]/);
  assert.doesNotMatch(text, /\[segment_id=question-wrong-fact\]|\[message_id=question-wrong-fact\]/);
});

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
