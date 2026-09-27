import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { stories } from '../src/db/schema.js';
import { StoryRepository } from '../src/repositories/domain-repositories.js';
import { StoryCompletionPersistenceError, StoryCompletionPersistenceRepository } from '../src/story/completion/persistence.js';
import {
  StoryCompletionContextBuilder,
  StoryCompletionContextError,
  StoryCompletionModelError,
  StoryCompletionProcessor,
  StoryCompletionService,
  StoryCompletionValidationError,
  StoryCompletionValidator,
  STORY_COMPLETION_MAX_MODEL_CALLS,
  STORY_COMPLETION_SCHEMA_NAME,
  buildStoryCompletionPrompt,
  storyCompletionJsonSchema,
} from '../src/story/completion/index.js';
import type {
  StoryCompletionContext,
  StoryCompletionModelRequest,
  StoryCompletionOutput,
} from '../src/story/completion/index.js';

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

const context: StoryCompletionContext = {
  title: '第一次离开家乡',
  agentMemory: '【故事背景】用户在毕业后离开家乡，开始第一份工作。\n【已覆盖主题】已经讲清楚离开时间，尚未讲清楚决定原因。',
  stageTitle: '初入职场',
  currentStatus: 'interviewing',
  previousGaps: ['当时你为什么决定离开家乡？'],
  blockedDirections: [],
  sessionCount: 2,
};

const validOutput: StoryCompletionOutput = {
  status: 'interviewing',
  gaps: ['当时你为什么决定离开家乡？'],
};

test('schema and validator enforce the exact status + gaps contract', () => {
  assert.deepEqual(storyCompletionJsonSchema, {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pending', 'interviewing', 'complete'] },
      gaps: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 3 },
    },
    required: ['status', 'gaps'],
    additionalProperties: false,
  });

  const validator = new StoryCompletionValidator();
  assert.deepEqual(validator.validate({ status: 'complete', gaps: ['  如果还想继续丰富，当时谁对你的决定影响最大？  '] }), {
    status: 'complete',
    gaps: ['如果还想继续丰富，当时谁对你的决定影响最大？'],
  });
  assert.deepEqual(validator.validate({ status: 'pending', gaps: [] }), { status: 'pending', gaps: [] });

  for (const candidate of [
    { status: 'complete', gaps: [], reason: 'unsupported' },
    { status: 'done', gaps: [] },
    { status: 'pending', gaps: ['a', 'b', 'c', 'd'] },
    { status: 'pending', gaps: ['  '] },
    { status: 'pending', gaps: ['缺少离开家乡的原因。'] },
    { status: 'pending', gaps: ['为什么离开家乡？后来发生了什么？'] },
    { status: 'pending', gaps: [`${'很长的问题'.repeat(30)}？`] },
    { status: 'pending', gaps: [3] },
    { status: 'pending' },
  ]) {
    assert.throws(() => validator.validate(candidate), StoryCompletionValidationError);
  }
});

test('context builder owner-scopes loading and projects only approved fields', async () => {
  const calls: Array<[string, string]> = [];
  const builder = new StoryCompletionContextBuilder({
    loadForUser(userId, storyId) {
      calls.push([userId, storyId]);
      return {
        ...context,
        userId: 'user-secret',
        storyId: 'story-secret',
        transcript: 'transcript-secret',
      } as StoryCompletionContext;
    },
  });

  const built = await builder.build('owner-1', 'story-1');
  assert.deepEqual(calls, [['owner-1', 'story-1']]);
  assert.deepEqual(built, context);
  assert.deepEqual(Object.keys(built).sort(), [
    'agentMemory', 'blockedDirections', 'currentStatus', 'previousGaps', 'sessionCount', 'stageTitle', 'title',
  ]);

  const missing = new StoryCompletionContextBuilder({ loadForUser: () => null });
  await assert.rejects(missing.build('owner-1', 'missing'), (error: unknown) => {
    assert.ok(error instanceof StoryCompletionContextError);
    assert.equal(error.code, 'STORY_NOT_FOUND');
    return true;
  });
});

test('prompt serializes only Story Completion context and includes rolling-gap guidance', () => {
  const contextWithExtraFields = {
    ...context,
    userId: 'user-secret',
    accountId: 'account-secret',
    transcript: 'transcript-secret',
  } as StoryCompletionContext;
  const prompt = buildStoryCompletionPrompt(contextWithExtraFields);
  const serializedContext = JSON.parse(prompt.user.slice(prompt.user.indexOf('\n') + 1)) as Record<string, unknown>;
  assert.deepEqual(serializedContext, context);
  assert.match(prompt.system, /Agent Memory/);
  assert.match(prompt.system, /complete/);
  assert.match(prompt.system, /直接问用户/);
  assert.match(prompt.system, /previousGaps/);
  assert.match(prompt.system, /blockedDirections/);
  assert.doesNotMatch(prompt.system, /fresh gaps/);
  assert.match(prompt.system, /一个 gap 只问一个方向/);
  for (const forbiddenField of ['reason', 'confidence', 'percentage', 'analysis', 'reasoning']) {
    assert.match(prompt.system, new RegExp(forbiddenField));
  }
  assert.equal(JSON.stringify(prompt).includes('user-secret'), false);
  assert.equal(JSON.stringify(prompt).includes('transcript-secret'), false);
});

