import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import {
  interviewSessions,
  lifeStages,
  memoirDocuments,
  storyStatuses,
  stories,
  users,
} from '../db/schema.js';
import { parseTranscript, serializeTranscript, type TranscriptMessage } from '../db/transcript.js';
import { nowUtcIso } from '../db/time.js';
import { MAX_STORY_GAPS, isStoryGapQuestion, parseStoryGaps } from '../story/gaps.js';

export type StoryStatus = (typeof storyStatuses)[number];

export interface StoryCompletionData {
  title: string;
  agentMemory: string;
  stageTitle: string;
  currentStatus: StoryStatus;
  interviewSessionCount: number;
}

export interface StoryDetailRecord {
  storyId: string;
  title: string;
  summary: string;
  status: StoryStatus;
  gaps: string[];
  stageId: string;
  stageTitle: string;
  updatedAt: string;
}

export interface StoryTranscriptHistory {
  sessionId: string;
  provider: string;
  startedAt: string;
  messages: TranscriptMessage[];
}

export type LifeStageEndYear = number | 'now' | null;

export interface LifeStageV1Input {
  title: string;
  startYear: number | null;
  endYear: LifeStageEndYear;
}

export interface LifeStageV1Record {
  stageId: string;
  userId: string;
  title: string;
  startYear: number | null;
  endYear: LifeStageEndYear;
  sortOrder: number;
  status: typeof lifeStages.$inferSelect['status'];
  createdSourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LifeStageDeleteResult = 'deleted' | 'not_found' | 'has_stories';
export type MoveStoryToStageResult = 'moved' | 'story_not_found' | 'stage_not_found';

function yearFromLegacyDate(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(-?\d+)(?:-\d{2}(?:-\d{2})?)?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isSafeInteger(year) ? year : null;
}

function legacyDateFromYear(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new TypeError('INVALID_LIFE_STAGE_YEAR');
  return String(value);
}

function legacyEndDateFromYear(value: LifeStageEndYear): string | null {
  return value === 'now' ? 'now' : legacyDateFromYear(value);
}

function lifeStageV1Record(stage: typeof lifeStages.$inferSelect): LifeStageV1Record {
  return {
    stageId: stage.stageId,
    userId: stage.userId,
    title: stage.title,
    startYear: yearFromLegacyDate(stage.startDate),
    endYear: stage.endDate === 'now' ? 'now' : yearFromLegacyDate(stage.endDate),
    sortOrder: stage.sortOrder,
    status: stage.status,
    createdSourceSessionId: stage.createdSourceSessionId,
    createdAt: stage.createdAt,
    updatedAt: stage.updatedAt,
  };
}

export class StoryRepository {
  constructor(private readonly databasePath?: string) {}

  listForUser(userId: string): Array<Record<string, unknown>> {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.sqlite.prepare(`
        SELECT s.story_id AS story_id, s.title AS title, s.status AS status,
          s.summary AS summary, stage.stage_id AS stage_id, stage.title AS stage_title
        FROM stories AS s
        JOIN life_stages AS stage ON stage.stage_id = s.stage_id AND stage.user_id = s.user_id
        WHERE s.user_id = ?
        ORDER BY stage.sort_order ASC, s.updated_at DESC, s.title COLLATE NOCASE ASC
      `).all(userId) as Array<Record<string, unknown>>;
    } finally {
      connection.close();
    }
  }

