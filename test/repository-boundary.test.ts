import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { accounts, interviewSessions, lifeStages, memoirDocuments, stories, users } from '../src/db/schema.js';
import { StoryInterviewContextBuilder } from '../src/interview/context/story-interview-context.js';
import { buildInterviewContextPayload, buildInterviewInstructions } from '../src/realtime/prompt.js';
import {
  StoryCompletionContextBuilder,
  StoryCompletionProcessor,
  StoryCompletionService,
  StoryCompletionValidationError,
} from '../src/story/completion/index.js';
import {
  InterviewSessionRepository,
  LifeStageRepository,
  MemoirDocumentRepository,
  StoryRepository,
  TranscriptRepository,
} from '../src/repositories/domain-repositories.js';

const temporaryDirectories: string[] = [];
const testTempRoot = path.resolve('data/test-tmp');
mkdirSync(testTempRoot, { recursive: true });

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

test('domain repositories enforce user ownership for Story, LifeStage, Session, Transcript, and Document data', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-repository-boundary-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'boundary.db');
  const database = createDatabase(databasePath);
  const timestamp = '2026-09-13T00:00:00.000Z';
  const userA = 'boundary-user-a';
  const userB = 'boundary-user-b';
  const stageA = 'boundary-stage-a';
  const stageA2 = 'boundary-stage-a2';
  const stageB = 'boundary-stage-b';
  const storyA = 'boundary-story-a';
  const storyB = 'boundary-story-b';
  const sessionA = 'boundary-session-a';
  const sessionB = 'boundary-session-b';
  const documentA = 'boundary-document-a';
  const documentB = 'boundary-document-b';
  try {
    runMigrations(database);
    database.db.transaction((tx) => {
      tx.insert(accounts).values([
        { accountId: 'boundary-account-a', phone: null, phoneVerified: false, status: 'legacy', createdAt: timestamp, updatedAt: timestamp },
        { accountId: 'boundary-account-b', phone: null, phoneVerified: false, status: 'legacy', createdAt: timestamp, updatedAt: timestamp },
      ]).run();
      tx.insert(users).values([
        { userId: userA, accountId: 'boundary-account-a', name: '档案 A', createdAt: timestamp, updatedAt: timestamp },
        { userId: userB, accountId: 'boundary-account-b', name: '档案 B', createdAt: timestamp, updatedAt: timestamp },
      ]).run();
      tx.insert(lifeStages).values([
        { stageId: stageA, userId: userA, title: '阶段 A', sortOrder: 1, createdAt: timestamp, updatedAt: timestamp },
        { stageId: stageA2, userId: userA, title: '阶段 A2', sortOrder: 2, createdAt: timestamp, updatedAt: timestamp },
        { stageId: stageB, userId: userB, title: '阶段 B', sortOrder: 1, createdAt: timestamp, updatedAt: timestamp },
      ]).run();
      tx.insert(stories).values([
        { storyId: storyA, userId: userA, stageId: stageA, title: '故事 A', summary: '摘要 A', agentMemory: '摘要 A', status: 'complete', createdAt: timestamp, updatedAt: timestamp },
        { storyId: storyB, userId: userB, stageId: stageB, title: '故事 B', summary: '摘要 B', agentMemory: '摘要 B', createdAt: timestamp, updatedAt: timestamp },
      ]).run();
      tx.insert(interviewSessions).values([
        { sessionId: sessionA, provider: 'qwen', userId: userA, stageId: null, storyId: storyA, sessionType: 'story', startedAt: timestamp, createdAt: timestamp, updatedAt: timestamp },
        { sessionId: sessionB, provider: 'doubao', userId: userB, stageId: null, storyId: storyB, sessionType: 'story', startedAt: timestamp, createdAt: timestamp, updatedAt: timestamp },
      ]).run();
      tx.insert(memoirDocuments).values([
        { documentId: documentA, userId: userA, scopeType: 'story', scopeId: storyA, title: '文稿 A', content: '内容 A', createdAt: timestamp, updatedAt: timestamp },
        { documentId: documentB, userId: userB, scopeType: 'story', scopeId: storyB, title: '文稿 B', content: '内容 B', createdAt: timestamp, updatedAt: timestamp },
      ]).run();
    });
    database.sqlite.prepare('UPDATE stories SET gaps_json = ? WHERE story_id = ?')
      .run('["尚待补充的问题"]', storyA);
  } finally {
    database.close();
  }

  const storiesRepo = new StoryRepository(databasePath);
  const stagesRepo = new LifeStageRepository(databasePath);
  const sessionsRepo = new InterviewSessionRepository(databasePath);
  const transcriptRepo = new TranscriptRepository(databasePath);
  const documentsRepo = new MemoirDocumentRepository(databasePath);

  const ownTranscript = transcriptRepo.appendForSession(userA, sessionA, {
    role: 'user', text: '只属于档案 A 的原始记录。', provider: 'qwen', providerMessageId: 'a-message',
  });
  transcriptRepo.appendForSession(userB, sessionB, {
    role: 'user', text: '只属于档案 B 的原始记录。', provider: 'doubao', providerMessageId: 'b-message',
  });

  assert.equal(storiesRepo.findByIdForUser(userA, storyA)?.storyId, storyA);
  assert.equal(storiesRepo.findByIdForUser(userA, storyB), null);
  assert.equal(storiesRepo.getDetailForUser(userA, storyA)?.gaps.length, 1);
  assert.equal(storiesRepo.getDetailForUser(userA, storyB), null);
  const continuation = new StoryInterviewContextBuilder(databasePath).build(userA, { mode: 'continue', storyId: storyA });
  assert.deepEqual(continuation.story?.gaps, ['尚待补充的问题']);
  assert.deepEqual((buildInterviewContextPayload(continuation).story as Record<string, unknown>).gaps, []);
  const continuationInstructions = buildInterviewInstructions(continuation);
  assert.match(continuationInstructions, /\"agent_memory\": \"摘要 A\"/);
  assert.doesNotMatch(continuationInstructions, /\"summary\": \"摘要 A\"/);
  assert.doesNotMatch(continuationInstructions, /尚待补充的问题/);
  assert.deepEqual(storiesRepo.listForUser(userA).map((story) => story.story_id), [storyA]);
  assert.equal(storiesRepo.updateTitleForUser(userA, storyB, '越权标题'), false);
  assert.equal(storiesRepo.updateTitleForUser(userA, storyA, '故事 A 新标题'), true);
  assert.deepEqual(storiesRepo.getCompletionDataForUser(userA, storyA), {
    title: '故事 A 新标题',
    agentMemory: '摘要 A',
    stageTitle: '阶段 A',
    currentStatus: 'complete',
    interviewSessionCount: 1,
  });
  const priorCompletion = storiesRepo.getDetailForUser(userA, storyA);
  assert.ok(priorCompletion);
  let completionModelCalls = 0;
  const completionService = new StoryCompletionService(
    new StoryCompletionContextBuilder({
      loadForUser(userId, storyId) {
        const completion = storiesRepo.getCompletionDataForUser(userId, storyId);
        return completion ? {
          title: completion.title,
          agentMemory: completion.agentMemory,
          stageTitle: completion.stageTitle,
          currentStatus: completion.currentStatus,
          sessionCount: completion.interviewSessionCount,
        } : null;
      },
    }),
    new StoryCompletionProcessor({
      async complete() {
        completionModelCalls += 1;
        return { status: 'invalid', gaps: [] };
      },
    }),
    {
      updateCompletionForUser(userId, storyId, output) {
        const updated = storiesRepo.updateCompletionForUser(userId, storyId, output);
        if (!updated) throw new Error('STORY_NOT_FOUND');
        return updated;
      },
    },
  );
  await assert.rejects(completionService.evaluate(userA, storyA), StoryCompletionValidationError);
  assert.equal(completionModelCalls, 3);
  assert.deepEqual(
    { status: storiesRepo.getDetailForUser(userA, storyA)?.status, gaps: storiesRepo.getDetailForUser(userA, storyA)?.gaps },
    { status: priorCompletion.status, gaps: priorCompletion.gaps },
    'three failed evaluations must preserve the previously persisted status and gaps',
  );
  assert.throws(() => storiesRepo.updateCompletionForUser(userA, storyA, {
    status: 'complete', gaps: ['问题一？', '问题二？', '问题三？', '问题四？'],
  }), /STORY_COMPLETION_OUTPUT_INVALID/);
  assert.throws(() => storiesRepo.updateCompletionForUser(userA, storyA, {
    status: 'interviewing', gaps: ['继续补充结尾'],
  }), /STORY_COMPLETION_OUTPUT_INVALID/);
  assert.deepEqual(storiesRepo.updateCompletionForUser(userA, storyA, {
    status: 'interviewing', gaps: ['这个故事最后是怎么结束的？'],
  }), { status: 'complete', gaps: ['这个故事最后是怎么结束的？'] }, 'complete status stays sticky while gaps refresh');
  assert.equal(storiesRepo.updateCompletionForUser(userA, storyB, {
    status: 'complete', gaps: [],
  }), null);
  assert.equal(storiesRepo.updateSummaryForUser(userA, storyB, '越权写入'), false);
  assert.equal(storiesRepo.deleteForUser(userA, storyB), false);
  assert.deepEqual(storiesRepo.getTranscriptsByStoryId(userA, storyA).map((item) => item.messages[0]?.message_id), [ownTranscript.message_id]);
  assert.deepEqual(storiesRepo.getTranscriptsByStoryId(userA, storyB), []);

  assert.equal(stagesRepo.findByIdForUser(userA, stageA)?.stageId, stageA);
  assert.equal(stagesRepo.findByIdForUser(userA, stageB), null);
  assert.equal(stagesRepo.deleteForUser(userA, stageB), 'not_found');
  assert.equal(stagesRepo.deleteForUser(userA, stageA), 'has_stories');
  assert.equal(stagesRepo.findByIdForUser(userA, stageA)?.stageId, stageA);

  assert.equal(storiesRepo.moveToStageForUser(userA, storyB, stageA2), 'story_not_found');
  assert.equal(storiesRepo.moveToStageForUser(userA, storyA, stageB), 'stage_not_found');
  assert.equal(storiesRepo.moveToStageForUser(userA, storyA, stageA2), 'moved');
  assert.equal(stagesRepo.deleteForUser(userA, stageA), 'deleted');
  assert.equal(stagesRepo.findByIdForUser(userA, stageA), null);

  const nullStage = stagesRepo.createV1ForUser(userA, {
    title: '创业阶段', startYear: null, endYear: null,
  });
  const yearStage = stagesRepo.createV1ForUser(userA, {
    title: '创业阶段', startYear: 2015, endYear: 2020,
  });
  const currentStage = stagesRepo.createV1ForUser(userA, {
    title: '创业阶段', startYear: 2018, endYear: 'now',
  });
  assert.equal(nullStage.startYear, null);
  assert.equal(nullStage.endYear, null);
  assert.equal(yearStage.startYear, 2015);
  assert.equal(yearStage.endYear, 2020);
  assert.equal(currentStage.startYear, 2018);
  assert.equal(currentStage.endYear, 'now');
  assert.deepEqual(
    [nullStage.sortOrder, yearStage.sortOrder, currentStage.sortOrder],
    [nullStage.sortOrder, nullStage.sortOrder + 1, nullStage.sortOrder + 2],
  );
  assert.equal(stagesRepo.updateV1ForUser(userA, stageB, {
    title: '越权编辑', startYear: 2000, endYear: null,
  }), null);
  const updatedStage = stagesRepo.updateV1ForUser(userA, nullStage.stageId, {
    title: '创业阶段', startYear: 1999, endYear: 'now',
  });
  assert.equal(updatedStage?.startYear, 1999);
  assert.equal(updatedStage?.endYear, 'now');
  assert.deepEqual(
    stagesRepo.listV1ForUser(userA).filter((stage) => stage.title === '创业阶段')
      .map((stage) => stage.stageId).sort(),
    [nullStage.stageId, yearStage.stageId, currentStage.stageId].sort(),
  );
  assert.equal(stagesRepo.listV1ForUser(userA).some((stage) => stage.stageId === stageB), false);
  assert.equal(stagesRepo.deleteForUser(userA, yearStage.stageId), 'deleted');
  assert.equal(stagesRepo.deleteForUser(userA, yearStage.stageId), 'not_found');

  assert.equal(sessionsRepo.findByIdForUser(userA, sessionA)?.sessionId, sessionA);
  assert.equal(sessionsRepo.findByIdForUser(userA, sessionB), null);
  assert.equal(sessionsRepo.setProviderSessionIdForUser(userA, sessionB, 'forged-provider-session'), false);
  assert.equal(transcriptRepo.getForSession(userA, sessionB), null);
  assert.throws(() => transcriptRepo.appendForSession(userA, sessionB, {
    role: 'user', text: '不可写入他人的 Transcript。', provider: 'qwen',
  }), /SESSION_NOT_FOUND/);

  assert.equal(documentsRepo.findByIdForUser(userA, documentA)?.content, '内容 A');
  assert.equal(documentsRepo.findByIdForUser(userA, documentB), null);
  assert.deepEqual(documentsRepo.listForStory(userA, storyA).map((document) => document.versionNumber), [1]);
  assert.equal(documentsRepo.findForStoryForUser(userA, storyA, documentB), null);
  const storyVersionBeforeGeneration = storiesRepo.findByIdForUser(userA, storyA)?.updatedAt;
  assert.ok(storyVersionBeforeGeneration);
  const versionTwo = documentsRepo.createNextVersion({
    userId: userA,
    storyId: storyA,
    title: '故事 A 新标题',
    content: '第二版内容',
    sourceJson: '{"storyId":"boundary-story-a","generationMode":"revision"}',
    expectedStoryUpdatedAt: storyVersionBeforeGeneration,
  });
  assert.equal(versionTwo?.versionNumber, 2);
  assert.equal(versionTwo?.status, 'draft');
  assert.equal(versionTwo?.scopeType, 'story');
  assert.equal(documentsRepo.listForStory(userA, storyA)[0]?.documentId, versionTwo?.documentId);
  assert.equal(documentsRepo.findForStoryForUser(userA, storyA, versionTwo!.documentId)?.content, '第二版内容');
  assert.equal(documentsRepo.updateContentForUser(userA, documentB, '越权文稿'), false);
  assert.equal(documentsRepo.deleteForUser(userA, documentB), false);

  const verify = createDatabase(databasePath);
  try {
    const movedStory = verify.db.select().from(stories).where(eq(stories.storyId, storyA)).get();
    assert.equal(movedStory?.stageId, stageA2);
    assert.equal(movedStory?.title, '故事 A 新标题');
    assert.equal(movedStory?.summary, '摘要 A');
    assert.equal(movedStory?.status, 'complete');
    assert.notEqual(movedStory?.updatedAt, timestamp);
    const movedStoryGaps = verify.sqlite.prepare('SELECT gaps_json FROM stories WHERE story_id = ?')
      .get(storyA) as { gaps_json: string } | undefined;
    assert.equal(movedStoryGaps?.gaps_json, '["这个故事最后是怎么结束的？"]');
    assert.equal(verify.db.select().from(stories).where(eq(stories.storyId, storyB)).get()?.summary, '摘要 B');
    const movedSession = verify.db.select().from(interviewSessions)
      .where(eq(interviewSessions.sessionId, sessionA)).get();
    assert.equal(movedSession?.storyId, storyA);
    assert.equal(movedSession?.transcriptJson.includes(ownTranscript.message_id), true);
    assert.equal(verify.db.select().from(memoirDocuments)
      .where(eq(memoirDocuments.documentId, documentA)).get()?.content, '内容 A');
    assert.equal(verify.db.select().from(interviewSessions).where(eq(interviewSessions.sessionId, sessionB)).get()?.providerSessionId, null);
    assert.equal(verify.db.select().from(memoirDocuments).where(eq(memoirDocuments.documentId, documentB)).get()?.content, '内容 B');
    const updatedStageDates = verify.sqlite.prepare('SELECT start_date, end_date FROM life_stages WHERE stage_id = ?')
      .get(nullStage.stageId) as { start_date: string | null; end_date: string | null } | undefined;
    assert.equal(updatedStageDates?.start_date, '1999');
    assert.equal(updatedStageDates?.end_date, 'now');
    const currentStageDates = verify.sqlite.prepare('SELECT start_date, end_date FROM life_stages WHERE stage_id = ?')
      .get(currentStage.stageId) as { start_date: string | null; end_date: string | null } | undefined;
    assert.equal(currentStageDates?.start_date, '2018');
    assert.equal(currentStageDates?.end_date, 'now');
  } finally {
    verify.close();
  }
});
