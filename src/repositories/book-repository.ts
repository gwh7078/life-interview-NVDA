import { randomUUID } from 'node:crypto';
import { createDatabase } from '../db/client.js';
import { bookCoverStyles } from '../db/schema.js';
import { nowUtcIso } from '../db/time.js';

export type BookCoverStyle = (typeof bookCoverStyles)[number];

export interface BookCoverConfig {
  style: BookCoverStyle;
}

export interface BookDocumentOption {
  documentId: string;
  title: string;
  versionNumber: number;
  status: string;
  scopeType: 'story';
  createdAt: string;
  updatedAt: string;
}

export interface AvailableBookStory {
  storyId: string;
  title: string;
  summary: string;
  stageId: string;
  stageTitle: string;
  stageSortOrder: number;
  updatedAt: string;
  documents: BookDocumentOption[];
}

export interface BookItemRecord {
  bookItemId: string;
  storyId: string;
  storyTitle: string;
  storySummary: string;
  stageId: string;
  stageTitle: string;
  stageSortOrder: number;
  documentId: string;
  documentTitle: string;
  documentVersionNumber: number;
  documentStatus: string;
  included: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookRecord {
  bookId: string;
  userId: string;
  title: string;
  authorName: string;
  coverConfig: BookCoverConfig | null;
  createdAt: string;
  updatedAt: string;
  items: BookItemRecord[];
}

export interface BookItemInput {
  storyId: string;
  documentId: string;
  included: boolean;
  sortOrder: number;
}

export interface BookSaveInput {
  bookId?: string;
  title: string;
  authorName: string;
  coverConfig?: BookCoverConfig | null;
  items: BookItemInput[];
}

export interface BookChapterRenderModel {
  storyId: string;
  storyTitle: string;
  stageId: string;
  stageTitle: string;
  stageSortOrder: number;
  documentId: string;
  documentVersionNumber: number;
  content: string;
  sortOrder: number;
}

export interface BookRenderModel {
  bookId: string;
  title: string;
  authorName: string;
  coverConfig: BookCoverConfig | null;
  chapters: BookChapterRenderModel[];
}

export class BookRepositoryError extends Error {
  constructor(
    readonly code:
      | 'INVALID_BOOK'
      | 'BOOK_NOT_FOUND'
      | 'BOOK_STORY_NOT_FOUND'
      | 'BOOK_DOCUMENT_NOT_IN_STORY'
      | 'BOOK_DUPLICATE_STORY'
      | 'BOOK_STAGE_ORDER_INVALID',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'BookRepositoryError';
  }
}

function parseCoverConfig(value: string | null): BookCoverConfig | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const style = (parsed as { style?: unknown }).style;
    return typeof style === 'string' && bookCoverStyles.includes(style as BookCoverStyle)
      ? { style: style as BookCoverStyle }
      : null;
  } catch {
    return null;
  }
}

function normalizeCoverConfig(value: BookCoverConfig | null | undefined): BookCoverConfig | null {
  if (value === null || value === undefined) return null;
  if (!bookCoverStyles.includes(value.style)) throw new BookRepositoryError('INVALID_BOOK', '不支持的封面样式。');
  return { style: value.style };
}

function stringValue(value: unknown): string {
  return String(value ?? '');
}

function mapAvailableDocuments(rows: Array<Record<string, unknown>>): BookDocumentOption[] {
  return rows.map((row) => ({
    documentId: stringValue(row.document_id),
    title: stringValue(row.document_title),
    versionNumber: Number(row.version_number),
    status: stringValue(row.document_status),
    scopeType: 'story',
    createdAt: stringValue(row.document_created_at),
    updatedAt: stringValue(row.document_updated_at),
  }));
}

export class BookRepository {
  constructor(private readonly databasePath?: string) {}

