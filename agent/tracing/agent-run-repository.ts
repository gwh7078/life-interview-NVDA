import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../../src/db/client.js';
import { agentRuns, type AgentRunStatus } from '../../src/db/schema.js';
import { nowUtcIso } from '../../src/db/time.js';
import type { AgentRunRequest } from '../runtime/types.js';

export interface AgentRunCreateInput extends AgentRunRequest {
  runtime: string;
  mode?: string | null;
  skill?: string | null;
  skillVersion?: string | null;
  provider?: string | null;
  model?: string | null;
  contextVersion?: string | null;
  schemaVersion?: string | null;
  resourceVersion?: string | null;
  inputHash?: string | null;
}

export interface AgentRunAttemptMetrics {
  attemptCount: number;
  repairCount: number;
  toolCallCount: number;
  scriptCallCount: number;
  formatRepairUsed: boolean;
  provider?: string | null;
  model?: string | null;
}

export interface AgentRunSuccessMetadata {
  outputHash?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface AgentRunStore {
  create(input: AgentRunCreateInput): void;
  markRunning(userId: string, runId: string): void;
  recordAttempt?(userId: string, runId: string, metrics: AgentRunAttemptMetrics): void;
  markSucceeded(
    userId: string,
    runId: string,
    latencyMs: number,
    result: unknown,
    metadata?: AgentRunSuccessMetadata,
  ): void;
  markFailed(userId: string, runId: string, latencyMs: number, errorCode: string): void;
}

export class AgentRunRepository implements AgentRunStore {
  constructor(private readonly databasePath?: string) {}

  create(input: AgentRunCreateInput): void {
    const connection = createDatabase(this.databasePath);
    try {
      const now = nowUtcIso();
      connection.db.insert(agentRuns).values({
        runId: input.runId,
        userId: input.userId,
        agentType: input.agentType,
        taskType: input.taskType,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        resourceVersion: input.resourceVersion ?? null,
        runtime: input.runtime,
        mode: input.mode ?? null,
        skill: input.skill ?? null,
        skillVersion: input.skillVersion ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
        contextVersion: input.contextVersion ?? null,
        schemaVersion: input.schemaVersion ?? null,
        inputHash: input.inputHash ?? null,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      }).run();
    } finally {
      connection.close();
    }
  }

  private transition(
    userId: string,
    runId: string,
    status: AgentRunStatus,
    patch: Partial<typeof agentRuns.$inferInsert>,
  ): void {
    const connection = createDatabase(this.databasePath);
    try {
      const result = connection.db.update(agentRuns).set({
        ...patch,
        status,
        updatedAt: nowUtcIso(),
      }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.runId, runId))).run();
      if (result.changes !== 1) throw new Error('AGENT_RUN_NOT_FOUND');
    } finally {
      connection.close();
    }
  }

  markRunning(userId: string, runId: string): void {
    this.transition(userId, runId, 'running', { startedAt: nowUtcIso(), errorCode: null });
  }

  recordAttempt(userId: string, runId: string, metrics: AgentRunAttemptMetrics): void {
    this.transition(userId, runId, 'running', {
      attemptCount: metrics.attemptCount,
      repairCount: metrics.repairCount,
      toolCallCount: metrics.toolCallCount,
      scriptCallCount: metrics.scriptCallCount,
      formatRepairUsed: metrics.formatRepairUsed,
      ...(metrics.provider !== undefined ? { provider: metrics.provider } : {}),
      ...(metrics.model !== undefined ? { model: metrics.model } : {}),
    });
  }

  markSucceeded(
    userId: string,
    runId: string,
    latencyMs: number,
    result: unknown,
    metadata: AgentRunSuccessMetadata = {},
  ): void {
    this.transition(userId, runId, 'succeeded', {
      completedAt: nowUtcIso(),
      latencyMs,
      errorCode: null,
      resultJson: JSON.stringify(result),
      ...(metadata.outputHash !== undefined ? { outputHash: metadata.outputHash } : {}),
      ...(metadata.provider !== undefined ? { provider: metadata.provider } : {}),
      ...(metadata.model !== undefined ? { model: metadata.model } : {}),
    });
  }

  markFailed(userId: string, runId: string, latencyMs: number, errorCode: string): void {
    this.transition(userId, runId, 'failed', {
      completedAt: nowUtcIso(),
      latencyMs,
      errorCode,
      resultJson: null,
    });
  }

  findByIdForUser(userId: string, runId: string) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select().from(agentRuns).where(and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.runId, runId),
      )).get() ?? null;
    } finally {
      connection.close();
    }
  }
}