  listAllForUser(userId: string) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select().from(stories).where(eq(stories.userId, userId)).all();
    } finally {
      connection.close();
    }
  }

  findByIdForUser(userId: string, storyId: string) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select().from(stories).where(and(
        eq(stories.userId, userId),
        eq(stories.storyId, storyId),
      )).get() ?? null;
    } finally {
      connection.close();
    }
  }

  getDetailForUser(userId: string, storyId: string): StoryDetailRecord | null {
    const connection = createDatabase(this.databasePath);
    try {
      const row = connection.sqlite.prepare(`
        SELECT s.story_id AS storyId, s.title, s.summary, s.status, s.gaps_json AS gapsJson,
          s.stage_id AS stageId, stage.title AS stageTitle, s.updated_at AS updatedAt
        FROM stories AS s
        JOIN life_stages AS stage
          ON stage.stage_id = s.stage_id AND stage.user_id = s.user_id
        WHERE s.user_id = ? AND s.story_id = ?
      `).get(userId, storyId) as {
        storyId: string;
        title: string;
        summary: string;
        status: StoryStatus;
        gapsJson: string;
        stageId: string;
        stageTitle: string;
        updatedAt: string;
      } | undefined;
      return row ? {
        storyId: row.storyId,
        title: row.title,
        summary: row.summary,
        status: row.status,
        gaps: parseStoryGaps(row.gapsJson),
        stageId: row.stageId,
        stageTitle: row.stageTitle,
        updatedAt: row.updatedAt,
      } : null;
    } finally {
      connection.close();
    }
  }

  getCompletionDataForUser(userId: string, storyId: string): StoryCompletionData | null {
    const connection = createDatabase(this.databasePath);
    try {
      const row = connection.sqlite.prepare(`
        SELECT s.title, s.agent_memory AS agentMemory, s.status,
          stage.title AS stageTitle,
          (SELECT COUNT(*) FROM interview_sessions AS sessions
            WHERE sessions.user_id = s.user_id AND sessions.story_id = s.story_id
              AND sessions.session_type = 'story'
              AND sessions.source_type = 'subject') AS interviewSessionCount
        FROM stories AS s
        JOIN life_stages AS stage
          ON stage.stage_id = s.stage_id AND stage.user_id = s.user_id
        WHERE s.user_id = ? AND s.story_id = ?
      `).get(userId, storyId) as {
        title: string;
        agentMemory: string;
        status: StoryStatus;
        stageTitle: string;
        interviewSessionCount: number;
      } | undefined;
      return row ? {
        title: row.title,
        agentMemory: row.agentMemory,
        stageTitle: row.stageTitle,
        currentStatus: row.status,
        interviewSessionCount: Number(row.interviewSessionCount),
      } : null;
    } finally {
      connection.close();
    }
  }

  updateTitleForUser(userId: string, storyId: string, title: string): boolean {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.update(stories).set({ title, updatedAt: nowUtcIso() }).where(and(
        eq(stories.userId, userId),
        eq(stories.storyId, storyId),
      )).run().changes === 1;
    } finally {
      connection.close();
    }
  }

  updateCompletionForUser(
    userId: string,
    storyId: string,
    output: { status: StoryStatus; gaps: string[] },
  ): { status: StoryStatus; gaps: string[] } | null {
    if (!storyStatuses.includes(output.status) || !Array.isArray(output.gaps) || output.gaps.length > MAX_STORY_GAPS
      || output.gaps.some((gap) => !isStoryGapQuestion(gap))) {
      throw new Error('STORY_COMPLETION_OUTPUT_INVALID');
    }
    const gaps = output.gaps.map((gap) => gap.trim());
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.transaction((tx) => {
        const current = tx.select({ status: stories.status }).from(stories).where(and(
          eq(stories.userId, userId),
          eq(stories.storyId, storyId),
        )).get();
        if (!current) return null;
        const status: StoryStatus = current.status === 'complete' ? 'complete' : output.status;
        tx.update(stories).set({
          status,
          gapsJson: JSON.stringify(gaps),
          updatedAt: nowUtcIso(),
        }).where(and(
          eq(stories.userId, userId),
          eq(stories.storyId, storyId),
        )).run();
        return { status, gaps };
      });
    } finally {
      connection.close();
    }
  }

  listByStageForUser(userId: string, stageId: string): Array<{ storyId: string; title: string; summary: string; status: string }> {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select({
        storyId: stories.storyId,
        title: stories.title,
        summary: stories.summary,
        status: stories.status,
      }).from(stories).where(and(
        eq(stories.userId, userId),
        eq(stories.stageId, stageId),
      )).all();
    } finally {
      connection.close();
    }
  }

  moveToStageForUser(userId: string, storyId: string, targetStageId: string): MoveStoryToStageResult {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.transaction((tx) => {
        const story = tx.select({ storyId: stories.storyId }).from(stories).where(and(
          eq(stories.userId, userId),
          eq(stories.storyId, storyId),
        )).get();
        if (!story) return 'story_not_found';

        const stage = tx.select({ stageId: lifeStages.stageId }).from(lifeStages).where(and(
          eq(lifeStages.userId, userId),
          eq(lifeStages.stageId, targetStageId),
        )).get();
        if (!stage) return 'stage_not_found';

        tx.update(stories).set({ stageId: targetStageId }).where(and(
          eq(stories.userId, userId),
          eq(stories.storyId, storyId),
        )).run();
        return 'moved';
      });
    } finally {
      connection.close();
    }
  }

  updateSummaryForUser(userId: string, storyId: string, summary: string): boolean {
    const connection = createDatabase(this.databasePath);
    try {
      const result = connection.db.update(stories).set({ summary, updatedAt: nowUtcIso() })
        .where(and(eq(stories.userId, userId), eq(stories.storyId, storyId))).run();
      return result.changes === 1;
    } finally {
      connection.close();
    }
  }

  deleteForUser(userId: string, storyId: string): boolean {
    const connection = createDatabase(this.databasePath);
    try {
      const result = connection.db.delete(stories)
        .where(and(eq(stories.userId, userId), eq(stories.storyId, storyId))).run();
      return result.changes === 1;
    } finally {
      connection.close();
    }
  }

  getTranscriptsByStoryId(userId: string, storyId: string): StoryTranscriptHistory[] {
    const connection = createDatabase(this.databasePath);
    try {
      const story = connection.db.select({ storyId: stories.storyId })
        .from(stories).where(and(eq(stories.userId, userId), eq(stories.storyId, storyId))).get();
      if (!story) return [];
      const sessions = connection.db.select({
        sessionId: interviewSessions.sessionId,
        provider: interviewSessions.provider,
        startedAt: interviewSessions.startedAt,
        transcriptJson: interviewSessions.transcriptJson,
      }).from(interviewSessions).where(and(
        eq(interviewSessions.userId, userId),
        eq(interviewSessions.storyId, storyId),
        eq(interviewSessions.sourceType, 'subject'),
      )).orderBy(
        asc(interviewSessions.startedAt),
        asc(interviewSessions.createdAt),
        asc(interviewSessions.sessionId),
      ).all();
      return sessions.map((session) => ({
        sessionId: session.sessionId,
        provider: session.provider,
        startedAt: session.startedAt,
        messages: parseTranscript(session.transcriptJson),
      }));
    } finally {
      connection.close();
    }
  }

}

