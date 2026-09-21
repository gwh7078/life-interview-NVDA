import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AgentRunRepository } from '../../agent/tracing/agent-run-repository.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { accounts, users } from '../../src/db/schema.js';

test('agent_runs persists queued to running to succeeded lifecycle', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'life-interview-agent-run-'));
  const dbPath = path.join(dir, 'memoir.db');
  const connection = createDatabase(dbPath);
  try {
    runMigrations(connection);
    const now = new Date().toISOString();
    connection.db.insert(accounts).values({ accountId: 'account-a', status: 'legacy', createdAt: now, updatedAt: now }).run();
    connection.db.insert(users).values({ userId: 'user-a', accountId: 'account-a', createdAt: now, updatedAt: now }).run();
  } finally {
    connection.close();
  }

  try {
    const repo = new AgentRunRepository(dbPath);
    repo.create({
      runId: 'run-a', userId: 'user-a', agentType: 'story-context-inspector',
      taskType: 'inspect-story-context', resourceType: 'story', resourceId: 'story-a',
      resourceVersion: 'story-v1',
      runtime: 'nemoclaw-openclaw', mode: 'story_continue',
      skill: 'interview-closeout', skillVersion: 'v1',
      provider: 'stepfun', model: 'hosted-test',
      contextVersion: 'v1', schemaVersion: 'v1', inputHash: 'input-hash',
    });
    assert.equal(repo.findByIdForUser('user-a', 'run-a')?.status, 'queued');
    repo.markRunning('user-a', 'run-a');
    assert.equal(repo.findByIdForUser('user-a', 'run-a')?.status, 'running');
    repo.recordAttempt('user-a', 'run-a', {
      attemptCount: 2,
      repairCount: 1,
      toolCallCount: 0,
      scriptCallCount: 0,
      formatRepairUsed: true,
      provider: 'stepfun',
      model: 'hosted-test',
    });
    repo.markSucceeded('user-a', 'run-a', 123, { title: 'A', gap_count: 1 }, {
      outputHash: 'output-hash',
      provider: 'stepfun',
      model: 'hosted-test',
    });
    const saved = repo.findByIdForUser('user-a', 'run-a');
    assert.equal(saved?.status, 'succeeded');
    assert.equal(saved?.latencyMs, 123);
    assert.equal(saved?.mode, 'story_continue');
    assert.equal(saved?.skill, 'interview-closeout');
    assert.equal(saved?.skillVersion, 'v1');
    assert.equal(saved?.provider, 'stepfun');
    assert.equal(saved?.contextVersion, 'v1');
    assert.equal(saved?.schemaVersion, 'v1');
    assert.equal(saved?.resourceVersion, 'story-v1');
    assert.equal(saved?.attemptCount, 2);
    assert.equal(saved?.repairCount, 1);
    assert.equal(saved?.toolCallCount, 0);
    assert.equal(saved?.scriptCallCount, 0);
    assert.equal(saved?.formatRepairUsed, true);
    assert.equal(saved?.inputHash, 'input-hash');
    assert.equal(saved?.outputHash, 'output-hash');
    assert.deepEqual(JSON.parse(saved?.resultJson ?? '{}'), { title: 'A', gap_count: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