test('processor retries transient model errors but never exceeds three calls', async () => {
  assert.equal(STORY_COMPLETION_MAX_MODEL_CALLS, 3);
  let calls = 0;
  let capturedRequest: StoryCompletionModelRequest | undefined;
  const processor = new StoryCompletionProcessor({
    async complete(request) {
      calls += 1;
      capturedRequest = request;
      if (calls < 3) throw new StoryCompletionModelError('temporary provider issue', 'MODEL_HTTP_503', true);
      return JSON.stringify(validOutput);
    },
  });

  assert.deepEqual(await processor.process(context), validOutput);
  assert.equal(calls, 3);
  assert.equal(capturedRequest?.schema.name, STORY_COMPLETION_SCHEMA_NAME);
  assert.deepEqual(capturedRequest?.schema.jsonSchema, storyCompletionJsonSchema);
});

test('processor retries parse and validator errors, and stops after the third failure', async () => {
  let recoveringCalls = 0;
  const recovering = new StoryCompletionProcessor({
    async complete() {
      recoveringCalls += 1;
      if (recoveringCalls === 1) return '{broken';
      if (recoveringCalls === 2) return { status: 'interviewing', gaps: ['gap'], extra: true };
      return validOutput;
    },
  });
  assert.deepEqual(await recovering.process(context), validOutput);
  assert.equal(recoveringCalls, 3);

  let failingCalls = 0;
  const failing = new StoryCompletionProcessor({
    async complete() {
      failingCalls += 1;
      return { status: 'invalid', gaps: [] };
    },
  });
  await assert.rejects(failing.process(context), StoryCompletionValidationError);
  assert.equal(failingCalls, 3);
});

test('invalid structured output makes at most three calls and never reaches persistence', async () => {
  let calls = 0;
  let writes = 0;
  const service = new StoryCompletionService(
    { async build() { return context; } },
    new StoryCompletionProcessor({
      async complete() {
        calls += 1;
        return { status: 'unknown', gaps: [] };
      },
    }),
    {
      updateCompletionForUser() {
        writes += 1;
        return validOutput;
      },
    },
  );

  await assert.rejects(service.evaluate('owner-1', 'story-1'), StoryCompletionValidationError);
  assert.equal(calls, STORY_COMPLETION_MAX_MODEL_CALLS);
  assert.equal(writes, 0);
});

test('processor does not retry nonretryable provider or programming errors', async () => {
  for (const failure of [
    new StoryCompletionModelError('configuration is invalid', 'MODEL_CONFIG_INVALID', false),
    new Error('programming failure'),
  ]) {
    let calls = 0;
    const processor = new StoryCompletionProcessor({
      async complete() {
        calls += 1;
        throw failure;
      },
    });
    await assert.rejects(processor.process(context), failure);
    assert.equal(calls, 1);
  }
});

test('service propagates context and persistence failures without retrying them', async () => {
  let modelCalls = 0;
  let writes = 0;
  const processor = {
    async process() {
      modelCalls += 1;
      return validOutput;
    },
  };

  const contextFailure = new Error('database read failed');
  const failingContext = new StoryCompletionService(
    { async build() { throw contextFailure; } },
    processor,
    { updateCompletionForUser: () => validOutput },
  );
  await assert.rejects(failingContext.evaluate('owner-1', 'story-1'), contextFailure);
  assert.equal(modelCalls, 0);

  const writeFailure = new Error('database write failed');
  const failingWriter = new StoryCompletionService(
    { async build() { return context; } },
    processor,
    {
      updateCompletionForUser() {
        writes += 1;
        throw writeFailure;
      },
    },
  );
  await assert.rejects(failingWriter.evaluate('owner-1', 'story-1'), writeFailure);
  assert.equal(modelCalls, 1);
  assert.equal(writes, 1);

  const persisted: StoryCompletionOutput = {
    status: 'complete',
    gaps: ['如果继续丰富，接下来最值得补充的具体场景是什么？'],
  };
  const successfulService = new StoryCompletionService(
    { async build() { return { ...context, currentStatus: 'complete' }; } },
    processor,
    {
      updateCompletionForUser(_userId, _storyId, output) {
        assert.deepEqual(output, validOutput);
        return persisted;
      },
    },
  );
  assert.deepEqual(await successfulService.evaluate('owner-1', 'story-1'), persisted);
});

test('Completion derives explicit exhausted-memory directions and makes them hard exclusions', async () => {
  const built = await new StoryCompletionContextBuilder({
    loadForUser: () => ({
      title: '童年片段',
      agentMemory: ['【已覆盖主题】家庭成员已经聊过。', '【已耗尽方向】用户对6岁以前的具体事情几乎想不起来，也没有清楚印象。'].join('\n'),
      stageTitle: '童年', currentStatus: 'interviewing',
      previousGaps: ['幼儿园时有没有发生过让你记得特别清楚的日常片段？'], sessionCount: 1,
    }),
  }).build('owner-1', 'story-1');
  assert.deepEqual(built.previousGaps, ['幼儿园时有没有发生过让你记得特别清楚的日常片段？']);
  assert.ok(built.blockedDirections?.some((direction) => /6岁以前.*想不起来|没有清楚印象/u.test(direction)));
  const prompt = buildStoryCompletionPrompt(built);
  const payload = JSON.parse(prompt.user.slice(prompt.user.indexOf('{'))) as Record<string, unknown>;
  assert.deepEqual(payload.previousGaps, built.previousGaps);
  assert.deepEqual(payload.blockedDirections, built.blockedDirections);
  assert.match(prompt.system, /强约束/);
  assert.match(prompt.system, /不得生成与其语义相同/);
});

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