export class TranscriptRepository {
  constructor(private readonly databasePath?: string) {}

  appendForSession(userId: string, sessionId: string, input: {
    role: 'user' | 'assistant';
    text: string;
    provider: 'doubao' | 'qwen' | 'openclaw' | 'test';
    providerMessageId?: string;
  }): TranscriptMessage {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.transaction((tx) => {
        const session = tx.select().from(interviewSessions).where(and(
          eq(interviewSessions.userId, userId),
          eq(interviewSessions.sessionId, sessionId),
        )).get();
        if (!session) throw new Error('SESSION_NOT_FOUND');
        if (session.status !== 'active') throw new Error('SESSION_NOT_ACTIVE');
        const message: TranscriptMessage = {
          message_id: `msg_${randomUUID()}`,
          role: input.role,
          text: input.text,
          timestamp: nowUtcIso(),
          provider: input.provider,
          ...(input.providerMessageId ? { provider_message_id: input.providerMessageId } : {}),
        };
        const transcript = parseTranscript(session.transcriptJson);
        tx.update(interviewSessions).set({
          transcriptJson: serializeTranscript([...transcript, message]),
          updatedAt: nowUtcIso(),
        }).where(and(
          eq(interviewSessions.userId, userId),
          eq(interviewSessions.sessionId, sessionId),
        )).run();
        return message;
      });
    } finally {
      connection.close();
    }
  }

  getForSession(userId: string, sessionId: string): TranscriptMessage[] | null {
    const connection = createDatabase(this.databasePath);
    try {
      const session = connection.db.select({ transcriptJson: interviewSessions.transcriptJson })
        .from(interviewSessions).where(and(
          eq(interviewSessions.userId, userId),
          eq(interviewSessions.sessionId, sessionId),
        )).get();
      return session ? parseTranscript(session.transcriptJson) : null;
    } finally {
      connection.close();
    }
  }

  getTranscriptsByStoryId(userId: string, storyId: string): StoryTranscriptHistory[] {
    return new StoryRepository(this.databasePath).getTranscriptsByStoryId(userId, storyId);
  }
}

export class ProfileRepository {
  constructor(private readonly databasePath?: string) {}

  findById(userId: string) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select().from(users).where(eq(users.userId, userId)).get() ?? null;
    } finally {
      connection.close();
    }
  }
}

export class LifeStageRepository {
  constructor(private readonly databasePath?: string) {}

