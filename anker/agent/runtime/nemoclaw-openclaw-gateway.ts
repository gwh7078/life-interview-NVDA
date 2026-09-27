import type { AgentRunStore } from '../tracing/agent-run-repository.js';
import type { AgentToolTokenService } from '../tools/token.js';
import { CommandExecutionError, ExecFileCommandRunner, type CommandRunner } from './command-runner.js';
import type { AgentGateway, AgentRunRequest, AgentRunResult } from './types.js';

export interface NemoClawOpenClawGatewayConfig {
  sandboxName: string;
  toolBaseUrl: string;
  model?: string | null;
  timeoutMs?: number;
}

function parseInspectorResult(stdout: string): { title: string; gap_count: number } {
  const line = stdout.split(/\r?\n/u).reverse().find((item) => item.trim().startsWith('LIFE_INTERVIEW_RESULT '));
  if (!line) throw new Error('AGENT_RESULT_MISSING');
  const raw = line.trim().slice('LIFE_INTERVIEW_RESULT '.length);
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AGENT_RESULT_INVALID');
  const result = value as Record<string, unknown>;
  if (typeof result.title !== 'string' || !Number.isSafeInteger(result.gap_count) || Number(result.gap_count) < 0) {
    throw new Error('AGENT_RESULT_INVALID');
  }
  return { title: result.title, gap_count: Number(result.gap_count) };
}

export class NemoClawOpenClawGateway implements AgentGateway {
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: NemoClawOpenClawGatewayConfig,
    private readonly tokens: AgentToolTokenService,
    private readonly runs: AgentRunStore,
    runner?: CommandRunner,
  ) {
    if (!config.sandboxName.trim()) throw new Error('NEMOCLAW_SANDBOX is required.');
    if (!/^https?:\/\//u.test(config.toolBaseUrl)) throw new Error('AGENT_TOOL_BASE_URL must be an HTTP(S) URL.');
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.runner = runner ?? new ExecFileCommandRunner();
  }

  async run<T = unknown>(request: AgentRunRequest): Promise<AgentRunResult<T>> {
    if (request.agentType !== 'story-context-inspector' || request.resourceType !== 'story') {
      throw new Error('UNSUPPORTED_PHASE1_AGENT_TASK');
    }

    this.runs.create({
      ...request,
      runtime: 'nemoclaw-openclaw',
      model: this.config.model ?? null,
    });
    const started = Date.now();

    try {
      this.runs.markRunning(request.userId, request.runId);
      const token = this.tokens.issue({
        runId: request.runId,
        userId: request.userId,
        tool: 'get_story_context',
        resourceType: 'story',
        resourceId: request.resourceId,
        ttlMs: this.timeoutMs + 30_000,
      });

      const prompt = [
        'Use the installed story-context-inspector skill.',
        'Call get_story_context for story_id ' + request.resourceId + '.',
        'Do not access files or databases for product data.',
        'Return exactly one final line:',
        'LIFE_INTERVIEW_RESULT {"title":"<story title>","gap_count":<integer>}',
      ].join(' ');

      // Use NemoClaw exec rather than raw docker exec. The scoped token is injected as an
      // in-sandbox process environment variable, so it does not need to appear in the model prompt.
      const args = [
        this.config.sandboxName,
        'exec',
        '--',
        'env',
        'LIFE_INTERVIEW_TOOL_BASE_URL=' + this.config.toolBaseUrl.replace(/\/$/u, ''),
        'LIFE_INTERVIEW_TOOL_TOKEN=' + token,
        'LIFE_INTERVIEW_RUN_ID=' + request.runId,
        'openclaw',
        'agent',
        '--local',
        '--agent',
        'main',
        '--session-key',
        'agent:main:phase1-smoke:' + request.runId,
        '-m',
        prompt,
      ];
      if (this.config.model) {
        args.push('--model', this.config.model);
      }

      const executed = await this.runner.run('nemoclaw', args, this.timeoutMs);
      const output = parseInspectorResult(executed.stdout);
      this.runs.markSucceeded(request.userId, request.runId, Date.now() - started, output);
      return { runId: request.runId, status: 'succeeded', output: output as T };
    } catch (error) {
      const errorCode = error instanceof CommandExecutionError
        ? error.code
        : error instanceof Error ? error.message : 'AGENT_RUNTIME_UNKNOWN_ERROR';
      try {
        this.runs.markFailed(request.userId, request.runId, Date.now() - started, errorCode);
      } catch {
        // Preserve the original runtime failure if persistence also fails.
      }
      throw error;
    }
  }
}
