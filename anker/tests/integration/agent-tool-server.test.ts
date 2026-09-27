import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAgentToolServer } from '../../agent/tools/server.js';
import { noOpAgentToolAudit } from '../../agent/tools/audit-log.js';
import { AgentToolTokenService } from '../../agent/tools/token.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { accounts, lifeStages, stories, users } from '../../src/db/schema.js';

test('Agent Tool API enforces token scope, owner scope and invalid-resource handling', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'life-interview-agent-tool-api-'));
  const dbPath = path.join(dir, 'memoir.db');
  const connection = createDatabase(dbPath);
  try {
    runMigrations(connection);
    const now = new Date().toISOString();
    for (const suffix of ['a', 'b']) {
      connection.db.insert(accounts).values({ accountId: 'account-' + suffix, status: 'legacy', createdAt: now, updatedAt: now }).run();
      connection.db.insert(users).values({ userId: 'user-' + suffix, accountId: 'account-' + suffix, createdAt: now, updatedAt: now }).run();
      connection.db.insert(lifeStages).values({ stageId: 'stage-' + suffix, userId: 'user-' + suffix, title: '阶段 ' + suffix, createdAt: now, updatedAt: now }).run();
      connection.db.insert(stories).values({
        storyId: 'story-' + suffix, userId: 'user-' + suffix, stageId: 'stage-' + suffix,
        title: '故事 ' + suffix, summary: '摘要', agentMemory: '记忆', createdAt: now, updatedAt: now,
      }).run();
    }
  } finally {
    connection.close();
  }

  const tokens = new AgentToolTokenService('phase1-test-secret-0123456789-abcdef');
  const server = createAgentToolServer({ databasePath: dbPath, tokenService: tokens, audit: noOpAgentToolAudit });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port;

  try {
    const valid = tokens.issue({ runId: 'run-a', userId: 'user-a', tool: 'get_story_context', resourceType: 'story', resourceId: 'story-a' });
    const ok = await fetch(base + '/internal/agent-tools/get_story_context', {
      method: 'POST', headers: { authorization: 'Bearer ' + valid, 'content-type': 'application/json' },
      body: JSON.stringify({ story_id: 'story-a' }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as { story: { title: string } }).story.title, '故事 a');

    const invalidResource = await fetch(base + '/internal/agent-tools/get_story_context', {
      method: 'POST', headers: { authorization: 'Bearer ' + valid, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(invalidResource.status, 400);

    const wrongScope = await fetch(base + '/internal/agent-tools/get_story_context', {
      method: 'POST', headers: { authorization: 'Bearer ' + valid, 'content-type': 'application/json' },
      body: JSON.stringify({ story_id: 'story-b' }),
    });
    assert.equal(wrongScope.status, 403);

    const ownerScoped = tokens.issue({ runId: 'run-b', userId: 'user-a', tool: 'get_story_context', resourceType: 'story', resourceId: 'story-b' });
    const hidden = await fetch(base + '/internal/agent-tools/get_story_context', {
      method: 'POST', headers: { authorization: 'Bearer ' + ownerScoped, 'content-type': 'application/json' },
      body: JSON.stringify({ story_id: 'story-b' }),
    });
    assert.equal(hidden.status, 404);

    const unauthorized = await fetch(base + '/internal/agent-tools/get_story_context', {
      method: 'POST', headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ story_id: 'story-a' }),
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
