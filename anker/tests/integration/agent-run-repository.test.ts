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
    const observations: import('../../src/observability/observation-event.js').ObservationEvent[] = [];
    const repo = new AgentRunRepository(dbPath, {
      captureContent: true,
      onObservationEvent: (event) => observations.push(event),
    });
    repo.create({
      runId: 'run-a', userId: 'user-a', agentType: 'story-context-inspector',
      taskType: 'interview.closeout', resourceType: 'interview_session', resourceId: 'session-a',
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
      toolCallCount: 2,
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
    assert.equal(saved?.toolCallCount, 2);
    assert.equal(saved?.scriptCallCount, 0);
    assert.equal(saved?.formatRepairUsed, true);
    assert.equal(saved?.inputHash, 'input-hash');
    assert.equal(saved?.outputHash, 'output-hash');
    assert.deepEqual(JSON.parse(saved?.resultJson ?? '{}'), { title: 'A', gap_count: 1 });
    assert.deepEqual(observations.map((event) => event.eventType), [
      'agent.started', 'skill.started', 'agent.retry', 'agent.completed', 'skill.completed',
    ]);
    assert.ok(observations.every((event) => event.sessionId === 'session-a' && event.traceId === 'session-a'));
    assert.equal(observations[3]?.durationMs, 123);
    assert.equal(observations[3]?.metrics?.toolCallCount, 2);

    repo.create({
      runId: 'run-b', userId: 'user-a', agentType: 'interview-agent', taskType: 'interview.closeout',
      resourceType: 'interview_session', resourceId: 'session-b', runtime: 'nemoclaw-openclaw', skill: 'interview-closeout',
    });
    repo.markRunning('user-a', 'run-b');
    repo.markFailed('user-a', 'run-b', 45, 'AGENT_RUNTIME_FAILED');
    assert.equal(observations.at(-2)?.eventType, 'agent.failed');
    assert.equal(observations.at(-2)?.status, 'error');
    assert.equal(observations.at(-2)?.durationMs, 45);
    assert.equal(observations.at(-1)?.eventType, 'skill.failed');

    const contextRunInput = {
      runId: 'run-context', userId: 'user-a', agentType: 'interview-observer',
      taskType: 'interview.context_hint', resourceType: 'story', resourceId: 'story-a',
      runtime: 'nemoclaw-openclaw', skill: 'interview-observer', model: 'qwen-test',
      traceContext: {
        traceId: 'trace-session-c', sessionId: 'session-c', storyId: 'story-a', parentSpanId: 'tool-cycle-c',
      },
    } as Parameters<AgentRunRepository['create']>[0];
    const firstContextEvent = observations.length;
    repo.create(contextRunInput);
    repo.markRunning('user-a', 'run-context');
    repo.markSucceeded('user-a', 'run-context', 25, { selected_evidence_ids: ['e1'] }, { model: 'qwen-test' });
    const contextEvents = observations.slice(firstContextEvent);
    assert.deepEqual(contextEvents.map((event) => event.eventType), [
      'agent.started', 'skill.started', 'agent.completed', 'skill.completed',
    ]);
    assert.ok(contextEvents.every((event) => event.traceId === 'trace-session-c'
      && event.sessionId === 'session-c' && event.storyId === 'story-a'));
    assert.equal(contextEvents[0]?.parentSpanId, 'tool-cycle-c');
    assert.equal(contextEvents[1]?.parentSpanId, 'agent:run-context');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