  listAvailableForUser(userId: string): AvailableBookStory[] {
    const connection = createDatabase(this.databasePath);
    try {
      const stories = connection.sqlite.prepare(`
        SELECT s.story_id, s.title, s.summary, s.stage_id, s.updated_at,
          stage.title AS stage_title, stage.sort_order AS stage_sort_order
        FROM stories AS s
        JOIN life_stages AS stage
          ON stage.stage_id = s.stage_id AND stage.user_id = s.user_id
        WHERE s.user_id = ?
          AND EXISTS (
            SELECT 1 FROM memoir_documents AS eligible
            WHERE eligible.user_id = s.user_id
              AND eligible.scope_type = 'story'
              AND eligible.scope_id = s.story_id
          )
        ORDER BY stage.sort_order ASC, s.updated_at DESC, s.title COLLATE NOCASE ASC, s.story_id ASC
      `).all(userId) as Array<Record<string, unknown>>;
      const documents = connection.sqlite.prepare(`
        SELECT document_id, scope_id, title AS document_title, version_number,
          status AS document_status, created_at AS document_created_at, updated_at AS document_updated_at
        FROM memoir_documents
        WHERE user_id = ? AND scope_type = 'story' AND scope_id = ?
        ORDER BY version_number DESC, updated_at DESC, document_id ASC
      `);
      return stories.map((row) => ({
        storyId: stringValue(row.story_id),
        title: stringValue(row.title),
        summary: stringValue(row.summary),
        stageId: stringValue(row.stage_id),
        stageTitle: stringValue(row.stage_title),
        stageSortOrder: Number(row.stage_sort_order),
        updatedAt: stringValue(row.updated_at),
        documents: mapAvailableDocuments(documents.all(userId, stringValue(row.story_id)) as Array<Record<string, unknown>>),
      }));
    } finally {
      connection.close();
    }
  }

  getForUser(userId: string, bookId?: string): BookRecord | null {
    const connection = createDatabase(this.databasePath);
    try {
      const book = (bookId
        ? connection.sqlite.prepare(`
            SELECT book_id, user_id, title, author_name, cover_config_json, created_at, updated_at
            FROM memoir_books WHERE user_id = ? AND book_id = ?
          `).get(userId, bookId)
        : connection.sqlite.prepare(`
            SELECT book_id, user_id, title, author_name, cover_config_json, created_at, updated_at
            FROM memoir_books WHERE user_id = ?
            ORDER BY updated_at DESC, created_at DESC, book_id DESC LIMIT 1
          `).get(userId)) as Record<string, unknown> | undefined;
      if (!book) return null;
      const items = connection.sqlite.prepare(`
        SELECT bi.book_item_id, bi.story_id, s.title AS story_title, s.summary AS story_summary,
          s.stage_id, stage.title AS stage_title, stage.sort_order AS stage_sort_order,
          bi.document_id, d.title AS document_title, d.version_number AS document_version_number,
          d.status AS document_status, bi.included, bi.sort_order, bi.created_at, bi.updated_at
        FROM memoir_book_items AS bi
        JOIN memoir_books AS b ON b.book_id = bi.book_id AND b.user_id = ?
        JOIN stories AS s ON s.story_id = bi.story_id AND s.user_id = b.user_id
        JOIN life_stages AS stage ON stage.stage_id = s.stage_id AND stage.user_id = b.user_id
        JOIN memoir_documents AS d
          ON d.document_id = bi.document_id AND d.user_id = b.user_id
          AND d.scope_type = 'story' AND d.scope_id = bi.story_id
        WHERE bi.book_id = ?
        ORDER BY bi.sort_order ASC, bi.book_item_id ASC
      `).all(userId, stringValue(book.book_id)) as Array<Record<string, unknown>>;
      return {
        bookId: stringValue(book.book_id),
        userId: stringValue(book.user_id),
        title: stringValue(book.title),
        authorName: stringValue(book.author_name),
        coverConfig: parseCoverConfig(book.cover_config_json == null ? null : String(book.cover_config_json)),
        createdAt: stringValue(book.created_at),
        updatedAt: stringValue(book.updated_at),
        items: items.map((row) => ({
          bookItemId: stringValue(row.book_item_id),
          storyId: stringValue(row.story_id),
          storyTitle: stringValue(row.story_title),
          storySummary: stringValue(row.story_summary),
          stageId: stringValue(row.stage_id),
          stageTitle: stringValue(row.stage_title),
          stageSortOrder: Number(row.stage_sort_order),
          documentId: stringValue(row.document_id),
          documentTitle: stringValue(row.document_title),
          documentVersionNumber: Number(row.document_version_number),
          documentStatus: stringValue(row.document_status),
          included: Boolean(row.included),
          sortOrder: Number(row.sort_order),
          createdAt: stringValue(row.created_at),
          updatedAt: stringValue(row.updated_at),
        })),
      };
    } finally {
      connection.close();
    }
  }

