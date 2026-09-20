import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileAgentTaskContextStore } from '../../agent/tools/task-context-store.js';

test('FileAgentTaskContextStore stores scoped context with hashed 0600 file and deletes it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'life-interview-task-context-'));
  try {
    const store = new FileAgentTaskContextStore(dir, { now: () => 1_000 });
    store.put({
      runId: 'run-sensitive-id',
      userId: 'user-a',
      taskType: 'story.completion',
      resourceType: 'story',
      resourceId: 'story-a',
      schemaVersion: 'v1',
      skill: 'story-completion',
      payload: { title: '秘密故事', agent_memory: '私密采访内容' },
    }, 5_000);

    const names = readdirSync(dir);
    assert.equal(names.length, 1);
    assert.equal(names[0]?.includes('run-sensitive-id'), false);
    const mode = statSync(path.join(dir, names[0]!)).mode & 0o777;
    assert.equal(mode, 0o600);

    const loaded = store.get('run-sensitive-id');
    assert.equal(loaded?.userId, 'user-a');
    assert.deepEqual(loaded?.payload, { title: '秘密故事', agent_memory: '私密采访内容' });

    store.delete('run-sensitive-id');
    assert.equal(store.get('run-sensitive-id'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileAgentTaskContextStore drops expired context and enforces size limit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'life-interview-task-context-'));
  let now = 1_000;
  try {
    const store = new FileAgentTaskContextStore(dir, { now: () => now, maxBytes: 500 });
    store.put({
      runId: 'run-expire',
      userId: 'user-a',
      taskType: 'story.completion',
      resourceType: 'story',
      resourceId: 'story-a',
      schemaVersion: 'v1',
      skill: 'story-completion',
      payload: { title: 'A' },
    }, 10);
    now = 1_011;
    assert.equal(store.get('run-expire'), null);

    assert.throws(() => store.put({
      runId: 'run-large',
      userId: 'user-a',
      taskType: 'story.generation',
      resourceType: 'story',
      resourceId: 'story-a',
      schemaVersion: 'v1',
      skill: 'story-generation',
      payload: { transcript: 'x'.repeat(1_000) },
    }), /AGENT_TASK_CONTEXT_TOO_LARGE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