  listV1ForUser(userId: string): LifeStageV1Record[] {
    return this.listForUser(userId).map(lifeStageV1Record);
  }

  createV1ForUser(userId: string, input: LifeStageV1Input): LifeStageV1Record {
    const stageId = randomUUID();
    const timestamp = nowUtcIso();
    const startDate = legacyDateFromYear(input.startYear);
    const endDate = legacyEndDateFromYear(input.endYear);
    const connection = createDatabase(this.databasePath);
    try {
      // One INSERT ... SELECT keeps the per-user max + 1 allocation atomic across connections.
      connection.sqlite.prepare(`
        INSERT INTO life_stages (
          stage_id, user_id, title, start_date, end_date, sort_order, status, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, COALESCE(MAX(sort_order), -1) + 1, 'active', ?, ?
        FROM life_stages
        WHERE user_id = ?
      `).run(stageId, userId, input.title, startDate, endDate, timestamp, timestamp, userId);
      const stage = connection.db.select().from(lifeStages).where(and(
        eq(lifeStages.userId, userId),
        eq(lifeStages.stageId, stageId),
      )).get();
      if (!stage) throw new Error('LIFE_STAGE_CREATE_FAILED');
      return lifeStageV1Record(stage);
    } finally {
      connection.close();
    }
  }

  updateV1ForUser(userId: string, stageId: string, input: LifeStageV1Input): LifeStageV1Record | null {
    const connection = createDatabase(this.databasePath);
    try {
      const result = connection.db.update(lifeStages).set({
        title: input.title,
        startDate: legacyDateFromYear(input.startYear),
        endDate: legacyEndDateFromYear(input.endYear),
        updatedAt: nowUtcIso(),
      }).where(and(
        eq(lifeStages.userId, userId),
        eq(lifeStages.stageId, stageId),
      )).run();
      if (result.changes !== 1) return null;
      const stage = connection.db.select().from(lifeStages).where(and(
        eq(lifeStages.userId, userId),
        eq(lifeStages.stageId, stageId),
      )).get();
      return stage ? lifeStageV1Record(stage) : null;
    } finally {
      connection.close();
    }
  }

  listForUser(userId: string) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select().from(lifeStages).where(eq(lifeStages.userId, userId)).orderBy(
        asc(lifeStages.sortOrder),
        asc(lifeStages.createdAt),
        asc(lifeStages.stageId),
      ).all();
    } finally {
      connection.close();
    }
  }

  findByIdForUser(userId: string, stageId: string) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select().from(lifeStages).where(and(
        eq(lifeStages.userId, userId),
        eq(lifeStages.stageId, stageId),
      )).get() ?? null;
    } finally {
      connection.close();
    }
  }

  deleteForUser(userId: string, stageId: string): LifeStageDeleteResult {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.transaction((tx) => {
        const stage = tx.select({ stageId: lifeStages.stageId }).from(lifeStages).where(and(
          eq(lifeStages.userId, userId),
          eq(lifeStages.stageId, stageId),
        )).get();
        if (!stage) return 'not_found';

        const story = tx.select({ storyId: stories.storyId }).from(stories)
          .where(eq(stories.stageId, stageId)).get();
        if (story) return 'has_stories';

        const result = tx.delete(lifeStages).where(and(
          eq(lifeStages.userId, userId),
          eq(lifeStages.stageId, stageId),
        )).run();
        return result.changes === 1 ? 'deleted' : 'not_found';
      });
    } finally {
      connection.close();
    }
  }
}

export class InterviewSessionRepository {
  constructor(private readonly databasePath?: string) {}

  findByIdForUser(userId: string, sessionId: string) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select().from(interviewSessions).where(and(
        eq(interviewSessions.userId, userId),
        eq(interviewSessions.sessionId, sessionId),
      )).get() ?? null;
    } finally {
      connection.close();
    }
  }

  setProviderSessionIdForUser(userId: string, sessionId: string, providerSessionId: string): boolean {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.update(interviewSessions).set({ providerSessionId }).where(and(
        eq(interviewSessions.userId, userId),
        eq(interviewSessions.sessionId, sessionId),
      )).run().changes === 1;
    } finally {
      connection.close();
    }
  }
}

export class MemoirDocumentRepository {
  constructor(private readonly databasePath?: string) {}

