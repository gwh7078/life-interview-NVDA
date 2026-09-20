import { BookRepository, BookRepositoryError, type BookCoverConfig, type BookItemInput, type BookSaveInput } from '../repositories/book-repository.js';
import { renderBookPdf } from './pdf.js';
import type { BookPreviewPayload, BookWorkspacePayload } from './types.js';

export class BookServiceError extends Error {
  constructor(
    readonly code: 'INVALID_BOOK_INPUT' | 'BOOK_NOT_FOUND' | 'BOOK_DOCUMENT_NOT_IN_STORY' | 'BOOK_STORY_NOT_FOUND' | 'BOOK_DUPLICATE_STORY' | 'BOOK_STAGE_ORDER_INVALID',
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'BookServiceError';
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseCoverConfig(value: unknown): BookCoverConfig | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const object = asObject(value);
  if (!object || !['paper', 'sage', 'rose'].includes(String(object.style))) {
    throw new BookServiceError('INVALID_BOOK_INPUT', 400, '封面样式无效。');
  }
  return { style: String(object.style) as BookCoverConfig['style'] };
}

function parseItems(value: unknown): BookItemInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new BookServiceError('INVALID_BOOK_INPUT', 400, '故事编排数据无效。');
  return value.map((raw, index) => {
    const object = asObject(raw);
    const storyId = typeof object?.story_id === 'string' ? object.story_id.trim() : '';
    const documentId = typeof object?.document_id === 'string' ? object.document_id.trim() : '';
    const included = object?.included;
    const sortOrder = object?.sort_order;
    if (!storyId || !documentId || typeof included !== 'boolean'
      || typeof sortOrder !== 'number' || !Number.isSafeInteger(sortOrder) || sortOrder < 0) {
      throw new BookServiceError('INVALID_BOOK_INPUT', 400, `第 ${index + 1} 个故事编排数据无效。`);
    }
    return { storyId, documentId, included, sortOrder };
  });
}

export function parseBookSaveInput(body: Record<string, unknown>): BookSaveInput {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const authorName = typeof body.author_name === 'string' ? body.author_name.trim() : '';
  if (!title || title.length > 200 || !authorName || authorName.length > 200) {
    throw new BookServiceError('INVALID_BOOK_INPUT', 400, '请填写书名和作者，且每项不能超过 200 个字符。');
  }
  const bookId = body.book_id === undefined ? undefined : typeof body.book_id === 'string' ? body.book_id.trim() : '';
  if (body.book_id !== undefined && !bookId) throw new BookServiceError('INVALID_BOOK_INPUT', 400, '人生书编号无效。');
  return {
    ...(bookId ? { bookId } : {}),
    title,
    authorName,
    coverConfig: parseCoverConfig(body.cover_config),
    items: parseItems(body.items) ?? [],
  };
}

function serializeBook(book: ReturnType<BookRepository['getForUser']>): Record<string, unknown> | null {
  if (!book) return null;
  return {
    book_id: book.bookId,
    title: book.title,
    author_name: book.authorName,
    cover_config: book.coverConfig,
    created_at: book.createdAt,
    updated_at: book.updatedAt,
  };
}

function serializeItem(item: NonNullable<ReturnType<BookRepository['getForUser']>>['items'][number]): Record<string, unknown> {
  return {
    book_item_id: item.bookItemId,
    story_id: item.storyId,
    story_title: item.storyTitle,
    story_summary: item.storySummary,
    stage_id: item.stageId,
    stage_title: item.stageTitle,
    stage_sort_order: item.stageSortOrder,
    document_id: item.documentId,
    document_title: item.documentTitle,
    document_version_number: item.documentVersionNumber,
    document_status: item.documentStatus,
    included: item.included,
    sort_order: item.sortOrder,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

function serializeAvailableStory(story: ReturnType<BookRepository['listAvailableForUser']>[number]): Record<string, unknown> {
  return {
    story_id: story.storyId,
    title: story.title,
    summary: story.summary,
    stage_id: story.stageId,
    stage_title: story.stageTitle,
    stage_sort_order: story.stageSortOrder,
    updated_at: story.updatedAt,
    documents: story.documents.map((document) => ({
      document_id: document.documentId,
      title: document.title,
      version_number: document.versionNumber,
      status: document.status,
      created_at: document.createdAt,
      updated_at: document.updatedAt,
    })),
  };
}

function translateRepositoryError(error: unknown): never {
  if (error instanceof BookRepositoryError) {
    const httpStatus = error.code === 'BOOK_NOT_FOUND' ? 404 : error.code === 'INVALID_BOOK' ? 400 : 422;
    throw new BookServiceError(error.code === 'INVALID_BOOK' ? 'INVALID_BOOK_INPUT' : error.code, httpStatus, error.message);
  }
  throw error;
}

export class BookService {
  private readonly repository: BookRepository;

  constructor(databasePath?: string) {
    this.repository = new BookRepository(databasePath);
  }

  load(userId: string, bookId?: string): BookWorkspacePayload {
    const book = bookId ? this.repository.getForUser(userId, bookId) : this.repository.getForUser(userId);
    if (bookId && !book) throw new BookServiceError('BOOK_NOT_FOUND', 404, '人生书不存在。');
    return {
      book: serializeBook(book),
      items: book?.items.map(serializeItem) ?? [],
      available_stories: this.repository.listAvailableForUser(userId).map(serializeAvailableStory),
    };
  }

  save(userId: string, input: BookSaveInput): BookWorkspacePayload {
    const items = input.items.length > 0 ? input.items : this.defaultItems(userId);
    try {
      const book = this.repository.createOrUpdateForUser(userId, { ...input, items });
      return {
        book: serializeBook(book),
        items: book.items.map(serializeItem),
        available_stories: this.repository.listAvailableForUser(userId).map(serializeAvailableStory),
      };
    } catch (error) {
      return translateRepositoryError(error);
    }
  }

  preview(userId: string, bookId: string): BookPreviewPayload {
    const book = this.repository.getRenderModelForUser(userId, bookId);
    if (!book) throw new BookServiceError('BOOK_NOT_FOUND', 404, '人生书不存在。');
    return { book };
  }

  exportPdf(userId: string, bookId: string): Buffer {
    return renderBookPdf(this.preview(userId, bookId).book);
  }

  private defaultItems(userId: string): BookItemInput[] {
    return this.repository.listAvailableForUser(userId).map((story, index) => ({
      storyId: story.storyId,
      documentId: story.documents[0]!.documentId,
      included: true,
      sortOrder: index,
    }));
  }
}