  createOrUpdateForUser(userId: string, input: BookSaveInput): BookRecord {
    const title = input.title.trim();
    const authorName = input.authorName.trim();
    if (!title || title.length > 200 || !authorName || authorName.length > 200 || !Array.isArray(input.items)) {
      throw new BookRepositoryError('INVALID_BOOK', '书名、作者不能为空且不能超过 200 个字符。');
    }
    const coverConfig = normalizeCoverConfig(input.coverConfig);
    const seenStories = new Set<string>();
    const orderedItems = input.items
      .map((item, index) => ({ ...item, index }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.index - b.index);
    const connection = createDatabase(this.databasePath);
    let persistedBookId = input.bookId;
    try {
      connection.sqlite.transaction(() => {
        if (persistedBookId) {
          const owned = connection.sqlite.prepare(
            'SELECT book_id FROM memoir_books WHERE book_id = ? AND user_id = ?',
          ).get(persistedBookId, userId) as { book_id: string } | undefined;
          if (!owned) throw new BookRepositoryError('BOOK_NOT_FOUND', '人生书不存在。');
        } else {
          persistedBookId = randomUUID();
        }
        const now = nowUtcIso();
        if (input.bookId) {
          connection.sqlite.prepare(`
            UPDATE memoir_books
            SET title = ?, author_name = ?, cover_config_json = ?, updated_at = ?
            WHERE book_id = ? AND user_id = ?
          `).run(title, authorName, coverConfig ? JSON.stringify(coverConfig) : null, now, persistedBookId, userId);
          connection.sqlite.prepare('DELETE FROM memoir_book_items WHERE book_id = ?').run(persistedBookId);
        } else {
          connection.sqlite.prepare(`
            INSERT INTO memoir_books
              (book_id, user_id, title, author_name, cover_config_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(persistedBookId, userId, title, authorName, coverConfig ? JSON.stringify(coverConfig) : null, now, now);
        }
        const insertItem = connection.sqlite.prepare(`
          INSERT INTO memoir_book_items
            (book_item_id, book_id, story_id, document_id, sort_order, included, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        let lastStageId: string | null = null;
        let lastStageSortOrder = Number.NEGATIVE_INFINITY;
        const closedStageIds = new Set<string>();
        for (const item of orderedItems) {
          const storyId = typeof item.storyId === 'string' ? item.storyId.trim() : '';
          const documentId = typeof item.documentId === 'string' ? item.documentId.trim() : '';
          if (!storyId || seenStories.has(storyId)) {
            throw new BookRepositoryError('BOOK_DUPLICATE_STORY', '一本人生书中不能重复收录同一个故事。');
          }
          seenStories.add(storyId);
          const story = connection.sqlite.prepare(`
            SELECT s.story_id, s.stage_id, stage.sort_order AS stage_sort_order
            FROM stories AS s
            JOIN life_stages AS stage
              ON stage.stage_id = s.stage_id AND stage.user_id = s.user_id
            WHERE s.story_id = ? AND s.user_id = ?
          `).get(storyId, userId) as { story_id: string; stage_id: string; stage_sort_order: number } | undefined;
          if (!story) throw new BookRepositoryError('BOOK_STORY_NOT_FOUND', '故事不存在或不属于当前用户。');
          const stageId = stringValue(story.stage_id);
          const stageSortOrder = Number(story.stage_sort_order);
          if (!stageId || !Number.isFinite(stageSortOrder)) {
            throw new BookRepositoryError('BOOK_STAGE_ORDER_INVALID', '故事所属的人生阶段无效。');
          }
          if (lastStageId !== null && stageId !== lastStageId) {
            if (closedStageIds.has(stageId) || stageSortOrder < lastStageSortOrder) {
              throw new BookRepositoryError('BOOK_STAGE_ORDER_INVALID', '故事必须按人生阶段顺序编排，每个阶段的故事只能连续排列。');
            }
            closedStageIds.add(lastStageId);
          }
          lastStageId = stageId;
          lastStageSortOrder = stageSortOrder;
          const document = connection.sqlite.prepare(`
            SELECT document_id FROM memoir_documents
            WHERE document_id = ? AND user_id = ? AND scope_type = 'story' AND scope_id = ?
          `).get(documentId, userId, storyId) as { document_id: string } | undefined;
          if (!document) throw new BookRepositoryError('BOOK_DOCUMENT_NOT_IN_STORY', '成稿版本不存在或不属于该故事。');
          if (typeof item.included !== 'boolean') throw new BookRepositoryError('INVALID_BOOK', '故事收录状态无效。');
          insertItem.run(randomUUID(), persistedBookId, storyId, documentId, seenStories.size - 1, item.included ? 1 : 0, now, now);
        }
      })();
      const saved = this.getForUser(userId, persistedBookId);
      if (!saved) throw new BookRepositoryError('BOOK_NOT_FOUND', '人生书保存后无法读取。');
      return saved;
    } finally {
      connection.close();
    }
  }

  getRenderModelForUser(userId: string, bookId: string): BookRenderModel | null {
    const connection = createDatabase(this.databasePath);
    try {
      const book = connection.sqlite.prepare(`
        SELECT book_id, title, author_name, cover_config_json
        FROM memoir_books WHERE user_id = ? AND book_id = ?
      `).get(userId, bookId) as Record<string, unknown> | undefined;
      if (!book) return null;
      const chapters = connection.sqlite.prepare(`
        SELECT bi.story_id, s.title AS story_title, s.stage_id,
          stage.title AS stage_title, stage.sort_order AS stage_sort_order,
          bi.document_id, d.version_number AS document_version_number,
          d.content, bi.sort_order
        FROM memoir_book_items AS bi
        JOIN stories AS s ON s.story_id = bi.story_id AND s.user_id = ?
        JOIN life_stages AS stage ON stage.stage_id = s.stage_id AND stage.user_id = ?
        JOIN memoir_documents AS d
          ON d.document_id = bi.document_id AND d.user_id = ?
          AND d.scope_type = 'story' AND d.scope_id = bi.story_id
        WHERE bi.book_id = ? AND bi.included = 1
        ORDER BY bi.sort_order ASC, bi.book_item_id ASC
      `).all(userId, userId, userId, bookId) as Array<Record<string, unknown>>;
      return {
        bookId: stringValue(book.book_id),
        title: stringValue(book.title),
        authorName: stringValue(book.author_name),
        coverConfig: parseCoverConfig(book.cover_config_json == null ? null : String(book.cover_config_json)),
        chapters: chapters.map((row) => ({
          storyId: stringValue(row.story_id),
          storyTitle: stringValue(row.story_title),
          stageId: stringValue(row.stage_id),
          stageTitle: stringValue(row.stage_title),
          stageSortOrder: Number(row.stage_sort_order),
          documentId: stringValue(row.document_id),
          documentVersionNumber: Number(row.document_version_number),
          content: stringValue(row.content),
          sortOrder: Number(row.sort_order),
        })),
      };
    } finally {
      connection.close();
    }
  }
}
