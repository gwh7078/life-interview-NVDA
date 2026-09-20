import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { stories } from '../src/db/schema.js';
import { StoryInterviewContextBuilder } from '../src/interview/context/story-interview-context.js';

const temporaryDirectories: string[] = [];
const testTempRoot = path.resolve('data/test-tmp');
mkdirSync(testTempRoot, { recursive: true });

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

test('Story continuation loads persisted Agent Memory without replaying historical Transcript', () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-story-interview-context-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'story-context.db');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
    database.db.update(stories).set({
      agentMemory: '【事件过程】\n- 用户已经说明项目上线前先和团队确认风险。\n【已覆盖主题】\n- 团队支持情况已经讨论清楚。',
    }).where(and(
      eq(stories.userId, seedIds.user),
      eq(stories.storyId, seedIds.firstProject),
    )).run();
  } finally {
    database.close();
  }

  const context = new StoryInterviewContextBuilder(databasePath).build(seedIds.user, {
    mode: 'continue',
    storyId: seedIds.firstProject,
  });

  assert.equal(context.story?.agent_memory, '【事件过程】\n- 用户已经说明项目上线前先和团队确认风险。\n【已覆盖主题】\n- 团队支持情况已经讨论清楚。');
  assert.equal('summary' in (context.story ?? {}), false);
  assert.equal('recent_asked_questions' in context, false);
  assert.equal('history' in context, false);
  assert.equal('related_stories' in context, false);
});
