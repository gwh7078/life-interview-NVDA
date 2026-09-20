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
      runtime: 'nemoclaw-openclaw', model: 'hosted-test',
    });
    assert.equal(repo.findByIdForUser('user-a', 'run-a')?.status, 'queued');
    repo.markRunning('user-a', 'run-a');
    assert.equal(repo.findByIdForUser('user-a', 'run-a')?.status, 'running');
    repo.markSucceeded('user-a', 'run-a', 123, { title: 'A', gap_count: 1 });
    const saved = repo.findByIdForUser('user-a', 'run-a');
    assert.equal(saved?.status, 'succeeded');
    assert.equal(saved?.latencyMs, 123);
    assert.deepEqual(JSON.parse(saved?.resultJson ?? '{}'), { title: 'A', gap_count: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