  listForStory(userId: string, storyId: string) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select({
        documentId: memoirDocuments.documentId,
        versionNumber: memoirDocuments.versionNumber,
        title: memoirDocuments.title,
        createdAt: memoirDocuments.createdAt,
      }).from(memoirDocuments).innerJoin(stories, and(
        eq(stories.storyId, memoirDocuments.scopeId),
        eq(stories.userId, memoirDocuments.userId),
      )).where(and(
        eq(stories.userId, userId),
        eq(stories.storyId, storyId),
        eq(memoirDocuments.userId, userId),
        eq(memoirDocuments.scopeType, 'story'),
        eq(memoirDocuments.scopeId, storyId),
      )).orderBy(desc(memoirDocuments.versionNumber), desc(memoirDocuments.createdAt)).all();
    } finally {
      connection.close();
    }
  }

  findForStoryForUser(userId: string, storyId: string, documentId: string) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select({
        documentId: memoirDocuments.documentId,
        userId: memoirDocuments.userId,
        scopeType: memoirDocuments.scopeType,
        scopeId: memoirDocuments.scopeId,
        title: memoirDocuments.title,
        content: memoirDocuments.content,
        versionNumber: memoirDocuments.versionNumber,
        status: memoirDocuments.status,
        sourceJson: memoirDocuments.sourceJson,
        createdAt: memoirDocuments.createdAt,
        updatedAt: memoirDocuments.updatedAt,
      }).from(memoirDocuments).innerJoin(stories, and(
        eq(stories.storyId, memoirDocuments.scopeId),
        eq(stories.userId, memoirDocuments.userId),
      )).where(and(
        eq(stories.userId, userId),
        eq(stories.storyId, storyId),
        eq(memoirDocuments.userId, userId),
        eq(memoirDocuments.documentId, documentId),
        eq(memoirDocuments.scopeType, 'story'),
        eq(memoirDocuments.scopeId, storyId),
      )).get() ?? null;
    } finally {
      connection.close();
    }
  }

  createNextVersion(input: {
    userId: string;
    storyId: string;
    title: string;
    content: string;
    sourceJson: string;
    expectedStoryUpdatedAt: string;
  }) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.transaction((tx) => {
        const story = tx.select({
          status: stories.status,
          updatedAt: stories.updatedAt,
        }).from(stories).where(and(
          eq(stories.userId, input.userId),
          eq(stories.storyId, input.storyId),
        )).get();
        if (!story) throw new Error('STORY_NOT_FOUND');
        if (story.status !== 'complete') throw new Error('STORY_NOT_COMPLETE');
        if (story.updatedAt !== input.expectedStoryUpdatedAt) {
          throw new Error('STORY_CHANGED_DURING_GENERATION');
        }

        const existing = connection.sqlite.prepare(`
          SELECT COALESCE(MAX(version_number), 0) AS currentVersion
          FROM memoir_documents
          WHERE user_id = ? AND scope_type = 'story' AND scope_id = ?
        `).get(input.userId, input.storyId) as { currentVersion: number };
        const now = nowUtcIso();
        const documentId = randomUUID();
        tx.insert(memoirDocuments).values({
          documentId,
          userId: input.userId,
          scopeType: 'story',
          scopeId: input.storyId,
          title: input.title,
          content: input.content,
          versionNumber: Number(existing.currentVersion) + 1,
          status: 'draft',
          sourceJson: input.sourceJson,
          createdAt: now,
          updatedAt: now,
        }).run();
        return tx.select().from(memoirDocuments).where(and(
          eq(memoirDocuments.userId, input.userId),
          eq(memoirDocuments.documentId, documentId),
        )).get() ?? null;
      });
    } finally {
      connection.close();
    }
  }

  findByIdForUser(userId: string, documentId: string) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select().from(memoirDocuments).where(and(
        eq(memoirDocuments.userId, userId),
        eq(memoirDocuments.documentId, documentId),
      )).get() ?? null;
    } finally {
      connection.close();
    }
  }

  updateContentForUser(userId: string, documentId: string, content: string): boolean {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.update(memoirDocuments).set({ content, updatedAt: nowUtcIso() }).where(and(
        eq(memoirDocuments.userId, userId),
        eq(memoirDocuments.documentId, documentId),
      )).run().changes === 1;
    } finally {
      connection.close();
    }
  }

  deleteForUser(userId: string, documentId: string): boolean {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.delete(memoirDocuments).where(and(
        eq(memoirDocuments.userId, userId),
        eq(memoirDocuments.documentId, documentId),
      )).run().changes === 1;
    } finally {
      connection.close();
    }
  }
}
