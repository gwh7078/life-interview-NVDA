import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../../src/db/client.js';
import { agentRuns, type AgentRunStatus } from '../../src/db/schema.js';
import { nowUtcIso } from '../../src/db/time.js';
import type { AgentRunRequest } from '../runtime/types.js';

export interface AgentRunCreateInput extends AgentRunRequest {
  runtime: string;
  model?: string | null;
}

export interface AgentRunStore {
  create(input: AgentRunCreateInput): void;
  markRunning(userId: string, runId: string): void;
  markSucceeded(userId: string, runId: string, latencyMs: number, result: unknown): void;
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
        runtime: input.runtime,
        model: input.model ?? null,
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

  markSucceeded(userId: string, runId: string, latencyMs: number, result: unknown): void {
    this.transition(userId, runId, 'succeeded', {
      completedAt: nowUtcIso(),
      latencyMs,
      errorCode: null,
      resultJson: JSON.stringify(result),
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
