import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { migrationsFolder, runMigrations } from '../src/db/migrate.js';
import { accounts, interviewSessions, lifeStages, memoirDocuments, stories, users } from '../src/db/schema.js';
import { parseTranscript, serializeTranscript } from '../src/db/transcript.js';

const temporaryDirectories: string[] = [];
const directory = path.dirname(fileURLToPath(import.meta.url));
const testTempRoot = path.resolve('data/test-tmp');
mkdirSync(testTempRoot, { recursive: true });

function applyPreAccountMigrations(connection: DatabaseHandle, migrationHash: string): void {
  for (const filename of [
    '0000_glossy_maverick.sql',
    '0001_add_transcript.sql',
    '0002_story_summary_closeout.sql',
    '0003_session_provider.sql',
  ]) {
    const sql = readFileSync(path.join(migrationsFolder, filename), 'utf8').replace(/--> statement-breakpoint/g, '\n');
    connection.sqlite.exec(sql);
  }
  connection.sqlite.exec(`
    CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric);
    INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${migrationHash}', 1789285981000);
  `);
}

function withDatabase(callback: (connection: DatabaseHandle) => void): void {
  const tempDirectory = mkdtempSync(path.join(testTempRoot, 'rensheng-db-test-'));
  temporaryDirectories.push(tempDirectory);
  const connection = createDatabase(path.join(tempDirectory, 'memoir.db'));
  try {
    runMigrations(connection);
    callback(connection);
  } finally {
    connection.close();
  }
}

function baseUser(userId = '10000000-0000-4000-8000-000000000001') {
  const timestamp = '2026-09-11T08:30:00.000Z';
  return { userId, accountId: '10000000-0000-4000-8000-000000000000', name: '测试用户', createdAt: timestamp, updatedAt: timestamp };
}

function insertAccount(db: DatabaseHandle['db'], user: ReturnType<typeof baseUser>) {
  db.insert(accounts).values({
    accountId: user.accountId,
    phone: null,
    phoneVerified: false,
    status: 'legacy',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }).run();
}

function baseStage(userId: string, stageId = '10000000-0000-4000-8000-000000000002') {
  const timestamp = '2026-09-11T08:30:00.000Z';
  return { stageId, userId, title: '测试阶段', sortOrder: 1, createdAt: timestamp, updatedAt: timestamp };
}

function baseStory(userId: string, stageId: string, storyId = '10000000-0000-4000-8000-000000000003') {
  const timestamp = '2026-09-11T08:30:00.000Z';
  return { storyId, userId, stageId, title: '测试故事', summary: '初始摘要', agentMemory: '初始摘要', createdAt: timestamp, updatedAt: timestamp };
}

test('Story and Session foreign keys preserve the existing relational model', () => {
  withDatabase(({ db }) => {
    const user = baseUser();
    const stage = baseStage(user.userId);
    const story = baseStory(user.userId, stage.stageId);
    insertAccount(db, user);
    db.insert(users).values(user).run();
    db.insert(lifeStages).values(stage).run();
    db.insert(stories).values(story).run();
    assert.throws(
      () => db.insert(stories).values(baseStory(user.userId, 'missing-stage', 'missing-story')).run(),
      /FOREIGN KEY constraint failed/,
    );
    db.insert(interviewSessions).values({
      sessionId: '10000000-0000-4000-8000-000000000004',
      provider: 'doubao',
      userId: user.userId,
      stageId: stage.stageId,
      storyId: story.storyId,
      sessionType: 'story',
      startedAt: '2026-09-11T08:30:00.000Z',
      createdAt: '2026-09-11T08:30:00.000Z',
      updatedAt: '2026-09-11T08:30:00.000Z',
    }).run();
    const saved = db.select().from(interviewSessions).get();
    assert.equal(saved?.provider, 'doubao');
    assert.equal(saved?.storyId, story.storyId);
    assert.equal(saved?.transcriptJson, '[]');
  });
});

