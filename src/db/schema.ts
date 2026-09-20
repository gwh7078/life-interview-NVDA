import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const onboardingStatuses = ['not_started', 'in_progress', 'completed'] as const;
export const lifeStageStatuses = ['active', 'pending', 'merged'] as const;
export const storyStatuses = ['pending', 'interviewing', 'complete'] as const;
export const sessionTypes = ['onboarding', 'life_stage', 'story'] as const;
export const sessionProviders = ['doubao', 'qwen', 'openclaw'] as const;
export const sessionStatuses = ['active', 'ended', 'processing', 'completed'] as const;
export const closeoutStatuses = ['pending', 'processing', 'completed', 'failed'] as const;
export const documentScopeTypes = ['story', 'full_memoir'] as const;
export const documentStatuses = ['draft', 'approved', 'final'] as const;
export const accountStatuses = ['active', 'disabled', 'legacy'] as const;
export const bookCoverStyles = ['paper', 'sage', 'rose'] as const;
export const storyShareStatuses = ['active', 'revoked'] as const;
export const interviewSourceTypes = ['subject', 'external_contributor'] as const;

export const accounts = sqliteTable(
  'accounts',
  {
    accountId: text('account_id').primaryKey(),
    phone: text('phone'),
    phoneVerified: integer('phone_verified', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: accountStatuses }).notNull().default('active'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('accounts_phone_uq').on(table.phone)],
);

