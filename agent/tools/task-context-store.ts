import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { AgentTaskType } from '../../src/agent-tasks/contracts/common.js';

export interface AgentTaskContextEntry {
  runId: string;
  userId: string;
  taskType: AgentTaskType;
  mode?: string;
  resourceType: string;
  resourceId: string;
  schemaVersion: string;
  skill: string;
  payload: unknown;
  expiresAt: number;
}

export interface AgentTaskContextStore {
  put(input: Omit<AgentTaskContextEntry, 'expiresAt'>, ttlMs?: number): void;
  get(runId: string): AgentTaskContextEntry | null;
  delete(runId: string): void;
}

function contextFileName(runId: string): string {
  return createHash('sha256').update(runId, 'utf8').digest('hex') + '.json';
}

function validEntry(value: unknown): value is AgentTaskContextEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.runId === 'string'
    && typeof item.userId === 'string'
    && typeof item.taskType === 'string'
    && (item.mode === undefined || typeof item.mode === 'string')
    && typeof item.resourceType === 'string'
    && typeof item.resourceId === 'string'
    && typeof item.schemaVersion === 'string'
    && typeof item.skill === 'string'
    && typeof item.expiresAt === 'number'
    && Number.isFinite(item.expiresAt)
    && Object.hasOwn(item, 'payload');
}

export class FileAgentTaskContextStore implements AgentTaskContextStore {
  private readonly maxBytes: number;

  constructor(
    private readonly directory = process.env.AGENT_TASK_CONTEXT_DIR ?? './runtime/agent-task-contexts',
    options: { maxBytes?: number; now?: () => number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.now = options.now ?? (() => Date.now());
  }

  private readonly now: () => number;

  private filePath(runId: string): string {
    return path.resolve(this.directory, contextFileName(runId));
  }

  put(input: Omit<AgentTaskContextEntry, 'expiresAt'>, ttlMs = 150_000): void {
    if (!input.runId.trim()) throw new Error('AGENT_TASK_CONTEXT_RUN_ID_REQUIRED');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('AGENT_TASK_CONTEXT_TTL_INVALID');

    const entry: AgentTaskContextEntry = {
      ...input,
      expiresAt: this.now() + ttlMs,
    };
    const serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      throw new Error('AGENT_TASK_CONTEXT_TOO_LARGE');
    }

    const directory = path.resolve(this.directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = this.filePath(input.runId);
    const temporary = destination + '.tmp-' + process.pid + '-' + Date.now();
    writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, destination);
  }

  get(runId: string): AgentTaskContextEntry | null {
    const file = this.filePath(runId);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('AGENT_TASK_CONTEXT_INVALID');
    }
    if (!validEntry(parsed) || parsed.runId !== runId) {
      throw new Error('AGENT_TASK_CONTEXT_INVALID');
    }
    if (parsed.expiresAt <= this.now()) {
      this.delete(runId);
      return null;
    }
    return parsed;
  }

  delete(runId: string): void {
    rmSync(this.filePath(runId), { force: true });
  }
}