test('Transcript JSON validates and round-trips independently from the Story summary', () => {
  const transcript = [{
    message_id: 'msg_user_1', role: 'user' as const, text: '大约在2019年春天搬到上海。',
    timestamp: '2026-09-11T08:30:00.000Z', provider: 'test' as const,
  }];
  assert.deepEqual(parseTranscript(serializeTranscript(transcript)), transcript);
  assert.throws(() => serializeTranscript([{ ...transcript[0], role: 'system' }]));
});

test('Deleting a user cascades through stages, stories, sessions, and memoir documents', () => {
  withDatabase(({ db }) => {
    const user = baseUser();
    const stage = baseStage(user.userId);
    const story = baseStory(user.userId, stage.stageId);
    insertAccount(db, user);
    db.insert(users).values(user).run();
    db.insert(lifeStages).values(stage).run();
    db.insert(stories).values(story).run();
    db.insert(interviewSessions).values({
      sessionId: '10000000-0000-4000-8000-000000000004',
      provider: 'doubao', userId: user.userId,
      stageId: stage.stageId, storyId: story.storyId, sessionType: 'story',
      startedAt: '2026-09-11T08:30:00.000Z', createdAt: '2026-09-11T08:30:00.000Z', updatedAt: '2026-09-11T08:30:00.000Z',
    }).run();
    db.insert(memoirDocuments).values({
      documentId: '10000000-0000-4000-8000-000000000006', userId: user.userId,
      scopeType: 'story', scopeId: story.storyId, title: '测试文稿', content: '测试内容',
      createdAt: '2026-09-11T08:30:00.000Z', updatedAt: '2026-09-11T08:30:00.000Z',
    }).run();
    db.delete(users).where(eq(users.userId, user.userId)).run();
    assert.equal(db.select().from(lifeStages).all().length, 0);
    assert.equal(db.select().from(stories).all().length, 0);
    assert.equal(db.select().from(interviewSessions).all().length, 0);
    assert.equal(db.select().from(memoirDocuments).all().length, 0);
  });
});

