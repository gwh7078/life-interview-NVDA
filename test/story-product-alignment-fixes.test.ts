import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { interviewSessions, stories } from '../src/db/schema.js';
import {
  closeoutResultSchema,
  serializeJsonColumn,
  serializeTranscript,
} from '../src/db/transcript.js';
import { StoryRepository } from '../src/repositories/domain-repositories.js';
import { StoryCompletionContextBuilder } from '../src/story/completion/context-builder.js';
import { StoryCompletionPersistenceError, StoryCompletionPersistenceRepository } from '../src/story/completion/persistence.js';
import { buildStoryCompletionPrompt } from '../src/story/completion/prompt-builder.js';
import {
  createStoryGenerationService,
  DEFAULT_STORY_GENERATION_MAX_OUTPUT_TOKENS,
} from '../src/story/generation/runtime.js';
import type { TextModelProvider } from '../src/providers/text-model-provider.js';
import type { CloseoutModelConfig } from '../src/interview/llm-provider.js';

const temporaryDirectories: string[] = [];
const testTempRoot = path.resolve('data/test-tmp');
mkdirSync(testTempRoot, { recursive: true });

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function createSeededDatabase(prefix: string): string {
  const directory = mkdtempSync(path.join(testTempRoot, prefix));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  try {
    runMigrations(connection);
    seedDatabase(connection);
  } finally {
    connection.close();
  }
  return databasePath;
}

test('Completion keeps the optimistic-lock token server-side and discards stale evaluations', async () => {
  const sourceUpdatedAt = '2026-09-14T00:00:00.000Z';
  const context = await new StoryCompletionContextBuilder({
    loadForUser: () => ({
      title: '第一次离开家乡',
      agentMemory: '【故事背景】用户离开家乡开始第一份工作。\n【已覆盖主题】离开时间和第一份工作已经确认。',
      stageTitle: '初入职场',
      currentStatus: 'complete',
      sessionCount: 2,
      sourceUpdatedAt,
    }),
  }).build('owner', 'story');
  assert.equal(context.sourceUpdatedAt, sourceUpdatedAt);
  const prompt = buildStoryCompletionPrompt(context);
  assert.equal(prompt.user.includes('sourceUpdatedAt'), false, 'optimistic-lock metadata must never enter the model prompt');
  assert.match(prompt.system, /currentStatus/);
  assert.match(prompt.system, /complete/);

  const databasePath = createSeededDatabase('completion-cas-');
  const storiesRepo = new StoryRepository(databasePath);
  const before = storiesRepo.getDetailForUser(seedIds.user, seedIds.firstProject);
  assert.ok(before);

  const connection = createDatabase(databasePath);
  try {
    connection.db.update(stories).set({
      title: '并发修改后的标题',
      updatedAt: '2099-01-01T00:00:00.000Z',
    }).where(and(
      eq(stories.userId, seedIds.user),
      eq(stories.storyId, seedIds.firstProject),
    )).run();
  } finally {
    connection.close();
  }

  const persistence = new StoryCompletionPersistenceRepository(databasePath);
  assert.throws(
    () => persistence.updateCompletionForUser(
      seedIds.user,
      seedIds.firstProject,
      { status: 'interviewing', gaps: ['当时还有哪个关键场景没有讲清楚？'] },
      before.updatedAt,
    ),
    (error: unknown) => error instanceof StoryCompletionPersistenceError
      && error.code === 'STORY_CHANGED_DURING_COMPLETION',
  );
  const afterStaleAttempt = storiesRepo.getDetailForUser(seedIds.user, seedIds.firstProject);
  assert.equal(afterStaleAttempt?.title, '并发修改后的标题');
  assert.notDeepEqual(afterStaleAttempt?.gaps, ['当时还有哪个关键场景没有讲清楚？']);

  const accepted = persistence.updateCompletionForUser(
    seedIds.user,
    seedIds.firstProject,
    { status: 'complete', gaps: ['如果继续丰富，当时还有哪个细节最值得补充？'] },
    afterStaleAttempt!.updatedAt,
  );
  assert.deepEqual(accepted, { status: 'complete', gaps: ['如果继续丰富，当时还有哪个细节最值得补充？'] });
});

