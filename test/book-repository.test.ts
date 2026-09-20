import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { accounts, lifeStages, memoirDocuments, stories, users } from '../src/db/schema.js';
import { BookRepository, BookRepositoryError } from '../src/repositories/book-repository.js';

const temporaryDirectories: string[] = [];
const testTempRoot = path.resolve('data/test-tmp');
mkdirSync(testTempRoot, { recursive: true });

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function seedBookFixture(databasePath: string): void {
  const database = createDatabase(databasePath);
  const timestamp = '2026-09-15T00:00:00.000Z';
  try {
    runMigrations(database);
    database.db.transaction((tx) => {
      tx.insert(accounts).values([
        { accountId: 'book-account-a', phone: null, phoneVerified: false, status: 'legacy', createdAt: timestamp, updatedAt: timestamp },
        { accountId: 'book-account-b', phone: null, phoneVerified: false, status: 'legacy', createdAt: timestamp, updatedAt: timestamp },
      ]).run();
      tx.insert(users).values([
        { userId: 'book-user-a', accountId: 'book-account-a', name: '用户 A', createdAt: timestamp, updatedAt: timestamp },
        { userId: 'book-user-b', accountId: 'book-account-b', name: '用户 B', createdAt: timestamp, updatedAt: timestamp },
      ]).run();
      tx.insert(lifeStages).values([
        { stageId: 'book-stage-late', userId: 'book-user-a', title: '后来', sortOrder: 2, createdAt: timestamp, updatedAt: timestamp },
        { stageId: 'book-stage-early', userId: 'book-user-a', title: '早年', sortOrder: 1, createdAt: timestamp, updatedAt: timestamp },
        { stageId: 'book-stage-other', userId: 'book-user-b', title: '他人的阶段', sortOrder: 1, createdAt: timestamp, updatedAt: timestamp },
      ]).run();
      tx.insert(stories).values([
        { storyId: 'book-story-late', userId: 'book-user-a', stageId: 'book-stage-late', title: '后来故事', summary: '后来摘要', status: 'complete', createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' },
        { storyId: 'book-story-early-b', userId: 'book-user-a', stageId: 'book-stage-early', title: '早年 B', summary: '早年 B 摘要', status: 'complete', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' },
        { storyId: 'book-story-early-a', userId: 'book-user-a', stageId: 'book-stage-early', title: '早年 A', summary: '早年 A 摘要', status: 'complete', createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z' },
        { storyId: 'book-story-other', userId: 'book-user-b', stageId: 'book-stage-other', title: '他人的故事', summary: '他人的摘要', status: 'complete', createdAt: timestamp, updatedAt: timestamp },
      ]).run();
      tx.insert(memoirDocuments).values([
        { documentId: 'book-doc-late-v1', userId: 'book-user-a', scopeType: 'story', scopeId: 'book-story-late', title: '后来故事 v1', content: '后来第一版。', versionNumber: 1, status: 'approved', createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' },
        { documentId: 'book-doc-late-v2', userId: 'book-user-a', scopeType: 'story', scopeId: 'book-story-late', title: '后来故事 v2', content: '后来第二版。', versionNumber: 2, status: 'draft', createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z' },
        { documentId: 'book-doc-early-a-v1', userId: 'book-user-a', scopeType: 'story', scopeId: 'book-story-early-a', title: '早年 A 成稿', content: '早年 A 正文。', versionNumber: 1, status: 'final', createdAt: timestamp, updatedAt: timestamp },
        { documentId: 'book-doc-early-b-full', userId: 'book-user-a', scopeType: 'full_memoir', scopeId: null, title: '整本旧稿', content: '不得进入 Book。', versionNumber: 1, status: 'final', createdAt: timestamp, updatedAt: timestamp },
        { documentId: 'book-doc-other-v1', userId: 'book-user-b', scopeType: 'story', scopeId: 'book-story-other', title: '他人的成稿', content: '他人的正文。', versionNumber: 1, status: 'final', createdAt: timestamp, updatedAt: timestamp },
      ]).run();
    });
  } finally {
    database.close();
  }
}

test('BookRepository assembles only owned Story Documents in default Life Stage order', () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-book-repository-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'book.db');
  seedBookFixture(databasePath);

  const repository = new BookRepository(databasePath);
  const available = repository.listAvailableForUser('book-user-a');
  assert.deepEqual(available.map((story) => story.storyId), [
    'book-story-early-a',
    'book-story-late',
  ]);
  assert.equal(available[1]?.documents[0]?.documentId, 'book-doc-late-v2');
  assert.equal(available[1]?.documents[0]?.versionNumber, 2);
  assert.equal(available.some((story) => story.storyId === 'book-story-early-b'), false);
  assert.equal(available.every((story) => story.documents.length > 0), true);
});

test('BookRepository persists selection, version, inclusion, and order without accepting forged references', () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-book-repository-save-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'book.db');
  seedBookFixture(databasePath);

  const repository = new BookRepository(databasePath);
  const saved = repository.createOrUpdateForUser('book-user-a', {
    title: '我的人生书',
    authorName: '用户 A',
    coverConfig: { style: 'sage' },
    items: [
      { storyId: 'book-story-late', documentId: 'book-doc-late-v1', included: true, sortOrder: 1 },
      { storyId: 'book-story-early-a', documentId: 'book-doc-early-a-v1', included: false, sortOrder: 0 },
    ],
  });
  assert.ok(saved.bookId);
  assert.equal(saved.title, '我的人生书');
  assert.deepEqual(saved.items.map((item) => [item.storyId, item.documentId, item.included, item.sortOrder]), [
    ['book-story-early-a', 'book-doc-early-a-v1', false, 0],
    ['book-story-late', 'book-doc-late-v1', true, 1],
  ]);

  const reloaded = repository.getForUser('book-user-a', saved.bookId);
  assert.equal(reloaded?.items[0]?.included, false);
  assert.equal(reloaded?.items[1]?.documentId, 'book-doc-late-v1');
  assert.equal(repository.getForUser('book-user-b', saved.bookId), null);

  assert.throws(() => repository.createOrUpdateForUser('book-user-a', {
    title: '越权引用', authorName: '用户 A', items: [
      { storyId: 'book-story-late', documentId: 'book-doc-other-v1', included: true, sortOrder: 0 },
    ],
  }), (error: unknown) => error instanceof BookRepositoryError && error.code === 'BOOK_DOCUMENT_NOT_IN_STORY');
  assert.throws(() => repository.createOrUpdateForUser('book-user-a', {
    title: '越权引用', authorName: '用户 A', items: [
      { storyId: 'book-story-other', documentId: 'book-doc-other-v1', included: true, sortOrder: 0 },
    ],
  }), (error: unknown) => error instanceof BookRepositoryError && error.code === 'BOOK_STORY_NOT_FOUND');
});

test('BookRepository render model includes only selected versions and included chapters', () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-book-repository-render-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'book.db');
  seedBookFixture(databasePath);

  const repository = new BookRepository(databasePath);
  const saved = repository.createOrUpdateForUser('book-user-a', {
    title: '可预览的人生书',
    authorName: '用户 A',
    items: [
      { storyId: 'book-story-early-a', documentId: 'book-doc-early-a-v1', included: false, sortOrder: 0 },
      { storyId: 'book-story-late', documentId: 'book-doc-late-v1', included: true, sortOrder: 1 },
    ],
  });
  const model = repository.getRenderModelForUser('book-user-a', saved.bookId);
  assert.ok(model);
  assert.equal(model.title, '可预览的人生书');
  assert.deepEqual(model.chapters.map((chapter) => chapter.content), ['后来第一版。']);
  assert.equal(model.chapters[0]?.documentId, 'book-doc-late-v1');
  assert.equal(repository.getRenderModelForUser('book-user-b', saved.bookId), null);
});

test('BookRepository rejects cross-Life-Stage ordering so UI and render order stay aligned', () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-book-repository-stage-order-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'book.db');
  seedBookFixture(databasePath);

  const repository = new BookRepository(databasePath);
  assert.throws(() => repository.createOrUpdateForUser('book-user-a', {
    title: '阶段顺序校验',
    authorName: '用户 A',
    items: [
      { storyId: 'book-story-late', documentId: 'book-doc-late-v1', included: true, sortOrder: 0 },
      { storyId: 'book-story-early-a', documentId: 'book-doc-early-a-v1', included: true, sortOrder: 1 },
    ],
  }), (error: unknown) => error instanceof BookRepositoryError && error.code === 'BOOK_STAGE_ORDER_INVALID');
});
