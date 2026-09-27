import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../db/client.js';
import { closeoutResultSchema, parseTranscript, serializeJsonColumn } from '../db/transcript.js';
import { nowUtcIso } from '../db/time.js';
import { interviewSessions, lifeStages, stories } from '../db/schema.js';
import type { StoryCloseoutContext } from '../interview/closeout/context-builder.js';
import type { ValidatedStoryCloseoutOutput } from '../interview/closeout/types.js';

export class StoryCloseoutRepositoryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'StoryCloseoutRepositoryError';
  }
}

export interface AppliedStoryCloseout {
  sessionId: string;
  storyId: string;
  storyUpdated: boolean;
  createdStoryIds: string[];
}

function normalizeTitle(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function sourceIdsBelongToUser(sourceIds: string[], transcript: ReturnType<typeof parseTranscript>): boolean {
  const userIds = new Set(transcript.filter((message) => message.role === 'user').map((message) => message.message_id));
  return new Set(sourceIds).size === sourceIds.length && sourceIds.every((id) => userIds.has(id));
}

/** Transactional persistence boundary for already-validated closeout decisions. */
export class StoryCloseoutRepository {
  constructor(private readonly databasePath?: string) {}

  apply(input: {
    context: StoryCloseoutContext;
    output: ValidatedStoryCloseoutOutput;
    expectedAttemptId: string;
    modelMetadata: Record<string, unknown>;
    expectedStoryUpdatedAt?: string;
  }): AppliedStoryCloseout {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.transaction((tx) => {
        const { context, output } = input;
        const session = tx.select().from(interviewSessions).where(and(
          eq(interviewSessions.sessionId, context.sessionId),
          eq(interviewSessions.userId, context.userId),
        )).get();
        if (!session) throw new StoryCloseoutRepositoryError('找不到这次访谈。', 'SESSION_NOT_FOUND');
        if (session.sessionType !== 'story' || !session.endedAt || session.status === 'active') {
          throw new StoryCloseoutRepositoryError('访谈还没有结束，不能写入整理结果。', 'SESSION_NOT_ENDED');
        }
        if (session.sourceType !== 'subject') {
          throw new StoryCloseoutRepositoryError('外部贡献者访谈不能写入主人公 Story。', 'INVALID_SESSION_SOURCE');
        }
        if (session.closeoutStatus === 'completed') {
          throw new StoryCloseoutRepositoryError('这次访谈已经完成整理。', 'SESSION_CLOSEOUT_ALREADY_APPLIED');
        }
        let closeoutState: ReturnType<typeof closeoutResultSchema.parse> = {};
        try { closeoutState = closeoutResultSchema.parse(session.closeoutResultJson ? JSON.parse(session.closeoutResultJson) : {}); }
        catch { closeoutState = {}; }
        if (session.closeoutStatus !== 'processing' || closeoutState.processing_attempt_id !== input.expectedAttemptId) {
          throw new StoryCloseoutRepositoryError('本次整理任务已失去写入权。', 'CLOSEOUT_ATTEMPT_STALE');
        }

        let transcript: ReturnType<typeof parseTranscript>;
        try { transcript = parseTranscript(session.transcriptJson); }
        catch { throw new StoryCloseoutRepositoryError('访谈原始记录无法读取，整理已停止。', 'TRANSCRIPT_INVALID'); }
        const sourceSets = output.mode === 'create'
          ? [output.story.source_message_ids]
          : [output.current_story.source_message_ids, ...output.new_stories.map((story) => story.source_message_ids)];
        if (sourceSets.some((sourceIds) => !sourceIdsBelongToUser(sourceIds, transcript))) {
          throw new StoryCloseoutRepositoryError('整理结果引用了无效或重复的用户消息来源。', 'INVALID_SOURCE_MESSAGE_IDS');
        }

        const timestamp = nowUtcIso();
        let storyId: string;
        let storyUpdated = false;
        let createdStoryIds: string[] = [];
        let resultData: Record<string, unknown>;

        if (output.mode === 'continue') {
          if (!context.currentStory || session.storyId !== context.currentStory.story_id || session.stageId !== null) {
            throw new StoryCloseoutRepositoryError('访谈与现有 Story 的关联已变化。', 'DATA_RELATION_INVALID');
          }
          const story = tx.select().from(stories).where(and(
            eq(stories.storyId, context.currentStory.story_id),
            eq(stories.userId, context.userId),
          )).get();
          if (!story) throw new StoryCloseoutRepositoryError('找不到这次访谈对应的故事。', 'STORY_NOT_FOUND');
          const stage = tx.select().from(lifeStages).where(and(
            eq(lifeStages.stageId, story.stageId),
            eq(lifeStages.userId, context.userId),
          )).get();
          if (!stage) throw new StoryCloseoutRepositoryError('找不到对应的人生阶段。', 'LIFE_STAGE_NOT_FOUND');
          if (input.expectedStoryUpdatedAt && story.updatedAt !== input.expectedStoryUpdatedAt) {
            throw new StoryCloseoutRepositoryError('Story 在整理期间发生变化；未写入过期摘要。', 'STORY_CHANGED_DURING_CLOSEOUT');
          }
          if ((output.current_story.summary !== story.summary || output.current_story.agent_memory !== story.agentMemory)
            && output.current_story.source_message_ids.length === 0) {
            throw new StoryCloseoutRepositoryError('更新后的摘要或 Agent Memory 缺少来源消息。', 'SOURCE_MESSAGE_IDS_REQUIRED');
          }

          const existingTitles = new Set(tx.select({ title: stories.title }).from(stories)
            .where(eq(stories.userId, context.userId)).all().map((item) => normalizeTitle(item.title)));
          const seenTitles = new Set<string>();
          for (const candidate of output.new_stories) {
            const titleKey = normalizeTitle(candidate.title);
            if (existingTitles.has(titleKey) || seenTitles.has(titleKey)) {
              throw new StoryCloseoutRepositoryError('新故事标题与已有故事重复。', 'DUPLICATE_STORY');
            }
            seenTitles.add(titleKey);
            const targetStage = tx.select({ stageId: lifeStages.stageId }).from(lifeStages).where(and(
              eq(lifeStages.stageId, candidate.stage_id),
              eq(lifeStages.userId, context.userId),
            )).get();
            if (!targetStage) throw new StoryCloseoutRepositoryError('新故事选择的人生阶段不属于当前档案。', 'INVALID_STORY_STAGE');
          }

          storyId = story.storyId;
          storyUpdated = story.summary !== output.current_story.summary
            || story.agentMemory !== output.current_story.agent_memory;
          if (storyUpdated) {
            tx.update(stories).set({
              summary: output.current_story.summary,
              agentMemory: output.current_story.agent_memory,
              updatedAt: timestamp,
            }).where(and(
              eq(stories.storyId, story.storyId),
              eq(stories.userId, context.userId),
            )).run();
          }
          const created = output.new_stories.map((candidate) => ({
            id: randomUUID(),
            sourceMessageIds: candidate.source_message_ids,
          }));
          for (const [index, candidate] of output.new_stories.entries()) {
            const createdStory = created[index]!;
            tx.insert(stories).values({
              storyId: createdStory.id,
              userId: context.userId,
              stageId: candidate.stage_id,
              title: candidate.title,
              summary: candidate.summary,
              agentMemory: candidate.summary,
              status: 'pending',
              createdSourceSessionId: context.sessionId,
              createdAt: timestamp,
              updatedAt: timestamp,
            }).run();
          }
          createdStoryIds = created.map((item) => item.id);
          resultData = {
            current_story_source_message_ids: output.current_story.source_message_ids,
            new_stories: created.map((item) => ({ story_id: item.id, source_message_ids: item.sourceMessageIds })),
            model_metadata: input.modelMetadata,
          };
        } else {
          if (session.storyId !== null || session.stageId !== output.stage_id || context.currentStageId !== output.stage_id) {
            throw new StoryCloseoutRepositoryError('新建 Story 的目标阶段关联已变化。', 'DATA_RELATION_INVALID');
          }
          const stage = tx.select({ stageId: lifeStages.stageId }).from(lifeStages).where(and(
            eq(lifeStages.stageId, output.stage_id),
            eq(lifeStages.userId, context.userId),
          )).get();
          if (!stage) throw new StoryCloseoutRepositoryError('目标人生阶段不属于当前档案。', 'INVALID_STORY_STAGE');
          const duplicate = tx.select({ title: stories.title }).from(stories).where(eq(stories.userId, context.userId)).all()
            .some((item) => normalizeTitle(item.title) === normalizeTitle(output.story.title));
          if (duplicate) throw new StoryCloseoutRepositoryError('新故事标题与已有故事重复。', 'DUPLICATE_STORY');
          storyId = randomUUID();
          tx.insert(stories).values({
            storyId,
            userId: context.userId,
            stageId: output.stage_id,
            title: output.story.title,
            summary: output.story.summary,
            agentMemory: output.story.agent_memory,
            status: 'pending',
            createdSourceSessionId: context.sessionId,
            createdAt: timestamp,
            updatedAt: timestamp,
          }).run();
          createdStoryIds = [storyId];
          resultData = {
            current_story_source_message_ids: [],
            new_stories: [{ story_id: storyId, source_message_ids: output.story.source_message_ids }],
            model_metadata: input.modelMetadata,
          };
        }

        const closeoutResultJson = serializeJsonColumn(resultData, closeoutResultSchema);
        tx.update(interviewSessions).set({
          ...(output.mode === 'create' ? { storyId, stageId: null } : {}),
          closeoutResultJson,
          status: 'completed',
          closeoutStatus: 'completed',
          updatedAt: timestamp,
        }).where(and(
          eq(interviewSessions.sessionId, context.sessionId),
          eq(interviewSessions.userId, context.userId),
          eq(interviewSessions.closeoutStatus, 'processing'),
        )).run();

        return { sessionId: context.sessionId, storyId, storyUpdated, createdStoryIds };
      });
    } finally {
      connection.close();
    }
  }
}