test('Migration merges both legacy summary fields and preserves every Session transcript and Story link', () => {
  const tempDirectory = mkdtempSync(path.join(testTempRoot, 'rensheng-legacy-migration-test-'));
  temporaryDirectories.push(tempDirectory);
  const connection = createDatabase(path.join(tempDirectory, 'legacy.db'));
  try {
    const legacyRoot = path.join(migrationsFolder);
    for (const filename of ['0000_glossy_maverick.sql', '0001_add_transcript.sql']) {
      const sql = readFileSync(path.join(legacyRoot, filename), 'utf8').replace(/--> statement-breakpoint/g, '\n');
      connection.sqlite.exec(sql);
    }
    connection.sqlite.exec(`
      CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric);
      INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('legacy', 1789179000000);
    `);
    connection.sqlite.prepare('INSERT INTO users (user_id, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('legacy-user', '迁移用户', '138 0013 8000', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
    connection.sqlite.prepare('INSERT INTO life_stages (stage_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('legacy-stage', 'legacy-user', '人生阶段', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
    connection.sqlite.prepare(`INSERT INTO stories
      (story_id, user_id, stage_id, title, short_summary, story_state_json, completeness, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-story', 'legacy-user', 'legacy-stage', '旧故事', '旧短摘要', JSON.stringify({ summary: '详细 Story State 摘要', people: [{ name: '应被移除的冗余字段' }] }), 72, 'mostly_complete', 5, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
    const transcript = JSON.stringify([{
      message_id: 'legacy-user-message', role: 'user', text: '用户原话必须保留。',
      timestamp: '2026-09-12T00:10:00.000Z', provider: 'test',
    }]);
    connection.sqlite.prepare(`INSERT INTO interview_sessions
      (session_id, openclaw_session_key, user_id, stage_id, story_id, session_type, status, closeout_status, session_summary, transcript_json, closeout_result_json, started_at, ended_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-session', 'legacy-key', 'legacy-user', 'legacy-stage', 'legacy-story', 'story', 'completed', 'completed', '旧的冗余会话摘要', transcript,
        JSON.stringify({ previous_story_state: {}, new_story_state: {}, changes: [], conflicts: [], new_story_candidates: [], model_metadata: { model: 'old-model' } }),
        '2026-09-12T00:00:00.000Z', '2026-09-12T00:10:00.000Z', '2026-09-12T00:00:00.000Z', '2026-09-12T00:10:00.000Z');
    connection.sqlite.prepare(`INSERT INTO story_candidates (candidate_id, user_id, source_session_id, suggested_title, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run('legacy-candidate', 'legacy-user', 'legacy-session', '旧候选', '2026-09-12T00:10:00.000Z');

    runMigrations(connection);
    const story = connection.db.select().from(stories).where(eq(stories.storyId, 'legacy-story')).get();
    const session = connection.db.select().from(interviewSessions).where(eq(interviewSessions.sessionId, 'legacy-session')).get();
    assert.equal(story?.summary, '旧短摘要\n\n详细 Story State 摘要');
    assert.equal(story?.agentMemory, '旧短摘要\n\n详细 Story State 摘要');
    assert.equal(story?.status, 'interviewing');
    assert.equal(session?.storyId, 'legacy-story');
    assert.equal(session?.provider, 'openclaw');
    assert.equal(session?.providerSessionId, 'legacy-key');
    assert.equal(session?.stageId, null);
    assert.deepEqual(parseTranscript(session?.transcriptJson), JSON.parse(transcript));
    assert.deepEqual(JSON.parse(session?.closeoutResultJson ?? '{}'), { model_metadata: { model: 'old-model' } });
    const storyColumns = (connection.sqlite.pragma('table_info(stories)') as Array<{ name: string }>).map((column) => column.name);
    const sessionColumns = (connection.sqlite.pragma('table_info(interview_sessions)') as Array<{ name: string }>).map((column) => column.name);
    assert.ok(storyColumns.includes('summary'));
    assert.ok(storyColumns.includes('agent_memory'));
    assert.ok(!storyColumns.some((column) => ['short_summary', 'story_state_json', 'completeness', 'priority'].includes(column)));
    assert.ok(!sessionColumns.includes('session_summary'));
    assert.ok(sessionColumns.includes('provider'));
    assert.ok(!sessionColumns.includes('openclaw_session_key'));
    assert.ok(sessionColumns.includes('provider_session_id'));
    const account = connection.db.select().from(accounts).get();
    const migratedUser = connection.db.select().from(users).get();
    assert.equal(account?.phone, '+8613800138000');
    assert.equal(account?.phoneVerified, false);
    assert.equal(migratedUser?.accountId, account?.accountId);
    assert.equal((connection.sqlite.pragma('table_info(users)') as Array<{ name: string }>).some((column) => column.name === 'phone'), false);
    assert.equal(connection.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'story_candidates'").get(), undefined);
    assert.deepEqual(connection.sqlite.pragma('foreign_key_check'), []);
  } finally {
    connection.close();
  }
});

test('Migration from the current pre-Account schema preserves Profile, Story, Session, Transcript, and Document data', () => {
  const tempDirectory = mkdtempSync(path.join(testTempRoot, 'rensheng-account-upgrade-test-'));
  temporaryDirectories.push(tempDirectory);
  const connection = createDatabase(path.join(tempDirectory, 'pre-account.db'));
  try {
    applyPreAccountMigrations(connection, 'pre-account');
    connection.sqlite.prepare(`INSERT INTO users
      (user_id, name, phone, email, birth_date, birth_place, current_location, occupation_summary, family_summary,
       profile_summary, extra_profile_json, onboarding_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('upgrade-user', '迁移前姓名', '+86 138-0013-8000', 'legacy@example.test', '1988', '南京', '杭州',
        '教师', '有两个孩子', '个人摘要原文', JSON.stringify({ preserved: true }), 'in_progress',
        '2026-09-10T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
    connection.sqlite.prepare(`INSERT INTO life_stages
      (stage_id, user_id, title, start_date, end_date, date_precision, summary, sort_order, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('upgrade-stage', 'upgrade-user', '迁移前阶段', '2001', '2010', 'year', '阶段摘要原文', 4, 'active',
        '2026-09-10T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
    connection.sqlite.prepare(`INSERT INTO stories
      (story_id, user_id, stage_id, title, summary, status, created_source_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('upgrade-story', 'upgrade-user', 'upgrade-stage', '迁移前故事', '故事摘要原文', 'interviewing', 'upgrade-session',
        '2026-09-10T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
    const transcript = [{
      message_id: 'upgrade-message', role: 'user', text: '这句原始回忆必须逐字保留。',
      timestamp: '2026-09-12T00:10:00.000Z', provider: 'qwen',
    }];
    const closeout = { model_metadata: { model: 'historical-model', response_id: 'old-response' } };
    connection.sqlite.prepare(`INSERT INTO interview_sessions
      (session_id, provider, user_id, stage_id, story_id, session_type, status, closeout_status, transcript_json,
       closeout_result_json, started_at, ended_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('upgrade-session', 'qwen', 'upgrade-user', 'upgrade-stage', 'upgrade-story', 'story', 'completed', 'completed',
        JSON.stringify(transcript), JSON.stringify(closeout), '2026-09-12T00:00:00.000Z', '2026-09-12T00:10:00.000Z',
        '2026-09-12T00:00:00.000Z', '2026-09-12T00:10:00.000Z');
    const documentSource = { message_ids: ['upgrade-message'], model: 'writer-v1' };
    connection.sqlite.prepare(`INSERT INTO memoir_documents
      (document_id, user_id, scope_type, scope_id, title, content, version_number, status, source_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('upgrade-document', 'upgrade-user', 'story', 'upgrade-story', '迁移前文稿', '文稿内容原文', 3, 'approved',
        JSON.stringify(documentSource), '2026-09-10T00:00:00.000Z', '2026-09-12T00:00:00.000Z');

    runMigrations(connection);

    const migratedAccount = connection.db.select().from(accounts).get();
    const migratedUser = connection.db.select().from(users).get();
    const migratedStage = connection.db.select().from(lifeStages).get();
    const migratedStory = connection.db.select().from(stories).get();
    const migratedSession = connection.db.select().from(interviewSessions).get();
    const migratedDocument = connection.db.select().from(memoirDocuments).get();
    assert.equal(migratedAccount?.phone, '+8613800138000');
    assert.equal(migratedAccount?.phoneVerified, false);
    assert.equal(migratedAccount?.status, 'active');
    assert.equal(migratedUser?.accountId, migratedAccount?.accountId);
    assert.equal(migratedUser?.name, '迁移前姓名');
    assert.equal(migratedUser?.email, 'legacy@example.test');
    assert.equal(migratedUser?.profileSummary, '个人摘要原文');
    assert.equal(migratedUser?.onboardingStatus, 'in_progress');
    assert.equal(migratedStage?.summary, '阶段摘要原文');
    assert.equal(migratedStage?.sortOrder, 4);
    assert.equal(migratedStory?.summary, '故事摘要原文');
    assert.equal(migratedStory?.agentMemory, '故事摘要原文');
    assert.equal(migratedStory?.status, 'interviewing');
    assert.equal(migratedSession?.provider, 'qwen');
    assert.equal(migratedSession?.providerSessionId, null);
    assert.equal(migratedSession?.storyId, 'upgrade-story');
    assert.equal(migratedSession?.stageId, null);
    assert.deepEqual(parseTranscript(migratedSession?.transcriptJson), transcript);
    assert.deepEqual(JSON.parse(migratedSession?.closeoutResultJson ?? '{}'), closeout);
    assert.equal(migratedDocument?.content, '文稿内容原文');
    assert.equal(migratedDocument?.versionNumber, 3);
    assert.deepEqual(JSON.parse(migratedDocument?.sourceJson ?? '{}'), documentSource);
    const usersColumns = connection.sqlite.pragma('table_info(users)') as Array<{ name: string; notnull: number }>;
    assert.ok(!usersColumns.some((column) => column.name === 'phone'));
    assert.equal(usersColumns.find((column) => column.name === 'name')?.notnull, 0);
    assert.throws(() => connection.db.delete(lifeStages).where(eq(lifeStages.stageId, 'upgrade-stage')).run(), /FOREIGN KEY constraint failed/);
    assert.deepEqual(connection.sqlite.pragma('foreign_key_check'), []);
    const integrity = connection.sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
    assert.deepEqual(integrity, [{ integrity_check: 'ok' }]);
  } finally {
    connection.close();
  }
});

test('Migration refuses unsafe duplicate legacy phones before changing the old Profile table', () => {
  const tempDirectory = mkdtempSync(path.join(testTempRoot, 'rensheng-account-duplicate-phone-test-'));
  temporaryDirectories.push(tempDirectory);
  const connection = createDatabase(path.join(tempDirectory, 'duplicate-phone.db'));
  try {
    for (const filename of ['0000_glossy_maverick.sql', '0001_add_transcript.sql']) {
      const sql = readFileSync(path.join(migrationsFolder, filename), 'utf8').replace(/--> statement-breakpoint/g, '\n');
      connection.sqlite.exec(sql);
    }
    connection.sqlite.exec(`
      CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric);
      INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('duplicate-phone', 1789179000000);
    `);
    const insertUser = connection.sqlite.prepare(
      'INSERT INTO users (user_id, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    insertUser.run('duplicate-user-a', '用户 A', '13800138000', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
    insertUser.run('duplicate-user-b', '用户 B', '+86 138-0013-8000', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');

    assert.throws(() => runMigrations(connection), /multiple legacy profiles normalize to the same phone/);
    assert.ok((connection.sqlite.pragma('table_info(users)') as Array<{ name: string }>).some((column) => column.name === 'phone'));
    assert.equal(connection.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get(), undefined);
    assert.equal(connection.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__codex_user_account_backfill'").get(), undefined);
    assert.deepEqual(connection.sqlite.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    connection.close();
  }
});

test('Migration stops before mutation when legacy memoir documents target a LifeStage', () => {
  const tempDirectory = mkdtempSync(path.join(testTempRoot, 'rensheng-account-stage-document-test-'));
  temporaryDirectories.push(tempDirectory);
  const connection = createDatabase(path.join(tempDirectory, 'stage-document.db'));
  try {
    applyPreAccountMigrations(connection, 'stage-document');
    connection.sqlite.prepare('INSERT INTO users (user_id, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('stage-document-user', '阶段文稿用户', null, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
    connection.sqlite.prepare(`INSERT INTO memoir_documents
      (document_id, user_id, scope_type, scope_id, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('stage-document', 'stage-document-user', 'life_stage', 'legacy-stage', '旧阶段文稿', '需明确迁移范围',
        '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');

    assert.throws(() => runMigrations(connection), /LifeStage-scoped memoir documents exist/);
    const documentCount = connection.sqlite.prepare(
      "SELECT count(*) AS count FROM memoir_documents WHERE scope_type='life_stage'",
    ).get() as { count: number };
    assert.equal(documentCount.count, 1);
    assert.ok((connection.sqlite.pragma('table_info(users)') as Array<{ name: string }>).some((column) => column.name === 'phone'));
    assert.equal(connection.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get(), undefined);
    assert.deepEqual(connection.sqlite.pragma('foreign_key_check'), []);
  } finally {
    connection.close();
  }
});

after(() => {
  for (const tempDirectory of temporaryDirectories) rmSync(tempDirectory, { recursive: true, force: true });
});
