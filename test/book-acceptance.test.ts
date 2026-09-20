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

type AcceptanceBookItem = {
  story_id: string;
  document_id: string;
  included: boolean;
  sort_order: number;
};

type AcceptanceWorkspace = {
  book: Record<string, unknown> | null;
  items: AcceptanceBookItem[];
  available_stories: Array<Record<string, unknown>>;
};

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function utf16Hex(value: string): Buffer {
  const bytes: number[] = [0xfe, 0xff];
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0xfffd;
    if (code <= 0xffff) {
      bytes.push((code >> 8) & 0xff, code & 0xff);
    } else {
      const adjusted = code - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      bytes.push((high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff);
    }
  }
  return Buffer.from(`<${Buffer.from(bytes).toString('hex').toUpperCase()}>`, 'ascii');
}

function seedAcceptanceFixture(databasePath: string): void {
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
    const timestamp = '2026-09-15T00:00:00.000Z';
    database.sqlite.exec(`
      INSERT INTO memoir_documents
        (document_id, user_id, scope_type, scope_id, title, content, version_number, status, created_at, updated_at)
      VALUES
        ('accept-project-v1', '${seedIds.user}', 'story', '${seedIds.firstProject}', '项目故事 v1', '验收中应被选中的第一版正文。', 1, 'approved', '${timestamp}', '${timestamp}'),
        ('accept-project-v2', '${seedIds.user}', 'story', '${seedIds.firstProject}', '项目故事 v2', '不应被导出的较新版本正文。', 2, 'draft', '${timestamp}', '${timestamp}'),
        ('accept-job-v1', '${seedIds.user}', 'story', '${seedIds.firstJob}', '第一份工作成稿', '第一份工作的验收正文。', 1, 'final', '${timestamp}', '${timestamp}');

      INSERT INTO accounts (account_id, phone, phone_verified, status, created_at, updated_at)
      VALUES ('accept-other-account', '13800138002', 1, 'active', '${timestamp}', '${timestamp}');
      INSERT INTO users (user_id, account_id, name, created_at, updated_at)
      VALUES ('accept-other-user', 'accept-other-account', '另一位用户', '${timestamp}', '${timestamp}');
      INSERT INTO life_stages (stage_id, user_id, title, sort_order, status, created_at, updated_at)
      VALUES ('accept-other-stage', 'accept-other-user', '另一位用户的人生', 1, 'active', '${timestamp}', '${timestamp}');
      INSERT INTO stories (story_id, user_id, stage_id, title, summary, status, created_at, updated_at)
      VALUES ('accept-other-story', 'accept-other-user', 'accept-other-stage', '不应泄露的故事', '另一位用户的摘要', 'complete', '${timestamp}', '${timestamp}');
      INSERT INTO memoir_documents
        (document_id, user_id, scope_type, scope_id, title, content, version_number, status, created_at, updated_at)
      VALUES ('accept-other-doc', 'accept-other-user', 'story', 'accept-other-story', '不应泄露的成稿', '越权正文', 1, 'final', '${timestamp}', '${timestamp}');
    `);
  } finally {
    database.close();
  }
}

function addAcceptanceStoryDocumentVersions(databasePath: string): void {
  const database = createDatabase(databasePath);
  try {
    database.sqlite.prepare(`
      INSERT INTO stories
        (story_id, user_id, stage_id, title, summary, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)
    `).run(
      'accept-family-story', seedIds.user, seedIds.family, '后来的一段家庭故事',
      '后来新增的人生书章节。', '2026-09-15T00:02:00.000Z', '2026-09-15T00:02:00.000Z',
    );
    const insertDocument = database.sqlite.prepare(`
      INSERT INTO memoir_documents
        (document_id, user_id, scope_type, scope_id, title, content, version_number, status, created_at, updated_at)
      VALUES (?, ?, 'story', ?, ?, ?, ?, 'final', ?, ?)
    `);
    insertDocument.run(
      'accept-family-v1', seedIds.user, 'accept-family-story', '家庭故事 v1',
      '不应自动选择的家庭故事旧版本。', 1, '2026-09-15T00:03:00.000Z', '2026-09-15T00:03:00.000Z',
    );
    insertDocument.run(
      'accept-family-v2', seedIds.user, 'accept-family-story', '家庭故事 v2',
      '后来新增的家庭故事最新版本正文。', 2, '2026-09-15T00:04:00.000Z', '2026-09-15T00:04:00.000Z',
    );
  } finally {
    database.close();
  }
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie);
  return setCookie.split(';', 1)[0]!;
}

