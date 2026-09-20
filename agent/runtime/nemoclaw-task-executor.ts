import type { AgentRunStore } from '../tracing/agent-run-repository.js';
import type { AgentToolTokenService } from '../tools/token.js';
import type { AgentTaskContextStore } from '../tools/task-context-store.js';
import type {
  AgentTaskExecutionRequest,
  AgentTaskExecutionResult,
  AgentTaskExecutor,
} from '../../src/agent-tasks/ports/agent-task-executor.js';
import type { AgentModelProfile } from '../../src/agent-tasks/definitions/task-definition-registry.js';
import {
  CommandExecutionError,
  ExecFileCommandRunner,
  type CommandRunner,
} from './command-runner.js';

export interface NemoClawOpenClawTaskExecutorConfig {
  sandboxName: string;
  toolBaseUrl: string;
  provider?: string;
  defaultModel?: string | null;
  models?: Partial<Record<AgentModelProfile, string>>;
  timeoutMs?: number;
}

function parseLifeInterviewResult(stdout: string): Record<string, unknown> {
  const line = stdout
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.trim().startsWith('LIFE_INTERVIEW_RESULT '));
  if (!line) throw new Error('AGENT_RESULT_MISSING');

  const raw = line.trim().slice('LIFE_INTERVIEW_RESULT '.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AGENT_RESULT_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AGENT_RESULT_INVALID');
  }
  return parsed as Record<string, unknown>;
}

function taskLabel(request: AgentTaskExecutionRequest): string {
  return request.mode ? `${request.taskType}:${request.mode}` : request.taskType;
}

export class NemoClawOpenClawTaskExecutor implements AgentTaskExecutor {
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: NemoClawOpenClawTaskExecutorConfig,
    private readonly tokens: AgentToolTokenService,
    private readonly contexts: AgentTaskContextStore,
    private readonly runs: AgentRunStore,
    runner?: CommandRunner,
  ) {
    if (!config.sandboxName.trim()) throw new Error('NEMOCLAW_SANDBOX is required.');
    if (!/^https?:\/\//u.test(config.toolBaseUrl)) {
      throw new Error('AGENT_TOOL_BASE_URL must be an HTTP(S) URL.');
    }
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.runner = runner ?? new ExecFileCommandRunner();
  }

  async execute(request: AgentTaskExecutionRequest): Promise<AgentTaskExecutionResult> {
    const model = this.config.models?.[request.modelProfile]
      ?? this.config.defaultModel
      ?? null;
    const started = Date.now();

    this.runs.create({
      runId: request.runId,
      userId: request.ownerId,
      agentType: request.skill,
      taskType: taskLabel(request),
      resourceType: request.resource.type,
      resourceId: request.resource.id,
      runtime: 'nemoclaw-openclaw',
      model,
    });

    try {
      this.runs.markRunning(request.ownerId, request.runId);
      this.contexts.put({
        runId: request.runId,
        userId: request.ownerId,
        taskType: request.taskType,
        ...(request.mode ? { mode: request.mode } : {}),
        resourceType: request.resource.type,
        resourceId: request.resource.id,
        schemaVersion: request.schemaVersion,
        skill: request.skill,
        payload: request.payload,
      }, this.timeoutMs + 30_000);

      const token = this.tokens.issue({
        runId: request.runId,
        userId: request.ownerId,
        tool: 'get_task_context',
        resourceType: request.resource.type,
        resourceId: request.resource.id,
        ttlMs: this.timeoutMs + 30_000,
      });

      const baseUrl = this.config.toolBaseUrl.replace(/\/$/u, '');
      const prompt = [
        `Use the installed ${request.skill} skill.`,
        'Load the structured Task Context before doing the task by running:',
        `curl -fsS -X POST "${baseUrl}/internal/agent-tools/get_task_context"`,
        '-H "Authorization: Bearer $LIFE_INTERVIEW_TOOL_TOKEN"',
        '-H "Content-Type: application/json"',
        '--data "{\"run_id\":\"$LIFE_INTERVIEW_RUN_ID\",\"resource_type\":\"$LIFE_INTERVIEW_RESOURCE_TYPE\",\"resource_id\":\"$LIFE_INTERVIEW_RESOURCE_ID\"}".',
        'Use only response.context as the task-specific input.',
        'Do not read SQLite, memoir.db, repository data files, or unrelated product data.',
        'Follow the installed Skill and return its required strict JSON.',
        'Your final output must end with exactly one line: LIFE_INTERVIEW_RESULT <JSON>',
      ].join(' ');

      const args = [
        this.config.sandboxName,
        'exec',
        '--',
        'env',
        'LIFE_INTERVIEW_TOOL_BASE_URL=' + baseUrl,
        'LIFE_INTERVIEW_TOOL_TOKEN=' + token,
        'LIFE_INTERVIEW_RUN_ID=' + request.runId,
        'LIFE_INTERVIEW_RESOURCE_TYPE=' + request.resource.type,
        'LIFE_INTERVIEW_RESOURCE_ID=' + request.resource.id,
        'openclaw',
        'agent',
        '--local',
        '--agent',
        'main',
        '--session-key',
        'agent:main:task:' + request.runId,
        '-m',
        prompt,
      ];
      if (model) args.push('--model', model);

      const executed = await this.runner.run('nemoclaw', args, this.timeoutMs);
      const output = parseLifeInterviewResult(executed.stdout);
      const latencyMs = Date.now() - started;
      this.runs.markSucceeded(request.ownerId, request.runId, latencyMs, output);

      return {
        output,
        runtime: {
          runtime: 'nemoclaw-openclaw',
          skill: request.skill,
          ...(this.config.provider ? { provider: this.config.provider } : {}),
          ...(model ? { model } : {}),
          latencyMs,
        },
      };
    } catch (error) {
      const errorCode = error instanceof CommandExecutionError
        ? error.code
        : error instanceof Error ? error.message : 'AGENT_RUNTIME_UNKNOWN_ERROR';
      try {
        this.runs.markFailed(request.ownerId, request.runId, Date.now() - started, errorCode);
      } catch {
        // Keep the original runtime failure.
      }
      throw error;
    } finally {
      try {
        this.contexts.delete(request.runId);
      } catch {
        // Context cleanup must not mask the Agent result or runtime failure.
      }
    }
  }
}
