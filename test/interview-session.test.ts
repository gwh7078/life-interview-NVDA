import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { interviewSessions } from '../src/db/schema.js';
import { createStoryInterviewCore } from '../src/interview/core.js';
import { endRealtimeInterviewSession } from '../src/interview/session.js';
import { TranscriptRepository } from '../src/repositories/domain-repositories.js';

const temporaryDirectories: string[] = [];
const testTempRoot = path.resolve('data/test-tmp');
mkdirSync(testTempRoot, { recursive: true });

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

test('Existing Story Context opens provider-tagged Sessions and persists final Transcript through the repository', () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-interview-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  try {
    runMigrations(connection);
    seedDatabase(connection);
  } finally {
    connection.close();
  }

  const core = createStoryInterviewCore(databasePath);
  const context = core.prepare(seedIds.user, { mode: 'continue', storyId: seedIds.firstProject });
  assert.ok(context.story);
  assert.equal(context.story.title, '第一次独立负责跨团队项目');

  const session = core.start(seedIds.user, context, 'qwen');
  assert.match(session.sessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(session.provider, 'qwen');

  const stepfunSession = core.start(seedIds.user, context, 'stepfun');
  assert.equal(stepfunSession.provider, 'stepfun');
  const defaultSession = core.start(seedIds.user, context);
  assert.equal(defaultSession.provider, 'modelbest');
  const transcripts = new TranscriptRepository(databasePath);
  const stepfunMessage = transcripts.appendForSession(seedIds.user, stepfunSession.sessionId, {
    role: 'user',
    text: 'Step 实时识别出的最终字幕。',
    provider: 'stepfun',
    providerMessageId: 'stepfun-question-1',
  });
  assert.equal(stepfunMessage.provider, 'stepfun');
  assert.equal(endRealtimeInterviewSession(databasePath, seedIds.user, stepfunSession.sessionId), 1);

  const userMessage = transcripts.appendForSession(seedIds.user, session.sessionId, {
    role: 'user',
    text: '项目上线前，我最担心的是团队之间的信息没有对齐。',
    provider: 'qwen',
    providerMessageId: 'item-user-1',
  });
  const assistantMessage = transcripts.appendForSession(seedIds.user, session.sessionId, {
    role: 'assistant',
    text: '你当时是怎么发现这个问题的？',
    provider: 'qwen',
    providerMessageId: 'item-assistant-1',
  });
  assert.match(userMessage.message_id, /^msg_/);
  assert.match(assistantMessage.message_id, /^msg_/);

  assert.equal(endRealtimeInterviewSession(databasePath, seedIds.user, session.sessionId), 2);

  const verifyConnection = createDatabase(databasePath);
  try {
    const saved = verifyConnection.db.select().from(interviewSessions)
      .where(eq(interviewSessions.sessionId, session.sessionId)).get();
    assert.equal(saved?.status, 'ended');
    assert.equal(saved?.provider, 'qwen');
    assert.equal(saved?.stageId, null);
    const transcript = JSON.parse(saved?.transcriptJson ?? '[]') as Array<Record<string, unknown>>;
    assert.deepEqual(transcript.map((message) => message.role), ['user', 'assistant']);
    assert.deepEqual(transcript.map((message) => message.provider), ['qwen', 'qwen']);
    assert.deepEqual(transcript.map((message) => message.provider_message_id), ['item-user-1', 'item-assistant-1']);
    assert.equal(transcript[0]?.text, '项目上线前，我最担心的是团队之间的信息没有对齐。');
  } finally {
    verifyConnection.close();
  }
});

test('Story Strategy creates an unlinked Story Session scoped to the owned target Life Stage', () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-interview-create-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  try {
    runMigrations(connection);
    seedDatabase(connection);
  } finally {
    connection.close();
  }
  const core = createStoryInterviewCore(databasePath);
  const context = core.prepare(seedIds.user, { mode: 'create', stageId: seedIds.work, title: '新的工作经历' });
  assert.equal(context.story, null);
  const session = core.start(seedIds.user, context, 'qwen');
  const verify = createDatabase(databasePath);
  try {
    const saved = verify.db.select().from(interviewSessions).where(eq(interviewSessions.sessionId, session.sessionId)).get();
    assert.equal(saved?.sessionType, 'story');
    assert.equal(saved?.storyId, null);
    assert.equal(saved?.stageId, seedIds.work);
  } finally {
    verify.close();
  }
});
