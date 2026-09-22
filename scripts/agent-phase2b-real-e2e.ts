import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentTaskPort } from '../src/agent-tasks/index.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { nowUtcIso } from '../src/db/time.js';
import { accounts, agentRuns, users } from '../src/db/schema.js';
import { listSyntheticFixtures } from './agent-eval/fixture-registry.js';

interface CaseResult {
  name: string;
  taskType: string;
  mode?: string;
  ok: boolean;
  latencyMs: number;
  runtime?: unknown;
  output?: unknown;
  error?: string;
}

async function main(): Promise<void> {
  if (!process.env.NEMOCLAW_SANDBOX?.trim()) {
    throw new Error('NEMOCLAW_SANDBOX is required for the real Agent E2E gate.');
  }

  const directory = mkdtempSync(path.join(tmpdir(), 'life-interview-phase2b-e2e-'));
  const databasePath = path.join(directory, 'memoir.db');
  const runtimeTimingPath = path.join(directory, 'agent-runtime-timing.jsonl');
  const ownerId = 'phase2b-e2e-owner';
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    const now = nowUtcIso();
    database.db.insert(accounts).values({
      accountId: 'phase2b-e2e-account',
      status: 'legacy',
      createdAt: now,
      updatedAt: now,
    }).run();
    database.db.insert(users).values({
      userId: ownerId,
      accountId: 'phase2b-e2e-account',
      createdAt: now,
      updatedAt: now,
    }).run();
  } finally {
    database.close();
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AI_TASK_RUNTIME: 'agent',
    DATABASE_PATH: databasePath,
    AGENT_RUNTIME_DIAGNOSTICS_PATH: runtimeTimingPath,
  };
  const tasks = createAgentTaskPort(env, { databasePath });
  if (!tasks) throw new Error('Agent runtime did not resolve to AgentTaskPort.');

  const results: CaseResult[] = [];
  try {
    for (const item of listSyntheticFixtures(ownerId)) {
      const started = Date.now();
      try {
        const result = await tasks.run(item.request);
        results.push({
          name: item.caseId,
          taskType: item.request.taskType,
          ...(item.request.mode ? { mode: item.request.mode } : {}),
          ok: true,
          latencyMs: Date.now() - started,
          runtime: result.runtime,
          output: result.output,
        });
        process.stdout.write(`PASS ${item.caseId}\n`);
      } catch (error) {
        results.push({
          name: item.caseId,
          taskType: item.request.taskType,
          ...(item.request.mode ? { mode: item.request.mode } : {}),
          ok: false,
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        process.stderr.write(`FAIL ${item.caseId}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }

    const traceDatabase = createDatabase(databasePath);
    let tracing: unknown[];
    try {
      tracing = traceDatabase.db.select().from(agentRuns).all().map((run) => ({
        runId: run.runId,
        taskType: run.taskType,
        mode: run.mode,
        skill: run.skill,
        skillVersion: run.skillVersion,
        provider: run.provider,
        model: run.model,
        resourceType: run.resourceType,
        resourceId: run.resourceId,
        resourceVersion: run.resourceVersion,
        contextVersion: run.contextVersion,
        schemaVersion: run.schemaVersion,
        attemptCount: run.attemptCount,
        repairCount: run.repairCount,
        toolCallCount: run.toolCallCount,
        scriptCallCount: run.scriptCallCount,
        formatRepairUsed: run.formatRepairUsed,
        latencyMs: run.latencyMs,
        errorCode: run.errorCode,
        inputHash: run.inputHash,
        outputHash: run.outputHash,
        status: run.status,
      }));
    } finally {
      traceDatabase.close();
    }

    let runtimeTimings: unknown[] = [];
    try {
      const content = readFileSync(runtimeTimingPath, 'utf8').trim();
      if (content) runtimeTimings = content.split('\n').map((line) => JSON.parse(line));
    } catch {
      // Timing diagnostics are best-effort and must not change the E2E result.
    }

    const report = {
      generatedAt: new Date().toISOString(),
      sandbox: process.env.NEMOCLAW_SANDBOX,
      provider: process.env.AGENT_PROVIDER ?? null,
      models: {
        default: process.env.AGENT_MODEL_DEFAULT ?? null,
        reasoning: process.env.AGENT_MODEL_REASONING ?? null,
        reasoningFast: process.env.AGENT_MODEL_REASONING_FAST ?? null,
        writing: process.env.AGENT_MODEL_WRITING ?? null,
      },
      thinking: process.env.AGENT_THINKING ?? null,
      passed: results.filter((item) => item.ok).length,
      total: results.length,
      runtimeTimings,
      tracing,
      results,
    };
    process.stdout.write(`LIFE_INTERVIEW_PHASE2B_E2E_REPORT ${JSON.stringify(report)}\n`);
    if (report.passed !== report.total) process.exitCode = 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