export const users = sqliteTable(
  'users',
  {
    userId: text('user_id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'restrict', onUpdate: 'cascade' }),
    name: text('name'),
    nickname: text('nickname'),
    email: text('email'),
    birthDate: text('birth_date'),
    birthDatePrecision: text('birth_date_precision'),
    gender: text('gender'),
    birthPlace: text('birth_place'),
    currentLocation: text('current_location'),
    currentStatus: text('current_status'),
    occupationSummary: text('occupation_summary'),
    familySummary: text('family_summary'),
    profileSummary: text('profile_summary'),
    extraProfileJson: text('extra_profile_json'),
    onboardingStatus: text('onboarding_status', { enum: onboardingStatuses })
      .notNull()
      .default('not_started'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('users_account_id_uq').on(table.accountId),
    index('users_email_idx').on(table.email),
  ],
);

export const lifeStages = sqliteTable(
  'life_stages',
  {
    stageId: text('stage_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade', onUpdate: 'cascade' }),
    title: text('title').notNull(),
    startDate: text('start_date'),
    endDate: text('end_date'),
    datePrecision: text('date_precision'),
    summary: text('summary'),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status', { enum: lifeStageStatuses }).notNull().default('active'),
    createdSourceSessionId: text('created_source_session_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('life_stages_user_id_idx').on(table.userId),
    index('life_stages_user_sort_order_idx').on(table.userId, table.sortOrder),
  ],
);

export const stories = sqliteTable(
  'stories',
  {
    storyId: text('story_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade', onUpdate: 'cascade' }),
    stageId: text('stage_id')
      .notNull()
      .references(() => lifeStages.stageId, { onDelete: 'restrict', onUpdate: 'cascade' }),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    agentMemory: text('agent_memory').notNull().default(''),
    status: text('status', { enum: storyStatuses }).notNull().default('pending'),
    gapsJson: text('gaps_json').notNull().default('[]'),
    createdSourceSessionId: text('created_source_session_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('stories_user_id_idx').on(table.userId),
    index('stories_stage_id_idx').on(table.stageId),
    index('stories_user_stage_idx').on(table.userId, table.stageId),
    index('stories_status_idx').on(table.status),
  ],
);

export const storyShareLinks = sqliteTable(
  'story_share_links',
  {
    shareId: text('share_id').primaryKey(),
    storyId: text('story_id')
      .notNull()
      .references(() => stories.storyId, { onDelete: 'cascade', onUpdate: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade', onUpdate: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    relationship: text('relationship').notNull(),
    contributorSummary: text('contributor_summary').notNull().default(''),
    status: text('status', { enum: storyShareStatuses }).notNull().default('active'),
    expiresAt: text('expires_at').notNull(),
    interviewCount: integer('interview_count').notNull().default(0),
    lastInterviewAt: text('last_interview_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('story_share_links_token_hash_uq').on(table.tokenHash),
    index('story_share_links_user_story_idx').on(table.userId, table.storyId),
    index('story_share_links_story_idx').on(table.storyId),
    index('story_share_links_expires_idx').on(table.expiresAt),
  ],
);

export const interviewSessions = sqliteTable(
  'interview_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    provider: text('provider', { enum: sessionProviders }).notNull().default('doubao'),
    providerSessionId: text('provider_session_id'),
    userId: text('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade', onUpdate: 'cascade' }),
    stageId: text('stage_id').references(() => lifeStages.stageId, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    storyId: text('story_id').references(() => stories.storyId, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    sessionType: text('session_type', { enum: sessionTypes }).notNull(),
    sourceType: text('source_type', { enum: interviewSourceTypes }).notNull().default('subject'),
    sourceShareId: text('source_share_id').references(() => storyShareLinks.shareId, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    status: text('status', { enum: sessionStatuses }).notNull().default('active'),
    closeoutStatus: text('closeout_status', { enum: closeoutStatuses })
      .notNull()
      .default('pending'),
    transcriptJson: text('transcript_json').notNull().default('[]'),
    closeoutResultJson: text('closeout_result_json'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('interview_sessions_user_id_idx').on(table.userId),
    index('interview_sessions_story_id_idx').on(table.storyId),
    index('interview_sessions_stage_id_idx').on(table.stageId),
    index('interview_sessions_status_idx').on(table.status),
    index('interview_sessions_source_share_id_idx').on(table.sourceShareId),
    uniqueIndex('interview_sessions_provider_session_id_uq')
      .on(table.provider, table.providerSessionId)
      .where(sql`${table.providerSessionId} IS NOT NULL`),
  ],
);

export const memoirDocuments = sqliteTable(
  'memoir_documents',
  {
    documentId: text('document_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade', onUpdate: 'cascade' }),
    scopeType: text('scope_type', { enum: documentScopeTypes }).notNull(),
    scopeId: text('scope_id'),
    title: text('title').notNull(),
    content: text('content').notNull(),
    versionNumber: integer('version_number').notNull().default(1),
    status: text('status', { enum: documentStatuses }).notNull().default('draft'),
    sourceJson: text('source_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('memoir_documents_version_number_check', sql`${table.versionNumber} >= 1`),
    index('memoir_documents_user_id_idx').on(table.userId),
    index('memoir_documents_scope_idx').on(table.scopeType, table.scopeId),
  ],
);

export const memoirBooks = sqliteTable(
  'memoir_books',
  {
    bookId: text('book_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade', onUpdate: 'cascade' }),
    title: text('title').notNull(),
    authorName: text('author_name').notNull(),
    coverConfigJson: text('cover_config_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('memoir_books_user_id_idx').on(table.userId),
    index('memoir_books_user_updated_idx').on(table.userId, table.updatedAt),
  ],
);

export const memoirBookItems = sqliteTable(
  'memoir_book_items',
  {
    bookItemId: text('book_item_id').primaryKey(),
    bookId: text('book_id')
      .notNull()
      .references(() => memoirBooks.bookId, { onDelete: 'cascade', onUpdate: 'cascade' }),
    storyId: text('story_id')
      .notNull()
      .references(() => stories.storyId, { onDelete: 'restrict', onUpdate: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => memoirDocuments.documentId, { onDelete: 'restrict', onUpdate: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    included: integer('included', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('memoir_book_items_book_story_uq').on(table.bookId, table.storyId),
    index('memoir_book_items_book_order_idx').on(table.bookId, table.sortOrder),
    index('memoir_book_items_story_idx').on(table.storyId),
    index('memoir_book_items_document_idx').on(table.documentId),
  ],
);

export const schema = {
  accounts,
  users,
  lifeStages,
  stories,
  interviewSessions,
  storyShareLinks,
  memoirDocuments,
  memoirBooks,
  memoirBookItems,
};

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type LifeStage = typeof lifeStages.$inferSelect;
export type NewLifeStage = typeof lifeStages.$inferInsert;
export type Story = typeof stories.$inferSelect;
export type NewStory = typeof stories.$inferInsert;
export type InterviewSession = typeof interviewSessions.$inferSelect;
export type NewInterviewSession = typeof interviewSessions.$inferInsert;
export type StoryShareLink = typeof storyShareLinks.$inferSelect;
export type NewStoryShareLink = typeof storyShareLinks.$inferInsert;
export type MemoirDocument = typeof memoirDocuments.$inferSelect;
export type NewMemoirDocument = typeof memoirDocuments.$inferInsert;
export type MemoirBook = typeof memoirBooks.$inferSelect;
export type NewMemoirBook = typeof memoirBooks.$inferInsert;
export type MemoirBookItem = typeof memoirBookItems.$inferSelect;
export type NewMemoirBookItem = typeof memoirBookItems.$inferInsert;
