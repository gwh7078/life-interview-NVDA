import type {
  AvailableBookStory,
  BookCoverConfig,
  BookRecord,
  BookRenderModel,
} from '../repositories/book-repository.js';

export interface BookWorkspacePayload {
  book: Record<string, unknown> | null;
  items: Array<Record<string, unknown>>;
  available_stories: Array<Record<string, unknown>>;
}

export interface BookPreviewPayload {
  book: BookRenderModel;
}

export type { AvailableBookStory, BookCoverConfig, BookRecord, BookRenderModel };