test('Book V1 acceptance persists arrangement, previews selected versions, and downloads a real PDF', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-book-acceptance-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'book.db');
  seedAcceptanceFixture(databasePath);

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
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const page = await fetch(`${baseUrl}/book`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /step-information/);

    const cookie = await login(baseUrl);
    const workspace = await fetch(`${baseUrl}/api/book`, { headers: { cookie } });
    assert.equal(workspace.status, 200);
    const initial = await workspace.json() as { available_stories: Array<Record<string, unknown>> };
    assert.deepEqual(initial.available_stories.map((story) => story.story_id), [seedIds.firstJob, seedIds.firstProject]);

    const saved = await fetch(`${baseUrl}/api/book`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '验收用人生书',
        author_name: '周明',
        cover_config: { style: 'rose' },
        items: [
          { story_id: seedIds.firstJob, document_id: 'accept-job-v1', included: true, sort_order: 0 },
          { story_id: seedIds.firstProject, document_id: 'accept-project-v1', included: true, sort_order: 1 },
        ],
      }),
    });
    assert.equal(saved.status, 200);
    const savedPayload = await saved.json() as { book: Record<string, unknown>; items: Array<Record<string, unknown>> };
    const bookId = String(savedPayload.book.book_id);
    assert.equal(savedPayload.book.title, '验收用人生书');
    assert.deepEqual(savedPayload.items.map((item) => [item.story_id, item.document_id, item.sort_order]), [
      [seedIds.firstJob, 'accept-job-v1', 0],
      [seedIds.firstProject, 'accept-project-v1', 1],
    ]);

    addAcceptanceStoryDocumentVersions(databasePath);
    const reloadBeforeMerge = await fetch(`${baseUrl}/api/book`, { headers: { cookie } });
    assert.equal(reloadBeforeMerge.status, 200);
    const reloadPayload = await reloadBeforeMerge.json() as {
      book: Record<string, unknown>;
      items: Array<Record<string, unknown>>;
      available_stories: Array<Record<string, unknown>>;
    };
    // The browser entrypoint is JavaScript by design; keep this acceptance test's
    // boundary typed without adding a production declaration solely for tests.
    // @ts-expect-error The JS browser module has no TypeScript declaration.
    const bookModule = await import('../public/book.js');
    const normalizeWorkspace = bookModule.normalizeWorkspace as (payload: AcceptanceWorkspace) => AcceptanceWorkspace;
    const merged = normalizeWorkspace(reloadPayload as AcceptanceWorkspace);
    assert.deepEqual(merged.items.map((item) => [item.story_id, item.document_id, item.included, item.sort_order]), [
      [seedIds.firstJob, 'accept-job-v1', true, 0],
      [seedIds.firstProject, 'accept-project-v1', true, 1],
      ['accept-family-story', 'accept-family-v2', true, 2],
    ]);

    const mergedSave = await fetch(`${baseUrl}/api/book`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        book_id: bookId,
        title: '验收用人生书',
        author_name: '周明',
        cover_config: { style: 'rose' },
        items: merged.items.map((item) => ({
          story_id: item.story_id,
          document_id: item.document_id,
          included: item.included,
          sort_order: item.sort_order,
        })),
      }),
    });
    assert.equal(mergedSave.status, 200);

    const previewResponse = await fetch(`${baseUrl}/api/book/preview?book_id=${encodeURIComponent(bookId)}`, { headers: { cookie } });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { preview: { chapters: Array<Record<string, unknown>> } };
    assert.deepEqual(preview.preview.chapters.map((chapter) => chapter.documentId), [
      'accept-job-v1', 'accept-project-v1', 'accept-family-v2',
    ]);
    assert.equal(preview.preview.chapters[1]?.content, '验收中应被选中的第一版正文。');
    assert.equal(preview.preview.chapters[2]?.content, '后来新增的家庭故事最新版本正文。');

    const pdfResponse = await fetch(`${baseUrl}/api/book/export.pdf?book_id=${encodeURIComponent(bookId)}`, { headers: { cookie } });
    assert.equal(pdfResponse.status, 200);
    assert.match(pdfResponse.headers.get('content-type') ?? '', /application\/pdf/);
    assert.match(pdfResponse.headers.get('content-disposition') ?? '', /attachment/);
    const pdf = Buffer.from(await pdfResponse.arrayBuffer());
    assert.equal(pdf.subarray(0, 8).toString('binary'), '%PDF-1.4');
    assert.ok(pdf.includes(utf16Hex('第一份工作的验收正文。')));
    assert.ok(pdf.includes(utf16Hex('验收中应被选中的第一版正文。')));
    assert.ok(pdf.includes(utf16Hex('后来新增的家庭故事最新版本正文。')));
    assert.equal(pdf.includes(utf16Hex('不应被导出的较新版本正文。')), false);
    const pdfText = pdf.toString('ascii');
    const chapterPositions = [
      '第一份工作的验收正文。',
      '验收中应被选中的第一版正文。',
      '后来新增的家庭故事最新版本正文。',
    ].map((content) => pdfText.indexOf(utf16Hex(content).toString('ascii')));
    assert.ok(chapterPositions[0]! < chapterPositions[1]! && chapterPositions[1]! < chapterPositions[2]!,
      'PDF 正文章节顺序应与 Book / Preview 顺序一致');
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }

  const database = createDatabase(databasePath);
  try {
    const book = database.sqlite.prepare('SELECT title, author_name, cover_config_json FROM memoir_books').get() as Record<string, unknown> | undefined;
    assert.deepEqual(book, {
      title: '验收用人生书',
      author_name: '周明',
      cover_config_json: JSON.stringify({ style: 'rose' }),
    });
    const items = database.sqlite.prepare('SELECT story_id, document_id, sort_order, included FROM memoir_book_items ORDER BY sort_order').all() as Array<Record<string, unknown>>;
    assert.deepEqual(items, [
      { story_id: seedIds.firstJob, document_id: 'accept-job-v1', sort_order: 0, included: 1 },
      { story_id: seedIds.firstProject, document_id: 'accept-project-v1', sort_order: 1, included: 1 },
      { story_id: 'accept-family-story', document_id: 'accept-family-v2', sort_order: 2, included: 1 },
    ]);
    const tables = database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memoir_book%'").all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((table) => table.name).sort(), ['memoir_book_items', 'memoir_books']);
    assert.equal(database.sqlite.prepare('PRAGMA integrity_check').pluck().get(), 'ok');
  } finally {
    database.close();
  }
});
