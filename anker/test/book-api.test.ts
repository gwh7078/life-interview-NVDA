import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { after, test } from 'node:test';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { createInterviewServiceServer } from '../src/server.js';

const temporaryDirectories: string[] = [];
const testTempRoot = path.resolve('data/test-tmp');
mkdirSync(testTempRoot, { recursive: true });

async function createBookServer() {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-book-api-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'book-api.db');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
    database.sqlite.prepare(`
      INSERT INTO memoir_documents
        (document_id, user_id, scope_type, scope_id, title, content, version_number, status, created_at, updated_at)
      VALUES (?, ?, 'story', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'book-api-document-v1', seedIds.user, seedIds.firstProject, '项目故事成稿',
      '这是可导出的人生书章节正文。', 1, 'approved',
      '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z',
    );
    database.sqlite.prepare(`
      INSERT INTO memoir_documents
        (document_id, user_id, scope_type, scope_id, title, content, version_number, status, created_at, updated_at)
      VALUES (?, ?, 'story', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'book-api-childhood-document-v1', seedIds.user, seedIds.childhoodSchool, '童年故事成稿',
      '童年故事正文。', 1, 'approved',
      '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z',
    );
    database.sqlite.exec(`
      INSERT INTO accounts (account_id, phone, phone_verified, status, created_at, updated_at)
      VALUES ('book-api-other-account', '13800138009', 0, 'active', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z');
      INSERT INTO users (user_id, account_id, name, created_at, updated_at)
      VALUES ('book-api-other-user', 'book-api-other-account', '其他用户', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z');
      INSERT INTO life_stages (stage_id, user_id, title, sort_order, status, created_at, updated_at)
      VALUES ('book-api-other-stage', 'book-api-other-user', '其他阶段', 1, 'active', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z');
      INSERT INTO stories (story_id, user_id, stage_id, title, summary, status, created_at, updated_at)
      VALUES ('book-api-other-story', 'book-api-other-user', 'book-api-other-stage', '其他故事', '不应泄露', 'complete', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z');
      INSERT INTO memoir_documents
        (document_id, user_id, scope_type, scope_id, title, content, version_number, status, created_at, updated_at)
      VALUES ('book-api-other-document', 'book-api-other-user', 'story', 'book-api-other-story', '其他成稿', '越权正文', 1, 'final', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z');
    `);
  } finally {
    database.close();
  }
  const server = createInterviewServiceServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    region: 'cn-beijing',
    model: 'test-model',
    developmentAuthEnabled: true,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie);
  return setCookie.split(';', 1)[0]!;
}

test('Book API enforces auth, same-origin writes, and owner-scoped Story/Document references', async () => {
  const { server, baseUrl } = await createBookServer();
  try {
    const unauthorized = await fetch(`${baseUrl}/api/book`);
    assert.equal(unauthorized.status, 401);

    const cookie = await login(baseUrl);
    const initial = await fetch(`${baseUrl}/api/book`, { headers: { cookie } });
    assert.equal(initial.status, 200);
    const initialPayload = await initial.json() as { book: null; available_stories: Array<Record<string, unknown>> };
    assert.equal(initialPayload.book, null);
    assert.deepEqual(initialPayload.available_stories.map((story) => story.story_id), [
      seedIds.childhoodSchool,
      seedIds.firstProject,
    ]);

    const forbidden = await fetch(`${baseUrl}/api/book`, {
      method: 'PUT',
      headers: { cookie, origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ title: '跨站写入', author_name: '攻击者', items: [] }),
    });
    assert.equal(forbidden.status, 403);

    const saved = await fetch(`${baseUrl}/api/book`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '我的第一本人生书',
        author_name: '周明',
        user_id: 'forged-user-id',
        items: [{ story_id: seedIds.firstProject, document_id: 'book-api-document-v1', included: true, sort_order: 0 }],
      }),
    });
    assert.equal(saved.status, 200);
    const savedPayload = await saved.json() as { book: Record<string, unknown>; items: Array<Record<string, unknown>> };
    assert.equal(savedPayload.book.title, '我的第一本人生书');
    assert.equal(savedPayload.items[0]?.document_id, 'book-api-document-v1');

    const invalidReferences = [
      {
        story_id: seedIds.firstProject,
        document_id: seedIds.document,
        expected: 'BOOK_DOCUMENT_NOT_IN_STORY',
      },
      {
        story_id: 'book-api-other-story',
        document_id: 'book-api-other-document',
        expected: 'BOOK_STORY_NOT_FOUND',
      },
    ];
    for (const reference of invalidReferences) {
      const response = await fetch(`${baseUrl}/api/book`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          title: '无效引用',
          author_name: '周明',
          items: [{ ...reference, included: true, sort_order: 0 }],
        }),
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json() as Record<string, unknown>).errorCode, reference.expected);
    }

    const crossStage = await fetch(`${baseUrl}/api/book`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '跨阶段顺序',
        author_name: '周明',
        items: [
          { story_id: seedIds.firstProject, document_id: 'book-api-document-v1', included: true, sort_order: 0 },
          { story_id: seedIds.childhoodSchool, document_id: 'book-api-childhood-document-v1', included: true, sort_order: 1 },
        ],
      }),
    });
    assert.equal(crossStage.status, 422);
    assert.equal((await crossStage.json() as Record<string, unknown>).errorCode, 'BOOK_STAGE_ORDER_INVALID');
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));
