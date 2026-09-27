import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { interviewSessions, stories, users } from '../src/db/schema.js';
import { createInterviewRuntimeCore } from '../src/interview/core.js';
import { StoryShareRepository } from '../src/repositories/story-share-repository.js';

const temporaryDirectories: string[] = [];
const root = path.resolve('data/test-tmp');
mkdirSync(root, { recursive: true });

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(path.join(root, 'interview-scenarios-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
    database.db.delete(interviewSessions).where(eq(interviewSessions.sessionType, 'onboarding')).run();
    database.db.update(users).set({ onboardingStatus: 'not_started' })
      .where(eq(users.userId, seedIds.user)).run();
    database.db.update(stories).set({
      agentMemory: '【已知事实】主人公已经明确讲过第一次跨团队项目的关键经过。',
      gapsJson: JSON.stringify(['项目上线前最担心什么？']),
    }).where(eq(stories.storyId, seedIds.firstProject)).run();
  } finally {
    database.close();
  }
  return databasePath;
}

test('Interview Core keeps four product scenarios distinct while Story create/continue share one strategy', () => {
  const databasePath = setup();
  const core = createInterviewRuntimeCore(databasePath);
  const shares = new StoryShareRepository(databasePath);
  const share = shares.createForStory(seedIds.user, seedIds.firstProject, 'friend');
  assert.ok(share);

  // 1. 首次建档 / Onboarding
  const onboarding = core.prepare(seedIds.user, { interview_type: 'onboarding' });
  assert.equal(onboarding.interview_type, 'onboarding');
  assert.ok(onboarding.profile);

  // 2. Story 新建：复用 Story Strategy，但必须是 create mode，且不存在既有 Story。
  const createStory = core.prepare(seedIds.user, {
    interview_type: 'story',
    target: { mode: 'create', stageId: seedIds.work, title: '一次新的工作经历' },
  });
  assert.notEqual(createStory.interview_type, 'onboarding');
  assert.notEqual(createStory.interview_type, 'external_contributor');
  if (createStory.interview_type === 'onboarding' || createStory.interview_type === 'external_contributor') {
    throw new Error('Expected Story create context.');
  }
  assert.equal(createStory.story, null);
  assert.equal(createStory.life_stage.stage_id, seedIds.work);
  assert.deepEqual(createStory.task_context, {
    mode: 'create',
    target_title: '一次新的工作经历',
  });

  // 3. Story 续访：必须绑定已有 Story，并消费持久化 Agent Memory / gaps。
  const continueStory = core.prepare(seedIds.user, {
    interview_type: 'story',
    target: { mode: 'continue', storyId: seedIds.firstProject },
  });
  assert.notEqual(continueStory.interview_type, 'onboarding');
  assert.notEqual(continueStory.interview_type, 'external_contributor');
  if (continueStory.interview_type === 'onboarding' || continueStory.interview_type === 'external_contributor') {
    throw new Error('Expected Story continue context.');
  }
  assert.equal(continueStory.story?.story_id, seedIds.firstProject);
  assert.match(String(continueStory.story?.agent_memory), /跨团队项目/);
  assert.deepEqual(continueStory.story?.gaps, ['项目上线前最担心什么？']);
  assert.deepEqual(continueStory.task_context, { mode: 'continue' });

  // 4. 第三者访谈：独立 External Contributor Context，连续记忆属于 share_id。
  const external = core.prepare(seedIds.user, {
    interview_type: 'external_contributor',
    shareId: share.link.shareId,
  });
  assert.equal(external.interview_type, 'external_contributor');
  if (external.interview_type !== 'external_contributor') throw new Error('Expected external contributor context.');
  assert.equal(external.share_id, share.link.shareId);
  assert.equal(external.relationship, 'friend');
  assert.equal(external.story.story_id, seedIds.firstProject);
  assert.equal(external.contributor_summary, '');

  const onboardingSession = core.start(seedIds.user, onboarding, 'stepfun');
  const createSession = core.start(seedIds.user, createStory, 'stepfun');
  const continueSession = core.start(seedIds.user, continueStory, 'stepfun');
  const externalSession = core.start(seedIds.user, external, 'stepfun');

  const database = createDatabase(databasePath);
  try {
    const rows = database.db.select().from(interviewSessions).all();
    const byId = new Map(rows.map((row) => [row.sessionId, row]));

    assert.equal(byId.get(onboardingSession.sessionId)?.sessionType, 'onboarding');

    assert.equal(byId.get(createSession.sessionId)?.sessionType, 'story');
    assert.equal(byId.get(createSession.sessionId)?.sourceType, 'subject');
    assert.equal(byId.get(createSession.sessionId)?.storyId, null);
    assert.equal(byId.get(createSession.sessionId)?.stageId, seedIds.work);

    assert.equal(byId.get(continueSession.sessionId)?.sessionType, 'story');
    assert.equal(byId.get(continueSession.sessionId)?.sourceType, 'subject');
    assert.equal(byId.get(continueSession.sessionId)?.storyId, seedIds.firstProject);

    assert.equal(byId.get(externalSession.sessionId)?.sessionType, 'story');
    assert.equal(byId.get(externalSession.sessionId)?.sourceType, 'external_contributor');
    assert.equal(byId.get(externalSession.sessionId)?.sourceShareId, share.link.shareId);
    assert.equal(byId.get(externalSession.sessionId)?.storyId, seedIds.firstProject);
  } finally {
    database.close();
  }
});
