import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { StoryContextTool } from '../../agent/tools/get-story-context.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { accounts, lifeStages, stories, users } from '../../src/db/schema.js';

test('get_story_context is owner-scoped and returns Agent Memory + gaps', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'life-interview-story-tool-'));
  const dbPath = path.join(dir, 'memoir.db');
  const connection = createDatabase(dbPath);
  try {
    runMigrations(connection);
    const now = new Date().toISOString();
    connection.db.insert(accounts).values({ accountId: 'account-a', status: 'legacy', createdAt: now, updatedAt: now }).run();
    connection.db.insert(users).values({ userId: 'user-a', accountId: 'account-a', createdAt: now, updatedAt: now }).run();
    connection.db.insert(lifeStages).values({
      stageId: 'stage-a', userId: 'user-a', title: '日本生活', startDate: '2018', endDate: '2020',
      createdAt: now, updatedAt: now,
    }).run();
    connection.db.insert(stories).values({
      storyId: 'story-a', userId: 'user-a', stageId: 'stage-a', title: '第一次到东京',
      summary: '摘要', agentMemory: '可持续采访记忆', status: 'interviewing',
      gapsJson: JSON.stringify(['当时为什么决定去东京？']), createdAt: now, updatedAt: now,
    }).run();

    const tool = new StoryContextTool(dbPath);
    const result = tool.getForOwner('user-a', 'story-a');
    assert.equal(result?.story.title, '第一次到东京');
    assert.equal(result?.story.agent_memory, '可持续采访记忆');
    assert.deepEqual(result?.story.gaps, ['当时为什么决定去东京？']);
    assert.equal(tool.getForOwner('other-user', 'story-a'), null);
  } finally {
    connection.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
