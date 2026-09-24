import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { createAgentTaskPort } from '../src/agent-tasks/runtime.js';
import type { InterviewContextHintTaskRequest } from '../src/agent-tasks/contracts/index.js';

async function runSmoke(): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'realtime-context-agent-smoke-'));
  const databasePath = path.join(tempDirectory, 'memoir.db');
  const connection = createDatabase(databasePath);
  try {
    runMigrations(connection);
    seedDatabase(connection);
  } finally {
    connection.close();
  }

  try {
    const port = createAgentTaskPort({ ...process.env, AI_TASK_RUNTIME: 'agent' }, {
      databasePath,
    });
    if (!port) throw new Error('REALTIME_CONTEXT_AGENT_RUNTIME_UNAVAILABLE');

    const request: InterviewContextHintTaskRequest = {
      runId: randomUUID(),
      taskType: 'interview.context_hint',
      ownerId: seedIds.user,
      resource: {
        type: 'story',
        id: seedIds.firstProject,
        version: 'synthetic-realtime-smoke-session',
      },
      schemaVersion: 'v1',
      payload: {
        query: '用户以前提到的第一位师傅姓什么？',
        story_summary: '仅用于 Realtime Agent smoke 的合成故事背景。',
        recent_context: [],
        evidence: [{
          id: 'e1',
          question: '谁是你入厂后的第一位师傅？',
          answer: '用户说第一位师傅姓王。',
        }],
      },
    };
    const result = await port.run(request);
    if (result.taskType !== 'interview.context_hint') throw new Error('REALTIME_CONTEXT_TASK_TYPE_MISMATCH');
    const validEvidenceIds = new Set(request.payload.evidence.map((item) => item.id));
    const validSelection = result.output.selected_evidence_ids.every((id) => validEvidenceIds.has(id));
    const noScripts = result.runtime.scriptCallCount === 0;
    const oneAttempt = result.runtime.attemptCount === 1;
    const passed = validSelection && noScripts && oneAttempt;

    process.stdout.write(`${JSON.stringify({
      status: passed ? 'PASS' : 'FAIL',
      taskType: result.taskType,
      runtime: result.runtime.runtime,
      skill: result.runtime.skill,
      model: result.runtime.model ?? null,
      latencyMs: result.runtime.latencyMs ?? null,
      attemptCount: result.runtime.attemptCount ?? null,
      scriptCallCount: result.runtime.scriptCallCount ?? null,
      selectedEvidenceCount: result.output.selected_evidence_ids.length,
      evidenceIdsValid: validSelection,
    }, null, 2)}\n`);
    if (!passed) process.exitCode = 1;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

runSmoke().catch((error: unknown) => {
  const value = error && typeof error === 'object' ? error as { code?: unknown } : undefined;
  const errorCode = typeof value?.code === 'string' && /^[A-Z0-9_]{1,96}$/u.test(value.code)
    ? value.code
    : error instanceof Error ? error.name : 'UNKNOWN_ERROR';
  process.stderr.write(`Realtime context Agent smoke failed: ${errorCode}\n`);
  process.exitCode = 1;
});
