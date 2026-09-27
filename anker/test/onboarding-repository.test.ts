import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { accounts, interviewSessions, users } from '../src/db/schema.js';
import { OnboardingRepository, OnboardingRepositoryError } from '../src/repositories/onboarding-repository.js';
import { TranscriptRepository } from '../src/repositories/domain-repositories.js';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'rensheng-onboarding-repository-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

function makeDatabase(userId = 'onboarding-user') {
  const directory = mkdtempSync(path.join(tempRoot, 'case-'));
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  runMigrations(connection);
  const now = '2026-09-14T00:00:00.000Z';
  connection.db.insert(accounts).values({
    accountId: `account-${userId}`,
    phone: null,
    phoneVerified: false,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }).run();
  connection.db.insert(users).values({ userId, accountId: `account-${userId}`, createdAt: now, updatedAt: now }).run();
  connection.close();
  return { databasePath, userId };
}

test('additive migration adds the two missing Profile fields without changing existing Profile data', () => {
  const { databasePath, userId } = makeDatabase('migration-user');
  const connection = createDatabase(databasePath);
  try {
    const columns = (connection.sqlite.pragma('table_info(users)') as Array<{ name: string }>).map((column) => column.name);
    assert.ok(columns.includes('gender'));
    assert.ok(columns.includes('current_status'));
    const before = connection.db.select().from(users).where(eq(users.userId, userId)).get();
    assert.equal(before?.onboardingStatus, 'not_started');
    connection.db.update(users).set({ gender: '女性', currentStatus: '退休后在杭州生活' })
      .where(eq(users.userId, userId)).run();
    const updated = connection.db.select().from(users).where(eq(users.userId, userId)).get();
    assert.equal(updated?.gender, '女性');
    assert.equal(updated?.currentStatus, '退休后在杭州生活');
  } finally {
    connection.close();
  }
});

test('Onboarding session creation is owner-scoped and flips not_started to in_progress atomically', () => {
  const { databasePath, userId } = makeDatabase('session-user');
  const repository = new OnboardingRepository(databasePath);
  const created = repository.createInterviewSessionForUser(userId, 'qwen');
  assert.equal(created.provider, 'qwen');
  assert.ok(created.sessionId);
  assert.ok(created.startedAt);

  const connection = createDatabase(databasePath);
  try {
    const profile = connection.db.select().from(users).where(eq(users.userId, userId)).get();
    const session = connection.db.select().from(interviewSessions)
      .where(eq(interviewSessions.sessionId, created.sessionId)).get();
    assert.equal(profile?.onboardingStatus, 'in_progress');
    assert.equal(session?.userId, userId);
    assert.equal(session?.sessionType, 'onboarding');
    assert.equal(session?.stageId, null);
    assert.equal(session?.storyId, null);
    assert.equal(session?.status, 'active');
    assert.equal(session?.transcriptJson, '[]');
  } finally {
    connection.close();
  }

  assert.throws(
    () => repository.createInterviewSessionForUser(userId, 'stepfun'),
    (error: unknown) => error instanceof OnboardingRepositoryError && error.code === 'ONBOARDING_SESSION_ALREADY_ACTIVE',
  );
  const stateConnection = createDatabase(databasePath);
  try {
    const endedAt = '2026-09-14T00:01:00.000Z';
    stateConnection.db.update(interviewSessions).set({
      status: 'ended', closeoutStatus: 'processing', endedAt, updatedAt: endedAt,
    }).where(eq(interviewSessions.sessionId, created.sessionId)).run();
  } finally {
    stateConnection.close();
  }
  assert.throws(
    () => repository.createInterviewSessionForUser(userId, 'stepfun'),
    (error: unknown) => error instanceof OnboardingRepositoryError && error.code === 'ONBOARDING_CLOSEOUT_IN_PROGRESS',
  );
  assert.deepEqual(repository.getInterviewContextData('missing-user'), {
    profile: null,
    onboardingStatus: null,
    transcripts: [],
  });
});

test('interview context contains all owner-owned Onboarding transcripts and excludes other session types', () => {
  const { databasePath, userId } = makeDatabase('context-user');
  const repository = new OnboardingRepository(databasePath);
  const first = repository.createInterviewSessionForUser(userId, 'stepfun');
  const transcripts = new TranscriptRepository(databasePath);
  const firstMessage = transcripts.appendForSession(userId, first.sessionId, {
    role: 'user', text: '我小时候在南京长大。', provider: 'stepfun',
  });
  const connection = createDatabase(databasePath);
  try {
    const now = '2026-09-14T00:01:00.000Z';
    connection.db.update(interviewSessions).set({
      status: 'ended', endedAt: now, updatedAt: now,
    }).where(eq(interviewSessions.sessionId, first.sessionId)).run();
    connection.db.insert(interviewSessions).values({
      sessionId: 'story-session-context-test',
      userId,
      sessionType: 'story',
      storyId: null,
      stageId: null,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
  } finally {
    connection.close();
  }
  const context = repository.getInterviewContextData(userId);
  assert.equal(context.onboardingStatus, 'in_progress');
  assert.equal(context.profile?.userId, userId);
  assert.equal(context.transcripts.length, 1);
  assert.equal(context.transcripts[0]?.sessionId, first.sessionId);
  assert.equal(context.transcripts[0]?.messages[0]?.message_id, firstMessage.message_id);
});