test('Completion persistence keeps a complete Story sticky while updating gaps', () => {
  const databasePath = createSeededDatabase('completion-sticky-');
  const connection = createDatabase(databasePath);
  try {
    connection.db.update(stories).set({
      status: 'complete',
      gapsJson: JSON.stringify(['初始缺口']),
      updatedAt: '2099-01-01T00:00:00.000Z',
    }).where(and(
      eq(stories.userId, seedIds.user),
      eq(stories.storyId, seedIds.firstProject),
    )).run();
  } finally {
    connection.close();
  }

  const storiesRepo = new StoryRepository(databasePath);
  const persistence = new StoryCompletionPersistenceRepository(databasePath);
  const evaluations: Array<{ status: 'interviewing' | 'pending'; gaps: string[] }> = [
    { status: 'interviewing', gaps: ['当时还有哪个具体细节没有讲到？'] },
    { status: 'pending', gaps: ['还有哪个关键事实需要你确认？'] },
  ];

  for (const evaluation of evaluations) {
    const current = storiesRepo.getDetailForUser(seedIds.user, seedIds.firstProject);
    assert.ok(current);
    const persisted = persistence.updateCompletionForUser(
      seedIds.user,
      seedIds.firstProject,
      evaluation,
      current.updatedAt,
    );

    assert.deepEqual(persisted, { status: 'complete', gaps: evaluation.gaps });
    const reloaded = storiesRepo.getDetailForUser(seedIds.user, seedIds.firstProject);
    assert.equal(reloaded?.status, 'complete');
    assert.deepEqual(reloaded?.gaps, evaluation.gaps);
  }
});

test('Generation includes cited side-Story creation evidence and requests an 8192-token output budget', async () => {
  const databasePath = createSeededDatabase('generation-side-story-');
  const sideStoryId = 'side-story-product-alignment';
  const timestamp = '2026-09-14T12:00:00.000Z';
  const citedMessage = {
    message_id: 'side-source-cited',
    role: 'user' as const,
    text: '旁支事实应保留：那天我第一次决定独自去上海。',
    timestamp,
    provider: 'test' as const,
  };
  const unrelatedMessage = {
    message_id: 'side-source-unrelated',
    role: 'user' as const,
    text: '来源会话里属于主故事的其他事实，不应该自动混入旁支故事。',
    timestamp: '2026-09-14T12:01:00.000Z',
    provider: 'test' as const,
  };

  const connection = createDatabase(databasePath);
  try {
    connection.db.insert(stories).values({
      storyId: sideStoryId,
      userId: seedIds.user,
      stageId: seedIds.work,
      title: '第一次独自去上海',
      summary: '用户第一次决定独自去上海。',
      status: 'complete',
      createdSourceSessionId: seedIds.storySession,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    connection.db.update(interviewSessions).set({
      transcriptJson: serializeTranscript([citedMessage, unrelatedMessage]),
      closeoutResultJson: serializeJsonColumn({
        current_story_source_message_ids: [],
        new_stories: [{ story_id: sideStoryId, source_message_ids: [citedMessage.message_id] }],
      }, closeoutResultSchema),
      updatedAt: timestamp,
    }).where(and(
      eq(interviewSessions.userId, seedIds.user),
      eq(interviewSessions.sessionId, seedIds.storySession),
    )).run();
  } finally {
    connection.close();
  }

  let capturedPrompt = '';
  let capturedConfig: CloseoutModelConfig | undefined;
  const provider: TextModelProvider = {
    async complete(prompt, config) {
      capturedPrompt = `${prompt.system}\n${prompt.user}`;
      capturedConfig = config;
      return {
        output: { content: '这是根据旁支故事事实整理出的测试正文。' },
        model: 'fake-generation-model',
        latencyMs: 1,
      };
    },
  };
  const service = createStoryGenerationService(databasePath, {
    provider: 'test',
    apiKey: 'test-key',
  }, provider);
  const document = await service.generate({
    ownerId: seedIds.user,
    storyId: sideStoryId,
    style: 'documentary',
  });

  assert.equal(DEFAULT_STORY_GENERATION_MAX_OUTPUT_TOKENS, 8_192);
  assert.equal(capturedConfig?.maxOutputTokens, 8_192);
  assert.match(capturedPrompt, /旁支事实应保留：那天我第一次决定独自去上海/);
  assert.doesNotMatch(capturedPrompt, /来源会话里属于主故事的其他事实/);
  const source = JSON.parse(document.sourceJson) as { sessionIds?: string[] };
  assert.deepEqual(source.sessionIds, [seedIds.storySession]);
});

test('Story Detail always enters the Documents empty state before first-generation modal', () => {
  const storyScript = readFileSync(path.resolve('public/story.js'), 'utf8');
  const documentsScript = readFileSync(path.resolve('public/documents.js'), 'utf8');
  assert.equal(storyScript.includes('?generate=1'), false);
  assert.equal(documentsScript.includes('wantsInitialGeneration'), false);
  assert.equal(documentsScript.includes("get('generate')"), false);
});
